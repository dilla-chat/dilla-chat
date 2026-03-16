import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { decodeRecoveryKey, authenticatePasskey, prfOutputToBase64 } from '../services/webauthn';
import { api } from '../services/api';
import { initCrypto, getIdentityKeys } from '../services/crypto';
import {
  unlockWithPrf,
  unlockWithRecovery,
  unlockWithPassphrase,
  getCredentialInfo,
  getPublicKey,
  exportIdentityBlob,
  signChallenge,
  deleteIdentity,
  type KeySlot,
} from '../services/keyStore';
import { fromBase64, toBase64 } from '../services/cryptoCore';
import { usernameColor, getInitials } from '../utils/colors';
import PublicShell from './PublicShell';

type Mode = 'passkey' | 'recovery' | 'legacy';

interface IdentityInfo {
  username: string;
  fingerprint: string;
  servers: string[];
  credentialCount: number;
  createdAt: string | null;
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

  // Re-authenticate with all persisted servers to get fresh JWT tokens
  async function refreshServerTokens(pubKey: string, _derivedKeyB64: string) {
    const keys = getIdentityKeys();
    console.log(`[Login] refreshServerTokens: ${teams.size} teams to re-auth`);
    for (const [teamId, entry] of teams) {
      const baseUrl = (entry as { baseUrl?: string }).baseUrl;
      if (!baseUrl) {
        console.log(`[Login] Skipping team ${teamId} — no baseUrl`);
        continue;
      }
      try {
        console.log(`[Login] Re-auth team ${teamId} at ${baseUrl}`);
        api.addTeam(teamId, baseUrl);
        const { challenge_id, nonce } = await api.requestChallenge(teamId, pubKey);
        const nonceBytes = fromBase64(nonce);
        const sigBytes = await signChallenge(keys.signingKey, nonceBytes);
        const signature = toBase64(sigBytes);
        const result = await api.verifyChallenge(teamId, challenge_id, pubKey, signature);
        api.setToken(teamId, result.token);
        const { addTeam: updateTeam } = useAuthStore.getState();
        updateTeam(teamId, result.token, entry.user, entry.teamInfo, baseUrl);
        console.log(`[Login] Re-auth succeeded for team ${teamId}`);
      } catch (e) {
        console.warn(`[Login] Re-auth failed for team ${teamId}, removing stale team:`, e);
        const { removeTeam } = useAuthStore.getState();
        removeTeam(teamId);
        api.removeTeam(teamId);
      }
    }

    // Upload identity blob to all servers for cross-device recovery
    const blob = await exportIdentityBlob();
    if (!blob) return;
    const allServers: string[] = [];
    for (const [, entry] of teams) {
      const url = (entry as { baseUrl?: string }).baseUrl;
      if (url) allServers.push(url);
    }
    for (const [teamId, entry] of teams) {
      const baseUrl = (entry as { baseUrl?: string }).baseUrl;
      const token = (entry as { token?: string }).token;
      if (!baseUrl || !token) continue;
      try {
        const freshEntry = useAuthStore.getState().teams.get(teamId) as { token?: string } | undefined;
        const jwt = freshEntry?.token || token;
        await fetch(`${baseUrl}/api/v1/identity/blob`, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ blob, servers: allServers }),
        });
        console.log(`[Login] Identity blob uploaded to ${baseUrl}`);
      } catch (e) {
        console.warn(`[Login] Blob upload to ${baseUrl} failed:`, e);
      }
    }
  }

  async function tryReconnectToCurrentServer(pubKey: string): Promise<boolean> {
    const baseUrl = window.location.origin;
    const keys = getIdentityKeys();
    const tempId = '__reconnect__';

    console.log('[Login] Attempting auto-reconnect to', baseUrl);
    try {
      api.addTeam(tempId, baseUrl);

      const { challenge_id, nonce } = await api.requestChallenge(tempId, pubKey);
      const nonceBytes = fromBase64(nonce);
      const sigBytes = await signChallenge(keys.signingKey, nonceBytes);
      const signature = toBase64(sigBytes);
      const result = await api.verifyChallenge(tempId, challenge_id, pubKey, signature);

      // Use JWT to discover teams on this server
      const serverTeams = await api.listTeams(baseUrl, result.token);
      api.removeTeam(tempId);

      if (!serverTeams || serverTeams.length === 0) return false;

      const { addTeam: storeAddTeam } = useAuthStore.getState();
      for (const team of serverTeams) {
        const t = team as { id?: string };
        if (!t.id) continue;
        api.addTeam(t.id, baseUrl);
        api.setToken(t.id, result.token);
        storeAddTeam(t.id, result.token, result.user, team, baseUrl);
      }

      return useAuthStore.getState().teams.size > 0;
    } catch (e) {
      console.log('[Login] Auto-reconnect failed:', e);
      api.removeTeam(tempId);
      return false;
    }
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
          ? Array.from(pubKeyBytes.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('')
          : '';

        const servers = [...new Set(info.keySlots.map((s: KeySlot) => s.server_url).filter(Boolean))];
        const allCreds = info.keySlots.flatMap((s: KeySlot) => s.credentials);
        const earliest = allCreds
          .map(c => c.created_at)
          .filter(Boolean)
          .sort()[0] || null;

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

  const handlePasskeyUnlock = async () => {
    setError('');
    setLoading(true);
    cancelRef.cancelled = false;
    try {
      console.log('[Login] Starting passkey login...');

      // Get credential info from IndexedDB
      const info = await getCredentialInfo();
      if (!info || info.credentials.length === 0) {
        throw new Error('No passkeys found. Please create an identity first.');
      }

      // Determine server URL for rpId config
      let serverUrl = localStorage.getItem('dilla_auth_server') || '';
      if (!serverUrl) {
        for (const [, entry] of teams) {
          const url = (entry as { baseUrl?: string }).baseUrl;
          if (url) { serverUrl = url; break; }
        }
      }

      // Authenticate with passkey + PRF
      const credentialIds = info.credentials.map(c => c.id);
      const result = await authenticatePasskey(credentialIds, info.prfSalt, serverUrl || undefined);

      if (cancelRef.cancelled) return;

      if (result.prfOutput === null) {
        // PRF not available — need passphrase to decrypt
        setNeedsLoginPassphrase(true);
        setLoading(false);
        return;
      }

      const derivedKeyB64 = prfOutputToBase64(result.prfOutput);

      console.log('[Login] Passkey succeeded, unlocking identity...');

      // Unlock identity from IndexedDB
      const prfKey = fromBase64(derivedKeyB64);
      const identity = await unlockWithPrf(prfKey);

      // Initialize crypto service
      await initCrypto(identity, derivedKeyB64);

      const pubKeyB64 = btoa(String.fromCharCode(...identity.publicKeyBytes));
      console.log('[Login] Identity unlocked, refreshing server tokens...');

      setDerivedKey(derivedKeyB64);
      setPublicKey(pubKeyB64);
      await refreshServerTokens(pubKeyB64, derivedKeyB64);
      if (cancelRef.cancelled) return;
      let hasTeams = useAuthStore.getState().teams.size > 0;
      if (!hasTeams) {
        hasTeams = await tryReconnectToCurrentServer(pubKeyB64);
        if (cancelRef.cancelled) return;
      }
      navigate(hasTeams ? '/app' : '/join');
    } catch (e) {
      if (cancelRef.cancelled) return;
      console.error('[Login] Passkey unlock failed:', e);
      const errMsg = String(e);
      if (errMsg.includes('No passkeys found') || errMsg.includes('cancelled')) {
        setError(errMsg);
      } else {
        setError(errMsg);
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

      const pubKeyB64 = btoa(String.fromCharCode(...identity.publicKeyBytes));

      setDerivedKey(recoveryKeyB64);
      setPublicKey(pubKeyB64);
      await refreshServerTokens(pubKeyB64, recoveryKeyB64);
      let hasTeams = useAuthStore.getState().teams.size > 0;
      if (!hasTeams) {
        hasTeams = await tryReconnectToCurrentServer(pubKeyB64);
      }
      navigate(hasTeams ? '/app' : '/join');
    } catch {
      setError(t('login.invalidRecoveryKey'));
    } finally {
      setLoading(false);
    }
  };

  const handleLegacyUnlock = async () => {
    setError('');
    if (!legacyPassphrase) return;
    // Legacy passphrase unlock is not supported in pure JS mode
    setError('Legacy passphrase unlock is not supported. Please use your recovery key.');
    setMode('recovery');
  };

  const handlePassphraseUnlock = async () => {
    setError('');
    if (!loginPassphrase) return;

    setLoading(true);
    try {
      const identity = await unlockWithPassphrase(loginPassphrase);
      // Use a stable derived key for session — hash the passphrase for this
      const passphraseKeyB64 = btoa(String.fromCharCode(...new TextEncoder().encode(loginPassphrase.slice(0, 32))));

      await initCrypto(identity, passphraseKeyB64);

      const pubKeyB64 = btoa(String.fromCharCode(...identity.publicKeyBytes));
      setDerivedKey(passphraseKeyB64);
      setPublicKey(pubKeyB64);
      await refreshServerTokens(pubKeyB64, passphraseKeyB64);
      let hasTeams = useAuthStore.getState().teams.size > 0;
      if (!hasTeams) {
        hasTeams = await tryReconnectToCurrentServer(pubKeyB64);
      }
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
            <div className="login-identity-fingerprint">{identityInfo.fingerprint}...</div>
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
            {loading
              ? `${t('login.openingBrowser', 'Waiting for browser...')}${countdown > 0 ? ` (${countdown}s)` : ''}`
              : t('login.unlockWithPasskey')}
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
          {!confirmDelete ? (
            <button className="btn-danger" onClick={() => setConfirmDelete(true)}>
              {t('login.deleteIdentity', 'Delete identity')}
            </button>
          ) : (
            <div>
              <button className="btn-danger" onClick={handleDeleteIdentity} style={{ marginRight: 8 }}>
                {t('login.yesDelete', 'Yes, delete')}
              </button>
              <button className="btn-secondary" onClick={() => setConfirmDelete(false)}>
                {t('common.cancel', 'Cancel')}
              </button>
            </div>
          )}
        </div>
      </details>
    </PublicShell>
  );
}
