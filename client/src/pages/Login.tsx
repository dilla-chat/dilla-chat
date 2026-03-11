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
  getCredentialInfo,
  hasIdentity,
  exportIdentityBlob,
  signChallenge,
} from '../services/keyStore';
import { fromBase64, toBase64, ed25519Sign } from '../services/cryptoCore';

type Mode = 'passkey' | 'recovery' | 'legacy';

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

  // Re-authenticate with all persisted servers to get fresh JWT tokens
  async function refreshServerTokens(pubKey: string, derivedKeyB64: string) {
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

  // Detect key version on mount
  useEffect(() => {
    (async () => {
      try {
        const info = await getCredentialInfo();
        if (!info) {
          setKeyVersion(0);
          return;
        }
        // V3 MEK format = version 3
        setKeyVersion(3);
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
      let serverUrl = localStorage.getItem('slimcord_auth_server') || '';
      if (!serverUrl) {
        for (const [, entry] of teams) {
          const url = (entry as { baseUrl?: string }).baseUrl;
          if (url) { serverUrl = url; break; }
        }
      }

      // Authenticate with passkey + PRF
      const credentialIds = info.credentials.map(c => c.id);
      const result = await authenticatePasskey(credentialIds, info.prfSalt, serverUrl || undefined);
      const derivedKeyB64 = prfOutputToBase64(result.prfOutput);

      if (cancelRef.cancelled) return;
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
      const hasTeams = useAuthStore.getState().teams.size > 0;
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
      const hasTeams = useAuthStore.getState().teams.size > 0;
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

  return (
    <div className="page login-page" data-tauri-drag-region>
      <img src="/logo.png" alt="Slimcord" style={{ width: 64, height: 64, marginBottom: 8 }} />
      <h1>{t('login.title')}</h1>
      {error && <p className="error">{error}</p>}

      {mode === 'passkey' && keyVersion >= 2 && (
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

      <div style={{ marginTop: '2rem', textAlign: 'center' }}>
        <button className="btn-link" onClick={() => navigate('/recover')}>
          {t('login.recoverFromServer', 'Recover identity from server')}
        </button>
      </div>
    </div>
  );
}
