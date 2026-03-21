import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { api } from '../services/api';
import { getPublicKey as getStoredPublicKey } from '../services/keyStore';
import ServerAddressInput from '../components/ServerAddressInput/ServerAddressInput';
import {
  normalizeServerUrl,
  useServerHealthCheck,
  uploadPrekeyBundle,
  activateTeamAndNavigate,
} from '../utils/serverConnection';
import PublicShell from './PublicShell';

export default function SetupAdmin() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { publicKey, derivedKey, addTeam, setPublicKey } = useAuthStore();

  const isBrowser = !(globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  const [serverAddress, setServerAddress] = useState(
    isBrowser ? globalThis.location.origin : '',
  );
  const [bootstrapToken, setBootstrapToken] = useState(
    searchParams.get('token') ?? '',
  );
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState(localStorage.getItem('dilla_username') ?? '');
  const [teamName, setTeamName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [serverStatus] = useServerHealthCheck(serverAddress, isBrowser ? 'online' : 'unknown');

  const handleSetup = async () => {
    setError('');
    if (!serverAddress || !bootstrapToken || !username) return;

    // Get public key from store or IndexedDB
    let pubKey: string;
    if (publicKey) {
      pubKey = publicKey;
    } else {
      const stored = await getStoredPublicKey();
      if (!stored) {
        setError('No identity found. Please create an identity first.');
        return;
      }
      pubKey = btoa(String.fromCodePoint(...stored));
      setPublicKey(pubKey);
    }

    setLoading(true);
    try {
      const normalizedUrl = normalizeServerUrl(serverAddress);
      const tempId = normalizedUrl;
      api.addTeam(tempId, normalizedUrl);

      const result = await api.bootstrap(
        tempId,
        username,
        displayName || username,
        pubKey,
        bootstrapToken,
        teamName || undefined,
      );

      // Extract real team ID from server response
      const realTeamId = (result.team?.id as string) || tempId;

      // Re-register with real team ID if different
      if (realTeamId === tempId) {
        api.setToken(tempId, result.token);
      } else {
        api.removeTeam(tempId);
        api.addTeam(realTeamId, normalizedUrl);
        api.setToken(realTeamId, result.token);
      }

      addTeam(realTeamId, result.token, result.user, result.team, normalizedUrl);

      // Upload prekey bundle for E2E encryption
      if (derivedKey) {
        await uploadPrekeyBundle(derivedKey, realTeamId);
      }

      await activateTeamAndNavigate(realTeamId, navigate);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <PublicShell>
      <h1>{t('setup.title')}</h1>
      <p style={{ opacity: 0.7, fontSize: '0.9rem', marginBottom: '0.5rem', textAlign: 'center' }}>
        First-time setup: create your team and admin account on this server.
      </p>
      {error && <p className="error">{error}</p>}
      <div className="form">
        {!isBrowser && (
          <ServerAddressInput
            placeholder={t('setup.serverAddress')}
            value={serverAddress}
            onChange={setServerAddress}
            serverStatus={serverStatus}
          />
        )}
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
    </PublicShell>
  );
}
