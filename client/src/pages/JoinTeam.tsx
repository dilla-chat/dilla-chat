import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { CloudCheck, CloudXmark, CloudSync } from 'iconoir-react';
import { useAuthStore, type User } from '../stores/authStore';
import { api } from '../services/api';
import { cryptoService } from '../services/crypto';
import { exportIdentityBlob, hasIdentity } from '../services/keyStore';
import PublicShell from './PublicShell';

function normalizeUrl(address: string): string {
  return address.startsWith('http')
    ? address.replace(/\/$/, '')
    : `https://${address}`;
}

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
  const [serverAddress, setServerAddress] = useState(fromInviteLink ? window.location.origin : '');
  const [inviteToken, setInviteToken] = useState(urlToken ?? '');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState(localStorage.getItem('dilla_username') ?? '');
  const [teamInfo, setTeamInfo] = useState<{ team_name?: string; created_by?: string } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [serverStatus, setServerStatus] = useState<'unknown' | 'checking' | 'online' | 'offline'>(
    fromInviteLink ? 'checking' : 'unknown',
  );

  const checkServer = useCallback(async (address: string) => {
    if (!address.trim()) {
      setServerStatus('unknown');
      return;
    }
    setServerStatus('checking');
    try {
      const url = normalizeUrl(address);
      const res = await fetch(`${url}/api/v1/health`, { signal: AbortSignal.timeout(5000) });
      setServerStatus(res.ok ? 'online' : 'offline');
    } catch {
      setServerStatus('offline');
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => checkServer(serverAddress), 500);
    return () => clearTimeout(timer);
  }, [serverAddress, checkServer]);

  // Auto-check invite when arriving via invite link (/join/:token)
  useEffect(() => {
    if (!fromInviteLink || !urlToken) return;
    const autoCheck = async () => {
      try {
        const url = normalizeUrl(window.location.origin);
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
      const info = await api.getInviteInfo(normalizeUrl(serverAddress), inviteToken) as { team_name?: string; created_by?: string };
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
      const normalizedUrl = normalizeUrl(serverAddress);
      const tempId = normalizedUrl;
      api.addTeam(tempId, normalizedUrl);

      const result = await api.register(tempId, username, displayName || username, publicKey, inviteToken) as { user: User; token: string; team?: Record<string, unknown> | null };
      const realTeamId = (result.team?.id as string) || tempId;

      if (realTeamId !== tempId) {
        api.removeTeam(tempId);
        api.addTeam(realTeamId, normalizedUrl);
      }
      api.setToken(realTeamId, result.token);

      addTeam(realTeamId, result.token, result.user, (result.team ?? teamInfo ?? {}) as Record<string, unknown>, normalizedUrl);

      // Upload prekey bundle for E2E encryption (non-blocking)
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
          <div style={{ position: 'relative' }}>
            <input
              type="text"
              placeholder={t('join.serverAddress')}
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