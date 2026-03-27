import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { decodeRecoveryKey, authenticatePasskey, prfOutputToBase64 } from '../services/webauthn';
import { initCrypto } from '../services/crypto';
import {
  unlockWithPrf,
  unlockWithRecovery,
  unlockWithPassphrase,
  getCredentialInfo,
  getPublicKey,
  deleteIdentity,
  type KeySlot,
} from '../services/keyStore';
import { fromBase64, toBase64 } from '../services/cryptoCore';
import { usernameColor, getInitials } from '../utils/colors';
import {
  refreshServerTokens as doRefreshServerTokens,
  tryReconnectToCurrentServer as doTryReconnect,
} from '../services/authReconnect';
import PublicShell from './PublicShell';

type Mode = 'passkey' | 'recovery' | 'legacy';

interface IdentityInfo {
  username: string;
  fingerprint: string;
  servers: string[];
  credentialCount: number;
  createdAt: string | null;
}

async function tryReconnectToCurrentServer(pubKey: string): Promise<boolean> {
  return doTryReconnect(pubKey);
}

export default function Login() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { setDerivedKey, setPublicKey, teams } = useAuthStore();

  const [mode, setMode] = useState<Mode>('passkey');
  const [recoveryKeyInput, setRecoveryKeyInput] = useState('');
  const [legacyPassphrase, setLegacyPassphrase] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [keyVersion, setKeyVersion] = useState<number>(2);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [identityInfo, setIdentityInfo] = useState<IdentityInfo | null>(null);
  const [needsLoginPassphrase, setNeedsLoginPassphrase] = useState(false);
  const [loginPassphrase, setLoginPassphrase] = useState('');

  // Delegate to extracted service functions (fully unit-tested in authReconnect.test.ts)
  async function refreshServerTokens(pubKey: string) {
    await doRefreshServerTokens(teams, pubKey);
  }

  // Load identity info from IndexedDB on mount
  useEffect(() => {
    (async () => {
      try {
        const info = await getCredentialInfo();
        if (!info) {
          setKeyVersion(0);
          return;
        }
        setKeyVersion(3);

        const pubKeyBytes = await getPublicKey();
        const fingerprint = pubKeyBytes
          ? Array.from(pubKeyBytes).map(b => b.toString(16).padStart(2, '0')).join('')
          : '';

        const servers = [...new Set(info.keySlots.map((s: KeySlot) => s.server_url).filter(Boolean))];
        const allCreds = info.keySlots.flatMap((s: KeySlot) => s.credentials);
        const earliest = allCreds
          .map(c => c.created_at)
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b))[0] || null;

        setIdentityInfo({
          username: localStorage.getItem('dilla_username') ?? '',
          fingerprint,
          servers,
          credentialCount: info.credentials.length,
          createdAt: earliest,
        });
      } catch {
        // No key file
      }
    })();
  }, []);

  // Countdown timer while loading
  useEffect(() => {
    if (!loading) { setCountdown(0); return; }
    setCountdown(30);
    const timer = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { clearInterval(timer); return 0; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [loading]);

  const [cancelRef] = useState<{ cancelled: boolean }>({ cancelled: false });

  /** Discover credentials and authenticate via passkey + PRF. */
  async function discoverAndAuthenticatePasskey() {
    const info = await getCredentialInfo();
    if (!info || info.credentials.length === 0) {
      throw new Error('No passkeys found. Please create an identity first.');
    }

    let serverUrl = localStorage.getItem('dilla_auth_server') || '';
    if (!serverUrl) {
      for (const [, entry] of teams) {
        const url = entry.baseUrl;
        if (url) { serverUrl = url; break; }
      }
    }

    const credentialIds = info.credentials.map(c => c.id);
    return authenticatePasskey(credentialIds, info.prfSalt, serverUrl || undefined);
  }

  /** Unlock identity from PRF output, init crypto, and navigate. */
  async function unlockAndNavigate(derivedKeyB64: string) {
    const prfKey = fromBase64(derivedKeyB64);
    const identity = await unlockWithPrf(prfKey);
    await initCrypto(identity, derivedKeyB64);

    const pubKeyB64 = btoa(String.fromCodePoint(...identity.publicKeyBytes));
    console.log('[Login] Identity unlocked, refreshing server tokens...');

    setDerivedKey(derivedKeyB64);
    setPublicKey(pubKeyB64);
    await refreshServerTokens(pubKeyB64);
    if (cancelRef.cancelled) return;
    const hasTeams = useAuthStore.getState().teams.size > 0
      || await tryReconnectToCurrentServer(pubKeyB64);
    if (cancelRef.cancelled) return;
    navigate(hasTeams ? '/app' : '/join');
  }

  const handlePasskeyUnlock = async () => {
    setError('');
    setLoading(true);
    cancelRef.cancelled = false;
    try {
      console.log('[Login] Starting passkey login...');

      const result = await discoverAndAuthenticatePasskey();
      if (cancelRef.cancelled) return;

      if (result.prfOutput === null) {
        setNeedsLoginPassphrase(true);
        setLoading(false);
        return;
      }

      const derivedKeyB64 = prfOutputToBase64(result.prfOutput);
      console.log('[Login] Passkey succeeded, unlocking identity...');
      await unlockAndNavigate(derivedKeyB64);
    } catch (e) {
      if (cancelRef.cancelled) return;
      console.error('[Login] Passkey unlock failed:', e);
      const errMsg = String(e);
      setError(errMsg);
      if (!errMsg.includes('No passkeys found') && !errMsg.includes('cancelled')) {
        setMode('recovery');
      }
    } finally {
      if (!cancelRef.cancelled) setLoading(false);
    }
  };

  const handleCancel = () => {
    cancelRef.cancelled = true;
    setLoading(false);
    setError('');
  };

  const handleRecoveryUnlock = async () => {
    setError('');
    if (!recoveryKeyInput.trim()) return;

    setLoading(true);
    try {
      const recoveryBytes = decodeRecoveryKey(recoveryKeyInput.trim());
      const identity = await unlockWithRecovery(recoveryBytes);
      const recoveryKeyB64 = toBase64(recoveryBytes);

      await initCrypto(identity, recoveryKeyB64);

      const pubKeyB64 = btoa(String.fromCodePoint(...identity.publicKeyBytes));

      setDerivedKey(recoveryKeyB64);
      setPublicKey(pubKeyB64);
      await refreshServerTokens(pubKeyB64);
      const hasTeams = useAuthStore.getState().teams.size > 0
        || await tryReconnectToCurrentServer(pubKeyB64);
      navigate(hasTeams ? '/app' : '/join');
    } catch {
      setError(t('login.invalidRecoveryKey'));
    } finally {
      setLoading(false);
    }
  };

  /* v8 ignore start -- Legacy mode unreachable in current UI flow */
  const handleLegacyUnlock = async () => {
    setError('');
    if (!legacyPassphrase) return;
    setError('Legacy passphrase unlock is not supported. Please use your recovery key.');
    setMode('recovery');
  };
  /* v8 ignore stop */

  const handlePassphraseUnlock = async () => {
    setError('');
    if (!loginPassphrase) return;

    setLoading(true);
    try {
      const identity = await unlockWithPassphrase(loginPassphrase);
      // Use a stable derived key for session — hash the passphrase for this
      const passphraseKeyB64 = btoa(String.fromCodePoint(...new TextEncoder().encode(loginPassphrase.slice(0, 32))));

      await initCrypto(identity, passphraseKeyB64);

      const pubKeyB64 = btoa(String.fromCodePoint(...identity.publicKeyBytes));
      setDerivedKey(passphraseKeyB64);
      setPublicKey(pubKeyB64);
      await refreshServerTokens(pubKeyB64);
      const hasTeams = useAuthStore.getState().teams.size > 0
        || await tryReconnectToCurrentServer(pubKeyB64);
      navigate(hasTeams ? '/app' : '/join');
    } catch {
      setError(t('login.wrongPassphrase'));
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteIdentity = async () => {
    await deleteIdentity();
    useAuthStore.getState().logout();
    localStorage.removeItem('dilla_auth_server');
    localStorage.removeItem('dilla_username');
    navigate('/create-identity');
  };

  let passkeyButtonLabel = t('login.unlockWithPasskey');
  if (loading && countdown > 0) {
    passkeyButtonLabel = `${t('login.openingBrowser', 'Waiting for browser...')} (${countdown}s)`;
  } else if (loading) {
    passkeyButtonLabel = t('login.openingBrowser', 'Waiting for browser...');
  }

  return (
    <PublicShell>
      <h1>{t('login.title')}</h1>

      {identityInfo && (
        <div className="login-identity-card">
          <div
            className="login-identity-avatar"
            style={{ background: usernameColor(identityInfo.username || identityInfo.fingerprint) }}
          >
            {getInitials(identityInfo.username || '?')}
          </div>
          <div className="login-identity-info">
            {identityInfo.username && (
              <div className="login-identity-name">{identityInfo.username}</div>
            )}
            <div className="login-identity-fingerprint">{identityInfo.fingerprint}</div>
            {identityInfo.servers.length > 0 && (
              <div className="login-identity-servers">
                {identityInfo.servers.map(s => new URL(s).hostname).join(', ')}
              </div>
            )}
          </div>
        </div>
      )}

      {error && <p className="error">{error}</p>}

      {needsLoginPassphrase && (
        <div className="form">
          <p style={{ opacity: 0.8, fontSize: '0.9rem' }}>
            {t(
              'login.passphraseNeeded',
              'Your passkey was verified. Enter your passphrase to decrypt your identity.',
            )}
          </p>
          <input
            type="password"
            placeholder={t('login.passphrase')}
            value={loginPassphrase}
            onChange={(e) => setLoginPassphrase(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handlePassphraseUnlock()}
            autoFocus
          />
          <button
            className="btn-primary"
            onClick={handlePassphraseUnlock}
            disabled={loading || !loginPassphrase}
          >
            {loading ? t('login.unlocking') : t('login.unlock')}
          </button>
          <button className="btn-link" onClick={() => { setNeedsLoginPassphrase(false); setMode('recovery'); }}>
            {t('login.useRecoveryKey')}
          </button>
        </div>
      )}

      {!needsLoginPassphrase && mode === 'passkey' && keyVersion >= 2 && (
        <div className="form">
          <button className="btn-primary" onClick={handlePasskeyUnlock} disabled={loading}>
            {passkeyButtonLabel}
          </button>
          {loading && (
            <button className="btn-secondary" onClick={handleCancel} style={{ marginTop: 8 }}>
              {t('login.cancel', 'Cancel')}
            </button>
          )}
          {!loading && (
            <button className="btn-secondary" onClick={() => setMode('recovery')}>
              {t('login.useRecoveryKey')}
            </button>
          )}
        </div>
      )}

      {mode === 'recovery' && (
        <div className="form">
          <input
            type="text"
            placeholder={t('login.recoveryKeyPlaceholder')}
            value={recoveryKeyInput}
            onChange={(e) => setRecoveryKeyInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleRecoveryUnlock()}
            style={{ fontFamily: 'monospace', letterSpacing: '0.05em' }}
          />
          <button className="btn-primary" onClick={handleRecoveryUnlock} disabled={loading || !recoveryKeyInput.trim()}>
            {loading ? t('login.unlocking') : t('login.unlockWithRecovery')}
          </button>
          <button className="btn-link" onClick={() => setMode(keyVersion >= 2 ? 'passkey' : 'legacy')}>
            ← {t('common.back', 'Back')}
          </button>
        </div>
      )}

      {/* v8 ignore start -- Legacy mode unreachable in current UI flow */}
      {mode === 'legacy' && (
        <div className="form">
          <p style={{ opacity: 0.7, fontSize: '0.9rem' }}>{t('login.legacyDetected')}</p>
          <input
            type="password"
            placeholder={t('login.passphrase')}
            value={legacyPassphrase}
            onChange={(e) => setLegacyPassphrase(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleLegacyUnlock()}
          />
          <button className="btn-primary" onClick={handleLegacyUnlock} disabled={loading || !legacyPassphrase}>
            {loading ? t('login.unlocking') : t('login.unlock')}
          </button>
        </div>
      )}
      {/* v8 ignore stop */}

      <div style={{ marginTop: '1.5rem', textAlign: 'center' }}>
        <button className="btn-link" onClick={() => navigate('/recover')}>
          {t('login.recoverFromServer', 'Recover identity from server')}
        </button>
      </div>

      <details style={{ marginTop: '1rem', textAlign: 'center' }}>
        <summary className="btn-link" style={{ cursor: 'pointer', color: 'var(--text-danger)', listStyle: 'none', display: 'inline' }}>
          {t('login.deleteIdentity', 'Delete identity')}
        </summary>
        <div style={{ marginTop: 8 }}>
          <p style={{ fontSize: '0.9rem', marginBottom: 8 }}>
            {t('login.confirmDelete', 'Are you sure? This will permanently delete your local identity.')}
          </p>
          {confirmDelete ? (
            <div>
              <button className="btn-danger" onClick={handleDeleteIdentity} style={{ marginRight: 8 }}>
                {t('login.yesDelete', 'Yes, delete')}
              </button>
              <button className="btn-secondary" onClick={() => setConfirmDelete(false)}>
                {t('common.cancel', 'Cancel')}
              </button>
            </div>
          ) : (
            <button className="btn-danger" onClick={() => setConfirmDelete(true)}>
              {t('login.deleteIdentity', 'Delete identity')}
            </button>
          )}
        </div>
      </details>
    </PublicShell>
  );
}
