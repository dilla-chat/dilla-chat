import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { api } from '../services/api';
import { hasIdentity, getPublicKey as getStoredPublicKey } from '../services/keyStore';
import { fromBase64, generateEd25519KeyPair, ed25519Sign } from '../services/cryptoCore';
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
  const [fingerprint, setFingerprint] = useState('');
  const [serverStatus] = useServerHealthCheck(serverAddress, isBrowser ? 'online' : 'unknown');

  // Redirect to create-identity if no identity exists yet,
  // preserving the current URL so we come back after identity creation.
  useEffect(() => {
    hasIdentity().then((exists) => {
      if (!exists) {
        const returnUrl = window.location.pathname + window.location.search;
        navigate(`/create-identity?returnTo=${encodeURIComponent(returnUrl)}`);
      }
    });
    // Load fingerprint from stored public key
    getStoredPublicKey().then((pk) => {
      if (pk) {
        const hex = Array.from(pk).map(b => b.toString(16).padStart(2, '0')).join('');
        setFingerprint(hex.slice(0, 16) + '...');
      }
    });
  }, [navigate]);

  const handleSetup = async () => {
    setError('');
    if (!serverAddress || !bootstrapToken || !username) return;

    setLoading(true);
    try {
      // Generate a fresh Ed25519 keypair for the challenge-response.
      // The identity created at /create-identity is for E2E encryption
      // (stored encrypted in IndexedDB). For auth registration the server
      // just needs a valid Ed25519 public key to associate with the account.
      const kp = await generateEd25519KeyPair();
      const signingKey = kp.privateKey;
      const pubKey = btoa(String.fromCodePoint(...kp.publicKeyBytes));
      setPublicKey(pubKey);

      const normalizedUrl = normalizeServerUrl(serverAddress);
      const tempId = normalizedUrl;
      api.addTeam(tempId, normalizedUrl);

      // Challenge-response: request challenge, sign it, then bootstrap
      const { challenge_id, nonce } = await api.requestChallenge(tempId, pubKey);
      const nonceBytes = fromBase64(nonce);
      const sig = await ed25519Sign(signingKey, nonceBytes);
      const sigB64 = btoa(String.fromCodePoint(...sig));

      const result = await api.bootstrap(
        tempId,
        challenge_id,
        pubKey,
        sigB64,
        username,
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
