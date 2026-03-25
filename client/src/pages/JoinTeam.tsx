import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuthStore, type User } from '../stores/authStore';
import { api } from '../services/api';
import { exportIdentityBlob, hasIdentity, signChallenge } from '../services/keyStore';
import { fromBase64 } from '../services/cryptoCore';
import ServerAddressInput from '../components/ServerAddressInput/ServerAddressInput';
import {
  normalizeServerUrl,
  useServerHealthCheck,
  uploadPrekeyBundle,
  activateTeamAndNavigate,
} from '../utils/serverConnection';
import PublicShell from './PublicShell';

export default function JoinTeam() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token: urlToken } = useParams<{ token?: string }>();
  const { derivedKey, publicKey, addTeam, isAuthenticated, teams } = useAuthStore();

  // If already authenticated with teams and not arriving via invite link, redirect to app
  useEffect(() => {
    if (isAuthenticated && !urlToken && teams.size > 0) {
      navigate('/app', { replace: true });
    }
  }, [isAuthenticated, urlToken, teams, navigate]);

  // If user has no identity yet, redirect to create one first, then come back
  useEffect(() => {
    (async () => {
      const exists = await hasIdentity();
      if (!exists && !derivedKey) {
        if (urlToken) {
          sessionStorage.setItem('pendingInviteToken', urlToken);
        }
        navigate('/create-identity', { replace: true });
      }
    })();
  }, [derivedKey, urlToken, navigate]);

  // Auto-fill server address from current origin when navigating via invite link
  const fromInviteLink = !!urlToken;
  const [serverAddress, setServerAddress] = useState(fromInviteLink ? globalThis.location.origin : '');
  const [inviteToken, setInviteToken] = useState(urlToken ?? '');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState(localStorage.getItem('dilla_username') ?? '');
  const [teamInfo, setTeamInfo] = useState<{ team_name?: string; created_by?: string } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [serverStatus, setServerStatus] = useServerHealthCheck(
    serverAddress,
    fromInviteLink ? 'checking' : 'unknown',
  );

  // Auto-check invite when arriving via invite link (/join/:token)
  useEffect(() => {
    if (!fromInviteLink || !urlToken) return;
    const autoCheck = async () => {
      try {
        const url = normalizeServerUrl(globalThis.location.origin);
        const res = await fetch(`${url}/api/v1/health`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          setServerStatus('online');
          const info = await api.getInviteInfo(url, urlToken) as { team_name?: string; created_by?: string };
          setTeamInfo(info);
        } else {
          setServerStatus('offline');
        }
      } catch {
        setServerStatus('offline');
      }
    };
    autoCheck();
  }, [fromInviteLink, urlToken]);

  const handleCheckInvite = async () => {
    setError('');
    if (!serverAddress || !inviteToken) return;
    try {
      const info = await api.getInviteInfo(normalizeServerUrl(serverAddress), inviteToken) as { team_name?: string; created_by?: string };
      setTeamInfo(info);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleJoin = async () => {
    setError('');
    if (!derivedKey || !publicKey) {
      setError('Not authenticated');
      return;
    }

    setLoading(true);
    try {
      const normalizedUrl = normalizeServerUrl(serverAddress);
      const tempId = normalizedUrl;
      api.addTeam(tempId, normalizedUrl);

      // Challenge-response: request challenge, sign it, then register
      const { challenge_id, nonce } = await api.requestChallenge(tempId, publicKey);
      const nonceBytes = fromBase64(nonce);
      const sig = await signChallenge(derivedKey.signingKey, nonceBytes);
      const sigB64 = btoa(String.fromCodePoint(...sig));

      const result = await api.register(tempId, challenge_id, publicKey, sigB64, username, inviteToken) as { user: User; token: string; team?: Record<string, unknown> | null };
      const realTeamId = (result.team?.id as string) || tempId;

      if (realTeamId !== tempId) {
        api.removeTeam(tempId);
        api.addTeam(realTeamId, normalizedUrl);
      }
      api.setToken(realTeamId, result.token);

      addTeam(realTeamId, result.token, result.user, (result.team ?? teamInfo ?? {}) as Record<string, unknown>, normalizedUrl);

      // Upload prekey bundle for E2E encryption (non-blocking)
      if (derivedKey) {
        await uploadPrekeyBundle(derivedKey, realTeamId);

        // Upload encrypted identity blob for cross-device recovery
        try {
          const blob = await exportIdentityBlob();
          if (blob) {
            await fetch(`${normalizedUrl}/api/v1/identity/blob`, {
              method: 'PUT',
              headers: { 'Authorization': `Bearer ${result.token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ blob }),
            });
          }
        } catch (e) {
          console.warn('Identity blob upload failed:', e);
        }
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
      <h1>{t('join.title')}</h1>
      {error && <p className="error">{error}</p>}

      {teamInfo && (
        <div className="login-identity-card" style={{ marginBottom: 16 }}>
          <div style={{ minWidth: 0 }}>
            <div className="login-identity-name">{teamInfo.team_name ?? 'Unknown'}</div>
            {teamInfo.created_by && (
              <div className="login-identity-servers">{t('join.invitedBy')}: {teamInfo.created_by}</div>
            )}
          </div>
        </div>
      )}

      <div className="form">
        {!fromInviteLink && (
          <ServerAddressInput
            placeholder={t('join.serverAddress')}
            value={serverAddress}
            onChange={setServerAddress}
            serverStatus={serverStatus}
          />
        )}
        {!fromInviteLink && (
          <input
            type="text"
            placeholder={t('join.inviteToken')}
            value={inviteToken}
            onChange={(e) => setInviteToken(e.target.value)}
          />
        )}
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
        {!teamInfo && (
          <button className="btn-primary" onClick={handleCheckInvite} disabled={serverStatus !== 'online' || !inviteToken.trim() || !username.trim()}>
            {t('join.title')}
          </button>
        )}
        {teamInfo && (
          <button className="btn-primary" onClick={handleJoin} disabled={loading}>
            {loading ? t('join.joining') : t('join.join')}
          </button>
        )}
        <button className="btn-link" onClick={() => navigate(-1)}>
          ← Back
        </button>
        <button className="btn-link" onClick={() => navigate('/setup')} style={{ marginTop: '0.5rem' }}>
          Set up a new server instead
        </button>
      </div>
    </PublicShell>
  );
}