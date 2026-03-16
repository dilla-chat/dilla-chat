import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { CloudCheck, CloudXmark, CloudSync } from 'iconoir-react';
import { useAuthStore } from '../stores/authStore';
import { api } from '../services/api';
import { decodeRecoveryKey } from '../services/webauthn';
import { initCrypto } from '../services/crypto';
import {
  importIdentityBlob,
  unlockWithRecovery,
  signChallenge,
} from '../services/keyStore';
import { toBase64, fromBase64 } from '../services/cryptoCore';
import PublicShell from './PublicShell';

export default function RecoverFromServer() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { setDerivedKey, setPublicKey, addTeam } = useAuthStore();

  const [serverAddress, setServerAddress] = useState('');
  const [username, setUsername] = useState('');
  const [recoveryKeyInput, setRecoveryKeyInput] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [serverStatus, setServerStatus] = useState<'unknown' | 'checking' | 'online' | 'offline'>('unknown');

  const checkServer = useCallback(async (address: string) => {
    if (!address.trim()) {
      setServerStatus('unknown');
      return;
    }
    setServerStatus('checking');
    try {
      let url = address.trim().replace(/\/$/, '');
      if (!/^https?:\/\//i.test(url)) {
        url = `https://${url}`;
      }
      const resp = await fetch(`${url}/api/v1/health`);
      setServerStatus(resp.ok ? 'online' : 'offline');
    } catch {
      setServerStatus('offline');
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => checkServer(serverAddress), 500);
    return () => clearTimeout(timer);
  }, [serverAddress, checkServer]);

  const handleRecover = async () => {
    setError('');
    if (!serverAddress || !username || !recoveryKeyInput) return;
    setLoading(true);

    try {
      const recoveryBytes = decodeRecoveryKey(recoveryKeyInput.trim());
      const recoveryKeyB64 = toBase64(recoveryBytes);

      let normalizedUrl = serverAddress.trim().replace(/\/$/, '');
      if (!/^https?:\/\//i.test(normalizedUrl)) {
        normalizedUrl = `https://${normalizedUrl}`;
      }

      // Fetch identity blob from server
      const blobResp = await fetch(`${normalizedUrl}/api/v1/identity/blob?username=${encodeURIComponent(username)}`);
      if (!blobResp.ok) throw new Error('Failed to fetch identity blob from server');
      const { blob } = await blobResp.json();

      // Import the blob into IndexedDB
      await importIdentityBlob(blob);

      // Unlock with recovery key
      const identity = await unlockWithRecovery(recoveryBytes);
      await initCrypto(identity, recoveryKeyB64);

      const pubKeyB64 = btoa(String.fromCharCode(...identity.publicKeyBytes));

      setPublicKey(pubKeyB64);
      setDerivedKey(recoveryKeyB64);
      localStorage.setItem('dilla_username', username);

      // Authenticate with the server to get a JWT
      const tempId = 'recovery-temp';
      api.addTeam(tempId, normalizedUrl);

      const challenge = await api.requestChallenge(tempId, pubKeyB64);
      const nonceBytes = fromBase64(challenge.nonce);
      const sigBytes = await signChallenge(identity.signingKey, nonceBytes);
      const signature = toBase64(sigBytes);
      const verified = await api.verifyChallenge(tempId, challenge.challenge_id, pubKeyB64, signature);

      api.removeTeam(tempId);
      const teamId = (verified as Record<string, unknown>).team_id as string || tempId;
      api.addTeam(teamId, normalizedUrl);
      api.setToken(teamId, verified.token);
      addTeam(teamId, verified.token, verified.user, null, normalizedUrl);

      const { useTeamStore } = await import('../stores/teamStore');
      useTeamStore.getState().setActiveTeam(teamId);

      navigate('/app');
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <PublicShell>
      <h1>{t('recover.title', 'Recover Identity')}</h1>
      <p style={{ opacity: 0.7, textAlign: 'center', marginBottom: '0.5rem' }}>
        {t('recover.subtitle', 'Restore your identity from a server using your recovery key.')}
      </p>

      {error && <p className="error">{error}</p>}

      <div className="form">
        <div style={{ position: 'relative' }}>
          <input
            type="text"
            placeholder={t('join.serverAddress', 'Server address (e.g. http://localhost:8080)')}
            value={serverAddress}
            onChange={(e) => setServerAddress(e.target.value)}
            style={{ paddingRight: '2.5rem' }}
          />
          {serverStatus === 'online' && (
            <CloudCheck style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-positive)', width: 18, height: 18 }} />
          )}
          {serverStatus === 'offline' && (
            <CloudXmark style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-danger)', width: 18, height: 18 }} />
          )}
          {serverStatus === 'checking' && (
            <CloudSync style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-warning)', width: 18, height: 18, animation: 'spin 1s linear infinite' }} />
          )}
        </div>

        <input
          type="text"
          placeholder={t('recover.username', 'Username')}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />

        <textarea
          placeholder={t('recover.recoveryKey', 'Recovery key (e.g. XXXX-XXXX-XXXX-...)')}
          value={recoveryKeyInput}
          onChange={(e) => setRecoveryKeyInput(e.target.value)}
          rows={3}
          style={{ fontFamily: 'monospace', fontSize: 14 }}
        />

        <button
          className="btn-primary"
          onClick={handleRecover}
          disabled={loading || serverStatus !== 'online' || !username || !recoveryKeyInput}
        >
          {loading ? t('recover.recovering', 'Recovering...') : t('recover.submit', 'Recover Identity')}
        </button>

        <button className="btn-link" onClick={() => navigate(-1)}>
          ← {t('common.back', 'Back')}
        </button>
      </div>
    </PublicShell>
  );
}
