import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CloudCheck, CloudXmark, CloudSync } from 'iconoir-react';
import { useAuthStore } from '../stores/authStore';
import { api } from '../services/api';
import { cryptoService } from '../services/crypto';

export default function SetupAdmin() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { publicKey, derivedKey, addTeam } = useAuthStore();

  const [serverAddress, setServerAddress] = useState('');
  const [bootstrapToken, setBootstrapToken] = useState(
    searchParams.get('token') ?? '',
  );
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [teamName, setTeamName] = useState('');
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
      const url = address.startsWith('http')
        ? address.replace(/\/$/, '')
        : `https://${address}`;
      const res = await fetch(`${url}/api/v1/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        setServerStatus('online');
      } else {
        setServerStatus('offline');
      }
    } catch {
      setServerStatus('offline');
    }
  }, []);

  // Check server health when address changes (debounced)
  useEffect(() => {
    const timer = setTimeout(() => checkServer(serverAddress), 500);
    return () => clearTimeout(timer);
  }, [serverAddress, checkServer]);

  const handleSetup = async () => {
    setError('');
    if (!serverAddress || !bootstrapToken || !username || !publicKey) return;

    setLoading(true);
    try {
      // Normalize server address to full URL
      const normalizedUrl = serverAddress.startsWith('http')
        ? serverAddress.replace(/\/$/, '')
        : `https://${serverAddress}`;
      const tempId = normalizedUrl;
      api.addTeam(tempId, normalizedUrl);

      const result = await api.bootstrap(
        tempId,
        username,
        displayName || username,
        publicKey,
        bootstrapToken,
        teamName || undefined,
      );

      // Extract real team ID from server response
      const team = result.team as { id?: string } | null;
      const realTeamId = team?.id || tempId;

      // Re-register with real team ID if different
      if (realTeamId !== tempId) {
        api.removeTeam(tempId);
        api.addTeam(realTeamId, normalizedUrl);
        api.setToken(realTeamId, result.token);
      } else {
        api.setToken(tempId, result.token);
      }

      addTeam(realTeamId, result.token, result.user, result.team, normalizedUrl);

      // Upload prekey bundle for E2E encryption
      if (derivedKey) {
        try {
          const bundle = await cryptoService.generatePrekeyBundle(derivedKey);
          const toB64 = (arr: number[]) => btoa(String.fromCharCode(...arr));
          await api.uploadPrekeyBundle(realTeamId, {
            identity_key: toB64(bundle.identity_key),
            signed_prekey: toB64(bundle.signed_prekey),
            signed_prekey_signature: toB64(bundle.signed_prekey_signature),
            one_time_prekeys: bundle.one_time_prekeys.map(toB64),
          });
        } catch (e) {
          console.warn('Prekey upload failed:', e);
        }
      }

      // Set active team so AppLayout loads data
      const { useTeamStore } = await import('../stores/teamStore');
      useTeamStore.getState().setActiveTeam(realTeamId);

      navigate('/app');
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page setup-admin-page" data-tauri-drag-region>
      <img src="/logo.png" alt="Slimcord" style={{ width: 64, height: 64, marginBottom: 8 }} />
      <h1>{t('setup.title')}</h1>
      {error && <p className="error">{error}</p>}
      <div className="form">
        <div style={{ position: 'relative' }}>
          <input
            type="text"
            placeholder={t('setup.serverAddress')}
            value={serverAddress}
            onChange={(e) => setServerAddress(e.target.value)}
            style={{ paddingRight: '2.5rem' }}
          />
          {serverStatus === 'online' && (
            <CloudCheck style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', color: '#4ade80', width: 18, height: 18 }} />
          )}
          {serverStatus === 'offline' && (
            <CloudXmark style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', color: '#f87171', width: 18, height: 18 }} />
          )}
          {serverStatus === 'checking' && (
            <CloudSync style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', color: '#facc15', width: 18, height: 18, animation: 'spin 1s linear infinite' }} />
          )}
        </div>
        <input
          type="text"
          placeholder={t('setup.bootstrapToken')}
          value={bootstrapToken}
          onChange={(e) => setBootstrapToken(e.target.value)}
        />
        <input
          type="text"
          placeholder={t('setup.teamName', 'Team Name')}
          value={teamName}
          onChange={(e) => setTeamName(e.target.value)}
        />
        <input
          type="text"
          placeholder={t('identity.username', 'Username')}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          type="text"
          placeholder={t('identity.displayName', 'Display Name')}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <button className="btn-primary" onClick={handleSetup} disabled={loading || !serverAddress.trim() || !bootstrapToken.trim() || !username.trim() || !teamName.trim() || serverStatus !== 'online'}>
          {loading ? t('setup.settingUp') : t('setup.setup')}
        </button>
        <button className="btn-link" onClick={() => navigate(-1)}>
          ← Back
        </button>
      </div>
    </div>
  );
}
