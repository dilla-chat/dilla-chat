// @ts-nocheck
// Onboarding wizard — faithful port of design_handoff_dilla_mesh/onboarding.jsx
// with real backend wiring on the hooks the handoff stubs out (Connect,
// Identity, KeyGen, Done). The handoff JSX + CSS define the visual layer
// — every `.onb-*` class name and the 5-step flow shape match the source
// 1:1; only the data layer is rewired.
//
// 3 modes:
//   - bootstrap: first admin enrolls a new server (→ api.bootstrap)
//   - invite:    member joins via invite token   (→ api.register)
//   - existing:  already-enrolled re-login       (→ unlockWithPassphrase)
//
// Hardware-key (WebAuthn) and the "Both" protection mode UI exists from
// the handoff but the action falls back to passphrase — wiring WebAuthn
// here is a separate pass against services/webauthn.ts.

import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore, persistPassphrase, type User } from '../../stores/authStore';
import { api } from '../../services/api';
import {
  createIdentity,
  createIdentityWithPassphrase,
  hasIdentity,
  signChallenge,
  exportIdentityBlob,
  unlockWithPassphrase,
  unlockWithPrf,
  unlockWithRecovery,
  generatePrfSalt,
  getCredentialInfo,
  encodeRecoveryKey,
  importIdentityBlob,
} from '../../services/keyStore';
import {
  registerPasskey,
  authenticatePasskey,
  prfOutputToBase64,
  decodeRecoveryKey,
} from '../../services/webauthn';
import { refreshServerTokens, tryReconnectToCurrentServer } from '../../services/authReconnect';
import { initCrypto, getIdentityKeys } from '../../services/crypto';
import { fromBase64, toBase64 } from '../../services/cryptoCore';
import {
  normalizeServerUrl,
  uploadPrekeyBundle,
  activateTeamAndNavigate,
} from '../../utils/serverConnection';
import { friendlyError } from '../../utils/errorMessages';
import { THEMES } from '../../shell/themes';
import '../../shell/chat.css';
import './Onboarding.css';

const STEPS = [
  { id: 'connect', label: 'Connect' },
  { id: 'identity', label: 'Identity' },
  { id: 'keygen', label: 'Keys' },
  { id: 'safety', label: 'Safety' },
  { id: 'done', label: 'Done' },
];

type StepId = (typeof STEPS)[number]['id'];
type Mode = 'bootstrap' | 'invite' | 'existing';
type Protect = 'passphrase' | 'hardware' | 'both';

interface LogLine {
  line: string;
  err?: boolean;
}

function passphraseStrength(p: string) {
  if (!p) return { score: 0, label: 'empty', color: 'var(--fg-3)' };
  let s = 0;
  if (p.length >= 8) s++;
  if (p.length >= 14) s++;
  if (p.length >= 20) s++;
  if (/[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p)) s++;
  s = Math.min(4, s);
  const labels = ['too short', 'weak', 'fair', 'strong', 'excellent'];
  const colors = ['var(--danger)', 'var(--danger)', 'var(--warn)', 'var(--accent)', 'var(--accent)'];
  return { score: s, label: labels[s], color: colors[s] };
}

function CornerMarker({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <rect x={x} y={y} width="7" height="7" fill="var(--accent)" />
      <rect x={x + 1} y={y + 1} width="5" height="5" fill="var(--bg)" />
      <rect x={x + 2} y={y + 2} width="3" height="3" fill="var(--accent)" />
    </g>
  );
}

export default function Onboarding() {
  const { t: i18n } = useTranslation();
  const navigate = useNavigate();
  const { setDerivedKey, setPublicKey, addTeam } = useAuthStore();
  const [searchParams] = useSearchParams();

  // Apply the mesh theme tokens so the handoff CSS has --bg, --accent etc.
  // (The shell does this in AppShell.tsx via THEMES.themeVars on its root.)
  const wrapStyle = THEMES.themeVars(THEMES.mesh, { density: 'regular' });

  // Deep-link state. Invite emails land on /join/:token which redirects to
  // /onboarding?mode=invite&token=…; bootstrap CLI hints can pre-select
  // /onboarding?mode=bootstrap. Default to bootstrap (first-time user on
  // a fresh server is the most common organic landing).
  const queryMode = searchParams.get('mode') as Mode | null;
  const queryToken = searchParams.get('token') ?? '';
  const queryServer = searchParams.get('server') ?? '';

  const [stepIdx, setStepIdx] = useState(0);
  const [mode, setMode] = useState<Mode>(
    queryMode && ['bootstrap', 'invite', 'existing'].includes(queryMode) ? queryMode : 'bootstrap',
  );
  const [server, setServer] = useState(
    queryServer || (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8080'),
  );
  const [token, setToken] = useState(queryToken);
  const [team, setTeam] = useState('');
  const [username, setUsername] = useState('');
  const [keyProtect, setKeyProtect] = useState<Protect>('passphrase');
  const [passphrase, setPassphrase] = useState('');
  const [showPass, setShowPass] = useState(false);

  // Connect step transient state
  const [connecting, setConnecting] = useState(false);
  const [connectLog, setConnectLog] = useState<LogLine[]>([]);
  const [connectError, setConnectError] = useState<string | null>(null);

  // Recovery sub-flow (existing mode only). Activated by a "lost passphrase?"
  // link inside the existing-mode connect form, or by landing on
  // /onboarding?recover=1. When on, the form swaps the passphrase input for
  // username + recovery-key textarea; the unlock handler fetches the
  // identity blob from the server, imports it into IndexedDB, then unlocks
  // via the recovery key.
  const [useRecovery, setUseRecovery] = useState(searchParams.get('recover') === '1');
  const [recoveryServer, setRecoveryServer] = useState('');
  const [recoveryUsername, setRecoveryUsername] = useState('');
  const [recoveryKeyInput, setRecoveryKeyInput] = useState('');

  // KeyGen step state
  const [keyLines, setKeyLines] = useState<LogLine[]>([]);
  const [keyError, setKeyError] = useState<string | null>(null);
  const keyStartedRef = useRef(false);
  const enrolledTeamIdRef = useRef<string | null>(null);

  // Safety step state
  const [fingerprint, setFingerprint] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');

  // Detect a pre-existing identity in IndexedDB on mount. If the user lands
  // in bootstrap/invite mode but already has a keypair from a prior session,
  // we shouldn't blow up at the keygen step — we should surface the conflict
  // up front and offer a one-click switch to existing-mode.
  const [hasExistingIdentity, setHasExistingIdentity] = useState(false);
  useEffect(() => {
    let cancelled = false;
    hasIdentity()
      .then((exists) => {
        if (!cancelled) setHasExistingIdentity(exists);
      })
      .catch(() => {
        /* ignore — assume no identity */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const step = STEPS[stepIdx];

  function next() {
    setStepIdx((i) => Math.min(STEPS.length - 1, i + 1));
  }
  function back() {
    setStepIdx((i) => Math.max(0, i - 1));
  }

  // ── Connect step: real handlers per mode ───────────────────────────────
  async function doConnect() {
    setConnectError(null);
    setConnectLog([]);
    setConnecting(true);

    const url = normalizeServerUrl(server);
    setConnectLog((p) => [...p, { line: `connecting to ${url}…` }]);

    try {
      if (mode === 'existing' && useRecovery) {
        // Recovery sub-flow: fetch the server-stored identity blob, import
        // it into IndexedDB, unlock with the recovery key, then authenticate
        // against the server. Mirrors the legacy RecoverFromServer.tsx
        // flow inline (no separate route needed).
        if (!recoveryServer || !recoveryUsername || !recoveryKeyInput.trim()) {
          setConnectError('Enter server, username, and recovery key.');
          setConnecting(false);
          return;
        }
        const recoveryBytes = decodeRecoveryKey(recoveryKeyInput.trim());
        const recoveryKeyB64 = toBase64(recoveryBytes);
        const recoveryUrl = normalizeServerUrl(recoveryServer);

        setConnectLog((p) => [...p, { line: 'fetching identity blob from server' }]);
        const blobResp = await fetch(
          `${recoveryUrl}/api/v1/identity/blob?username=${encodeURIComponent(recoveryUsername)}`,
        );
        if (!blobResp.ok) throw new Error('Failed to fetch identity blob from server');
        const { blob } = await blobResp.json();
        await importIdentityBlob(blob);
        setConnectLog((p) => [...p, { line: '  ✓ blob imported · unlocking' }]);

        const identity = await unlockWithRecovery(recoveryBytes);
        await initCrypto(identity, recoveryKeyB64);
        const pubKeyB64 = btoa(String.fromCodePoint(...identity.publicKeyBytes));
        setPublicKey(pubKeyB64);
        setDerivedKey(recoveryKeyB64);
        localStorage.setItem('dilla_username', recoveryUsername);

        // Authenticate to recover a JWT for this server.
        const tempId = 'recovery-temp';
        api.addTeam(tempId, recoveryUrl);
        const challenge = await api.requestChallenge(tempId, pubKeyB64);
        const nonceBytes = fromBase64(challenge.nonce);
        const sigBytes = await signChallenge(identity.signingKey, nonceBytes);
        const signature = toBase64(sigBytes);
        const verified = (await api.verifyChallenge(
          tempId,
          challenge.challenge_id,
          pubKeyB64,
          signature,
        )) as { user: User; token: string; team_id?: string };
        api.removeTeam(tempId);
        const teamId = verified.team_id || tempId;
        api.addTeam(teamId, recoveryUrl);
        api.setToken(teamId, verified.token);
        addTeam(teamId, verified.token, verified.user, null, recoveryUrl);
        setConnectLog((p) => [...p, { line: '  ✓ identity recovered · opening Dilla' }]);
        await activateTeamAndNavigate(teamId, navigate);
        return;
      }

      if (mode === 'existing') {
        // Already-enrolled is a short-circuit login. Look up locally
        // stored credentials: if a PRF-capable passkey is registered, try
        // it first; otherwise fall back to the passphrase entered in the
        // connect form.
        setConnectLog((p) => [...p, { line: 'unlocking identity…' }]);
        const info = await getCredentialInfo();
        let identity: Awaited<ReturnType<typeof unlockWithPassphrase>> | null = null;
        let derivedKeyB64 = '';
        // If the user typed a passphrase, honor that intent — skip the
        // passkey dialog entirely. Otherwise, only attempt passkey when
        // credentials were actually registered (passphrase-only enrollments
        // leave credentials empty so the picker doesn't pop up either).
        const hasPasskey = !passphrase && info && info.credentials.length > 0;

        if (hasPasskey) {
          try {
            setConnectLog((p) => [...p, { line: 'trying passkey · prompting authenticator' }]);
            const credentialIds = info!.credentials.map((c) => c.id);
            const storedServer = info!.keySlots[0]?.server_url || normalizeServerUrl(server);
            const auth = await authenticatePasskey(credentialIds, info!.prfSalt, storedServer);
            if (auth.prfOutput) {
              derivedKeyB64 = prfOutputToBase64(auth.prfOutput);
              const prfKeyBytes = fromBase64(derivedKeyB64);
              identity = await unlockWithPrf(prfKeyBytes);
              setConnectLog((p) => [...p, { line: '  ✓ passkey accepted' }]);
            } else {
              setConnectLog((p) => [
                ...p,
                { line: '  passkey lacks PRF — trying passphrase next' },
              ]);
            }
          } catch (e) {
            setConnectLog((p) => [
              ...p,
              { line: `  passkey unlock failed: ${(e as Error).message}`, err: true },
            ]);
            // Don't fail outright — let passphrase fallback below handle it.
          }
        }

        if (!identity) {
          if (!passphrase) {
            setConnectError(
              hasPasskey
                ? 'Passkey unlock did not yield a derived key — enter your passphrase as fallback.'
                : 'Enter your passphrase to unlock.',
            );
            setConnecting(false);
            return;
          }
          identity = await unlockWithPassphrase(passphrase);
          derivedKeyB64 = btoa(
            String.fromCodePoint(...new TextEncoder().encode(passphrase.slice(0, 32))),
          );
          // Persist the raw passphrase (encrypted, per-tab) so reload can
          // auto-unlock instead of kicking the user back to /login.
          void persistPassphrase(passphrase);
        }

        await initCrypto(identity, derivedKeyB64);
        const pubKeyB64 = btoa(String.fromCodePoint(...identity.publicKeyBytes));
        setDerivedKey(derivedKeyB64);
        setPublicKey(pubKeyB64);
        setConnectLog((p) => [...p, { line: 'identity unlocked · refreshing tokens…' }]);
        await refreshServerTokens(useAuthStore.getState().teams, pubKeyB64);
        const hasTeams =
          useAuthStore.getState().teams.size > 0 ||
          (await tryReconnectToCurrentServer(pubKeyB64));
        setConnectLog((p) => [...p, { line: hasTeams ? 'reconnected.' : 'no teams found.' }]);
        navigate(hasTeams ? '/app' : '/join');
        return;
      }

      // bootstrap and invite: validate server reachable, then advance.
      // Real token validation happens inside api.bootstrap / api.register
      // in the keygen step (an explicit pre-flight only exists for invite).
      try {
        const res = await fetch(`${url}/api/v1/health`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        setConnectLog((p) => [...p, { line: 'tls handshake · ok' }]);
      } catch (e) {
        throw e;
      }

      if (mode === 'invite') {
        try {
          const info = (await api.getInviteInfo(url, token)) as {
            team_name?: string;
            created_by?: string;
          };
          if (info.team_name) {
            setTeam(info.team_name);
            setConnectLog((p) => [...p, { line: `invite valid · team "${info.team_name}"` }]);
          } else {
            setConnectLog((p) => [...p, { line: 'invite valid' }]);
          }
        } catch (e) {
          throw e;
        }
      } else {
        setConnectLog((p) => [...p, { line: 'ready · bootstrap token will be validated next' }]);
      }

      setConnectLog((p) => [...p, { line: 'ready.' }]);
      setTimeout(() => {
        setConnecting(false);
        next();
      }, 500);
    } catch (e) {
      const msg = friendlyError(e, i18n);
      setConnectError(msg);
      setConnectLog((p) => [...p, { line: msg, err: true }]);
      setConnecting(false);
    }
  }

  // ── KeyGen step: real identity creation + server registration ─────────
  useEffect(() => {
    if (step.id !== 'keygen') return;
    if (keyStartedRef.current) return;
    keyStartedRef.current = true;

    (async () => {
      const url = normalizeServerUrl(server);
      const push = (line: string, err = false) =>
        setKeyLines((prev) => [...prev, { line, err }]);
      try {
        push('$ dilla identity create');
        push('generating ed25519 keypair…');
        const already = await hasIdentity();

        // Two creation paths depending on keyProtect:
        //  - passphrase: createIdentityWithPassphrase (Argon2id-wrapped MEK)
        //  - hardware/both: registerPasskey for WebAuthn+PRF, then
        //    createIdentity wraps the MEK with the PRF-derived key. If the
        //    authenticator lacks PRF we fall back to passphrase for the
        //    'both' mode, and error for the pure-hardware mode.
        let publicKeyB64 = '';
        let publicKeyHex = '';
        let identity: Awaited<ReturnType<typeof createIdentityWithPassphrase>>['identity'] | undefined;
        let derivedKey = '';

        if (already) {
          // Resuming after a partial run — identity is already on disk
          // (probably from a previous attempt that bailed before
          // registering with the server). Unlock with the entered
          // passphrase and reuse that keypair; the bootstrap/register
          // call below binds the SAME key to the server, so re-login
          // later still works against this identity.
          push('  ✓ existing identity on disk · re-binding');
          if (!passphrase) {
            throw new Error(
              'An identity exists on this device but no passphrase was entered. Reload and either enter the passphrase you used originally, or use "Already enrolled" mode.',
            );
          }
          identity = await unlockWithPassphrase(passphrase);
          publicKeyB64 = btoa(String.fromCodePoint(...identity.publicKeyBytes));
          publicKeyHex = Array.from(identity.publicKeyBytes)
            .map((b: number) => b.toString(16).padStart(2, '0'))
            .join('');
          derivedKey = publicKeyB64;
        } else if (keyProtect === 'hardware' || keyProtect === 'both') {
          push('binding to webauthn credential…');
          const prfSalt = generatePrfSalt();
          const userIdBytes = new TextEncoder().encode(
            username.padEnd(32, '\0').slice(0, 32),
          );
          const passkey = await registerPasskey(username.trim(), userIdBytes, prfSalt, url);
          push(`  credential: ${passkey.credentialName}`);
          if (!passkey.prfSupported) {
            if (keyProtect === 'hardware') {
              throw new Error(
                'This passkey does not support the PRF extension required for key derivation. Use "Both" or "Passphrase" instead.',
              );
            }
            // 'both' fallback: use passphrase as the wrap key, recovery via
            // recovery key. The passkey credential is still recorded so a
            // future unlock attempt can try it first.
            push('  ! passkey lacks PRF — falling back to passphrase wrap');
            const created = await createIdentityWithPassphrase(url, passphrase, [
              {
                id: passkey.credentialId,
                name: passkey.credentialName,
                created_at: new Date().toISOString(),
              },
            ]);
            publicKeyB64 = created.publicKeyB64;
            publicKeyHex = created.publicKeyHex;
            identity = created.identity;
            derivedKey = publicKeyB64;
            setRecoveryKey(encodeRecoveryKey(created.recoveryKey));
          } else {
            push('  ✓ prf evaluated · 32 bytes derived');
            const prfDerivedKeyB64 = prfOutputToBase64(passkey.prfOutput);
            const prfKeyBytes = fromBase64(prfDerivedKeyB64);
            const created = await createIdentity(url, prfKeyBytes, prfSalt, [
              {
                id: passkey.credentialId,
                name: passkey.credentialName,
                created_at: new Date().toISOString(),
              },
            ]);
            publicKeyB64 = created.publicKeyB64;
            publicKeyHex = created.publicKeyHex;
            identity = created.identity;
            derivedKey = prfDerivedKeyB64;
            setRecoveryKey(encodeRecoveryKey(created.recoveryKey));
          }
        } else {
          const created = await createIdentityWithPassphrase(url, passphrase, []);
          publicKeyB64 = created.publicKeyB64;
          publicKeyHex = created.publicKeyHex;
          identity = created.identity;
          derivedKey = publicKeyB64;
          setRecoveryKey(encodeRecoveryKey(created.recoveryKey));
          // Persist the passphrase too — the create flow stores publicKey
          // as derivedKey (used for session-blob encryption), but reload
          // needs the actual passphrase to unwrap the identity MEK via
          // PBKDF2. Without this, every reload bounces to /login.
          void persistPassphrase(passphrase);
        }

        push(`  pub  ed25519:${(publicKeyHex || '').slice(0, 32)}…`);
        push('  priv [encrypted]');

        if (identity) await initCrypto(identity, derivedKey);
        setPublicKey(publicKeyB64);
        setDerivedKey(derivedKey);

        if (!already) {
          if (keyProtect === 'hardware' || keyProtect === 'both') {
            push('sealing private key with hardware-derived wrap key…');
          } else {
            push('deriving keystore key (argon2id)…');
            push('sealing private key with aes-256-gcm…');
          }
        }

        push(`signing nonce as "${username || ''}"…`);
        const tempId = url;
        api.addTeam(tempId, url);
        const { challenge_id, nonce } = await api.requestChallenge(tempId, publicKeyB64);
        const nonceBytes = fromBase64(nonce);
        const keys = getIdentityKeys();
        const sig = await signChallenge(keys.signingKey, nonceBytes);
        const sigB64 = btoa(String.fromCodePoint(...sig));

        const result =
          mode === 'bootstrap'
            ? ((await api.bootstrap(
                tempId,
                challenge_id,
                publicKeyB64,
                sigB64,
                username.trim(),
                token,
                team.trim() || undefined,
              )) as { user: User; token: string; team_id?: string; team?: { id?: string; name?: string } })
            : ((await api.register(
                tempId,
                challenge_id,
                publicKeyB64,
                sigB64,
                username.trim(),
                token,
              )) as { user: User; token: string; team_id?: string; team?: { id?: string; name?: string } });

        // Server returns {token, user, team_id} — a flat string, not nested
        // under team.id. Earlier code read team.id and silently fell back to
        // tempId (= server URL), which made the rest of the app try to GET
        // /api/v1/teams/http://localhost:8888 and 404 on every request.
        const realTeamId = result.team_id || result.team?.id || tempId;
        if (realTeamId !== tempId) {
          api.removeTeam(tempId);
          api.addTeam(realTeamId, url);
        }
        api.setToken(realTeamId, result.token);
        addTeam(
          realTeamId,
          result.token,
          result.user,
          (result.team ?? { id: realTeamId, name: team }) as Record<string, unknown>,
          url,
        );
        enrolledTeamIdRef.current = realTeamId;
        push('  signature ok · server returns jwt');

        push('publishing prekey bundle for X3DH…');
        await uploadPrekeyBundle(derivedKey, realTeamId);
        push('  prekeys uploaded');

        try {
          const blob = await exportIdentityBlob();
          if (blob) {
            await fetch(`${url}/api/v1/identity/blob`, {
              method: 'PUT',
              headers: {
                Authorization: `Bearer ${result.token}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ blob }),
            });
            push('identity blob backed up to server');
          }
        } catch {
          /* non-fatal */
        }

        setFingerprint(
          (publicKeyHex || '').match(/.{1,4}/g)?.slice(0, 12).join(' ') ?? publicKeyHex,
        );
        push('identity created.');
        setTimeout(() => next(), 700);
      } catch (e) {
        const msg = friendlyError(e, i18n);
        push(`error: ${msg}`, true);
        setKeyError(msg);
        keyStartedRef.current = false;
      }
    })();
  }, [step.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Identity validation gate ──────────────────────────────────────────
  const strength = passphraseStrength(passphrase);
  const passOk = strength.score >= 2;
  // Hardware: passkey is prompted at the keygen step, nothing required up
  // front. Passphrase / Both: need a sufficiently strong passphrase here so
  // we can wrap the MEK (or its recovery slot in 'both').
  const protectionOk =
    keyProtect === 'passphrase' ? passOk : keyProtect === 'hardware' ? true : passOk;
  const identityOk = username.length >= 2 && protectionOk;

  function onIdentityNext() {
    next();
  }

  return (
    <div className="onb-shell" style={wrapStyle}>
      <div className="onb-bg" />
      <header className="onb-header">
        <div className="onb-logo">
          <span className="onb-logo-mark">D</span>
          <span className="onb-logo-text">DILLA</span>
          <span className="onb-logo-caret" />
        </div>
        <div className="onb-keybinds">
          <span>
            <kbd>esc</kbd> cancel
          </span>
          <span>
            <kbd>↵</kbd> continue
          </span>
        </div>
      </header>

      <main className="onb-main">
        <ol className="onb-steps">
          {STEPS.map((s, i) => (
            <li
              key={s.id}
              className={
                'onb-step' +
                (i === stepIdx ? ' active' : '') +
                (i < stepIdx ? ' done' : '')
              }
            >
              <span className="onb-step-num">{String(i + 1).padStart(2, '0')}</span>
              <span className="onb-step-label">{s.label}</span>
            </li>
          ))}
        </ol>

        <div className="onb-card">
          {step.id === 'connect' && (
            <ConnectStep
              mode={mode}
              setMode={setMode}
              hasExistingIdentity={hasExistingIdentity}
              server={server}
              setServer={setServer}
              token={token}
              setToken={setToken}
              passphrase={passphrase}
              setPassphrase={setPassphrase}
              connecting={connecting}
              log={connectLog}
              error={connectError}
              onConnect={doConnect}
              useRecovery={useRecovery}
              setUseRecovery={setUseRecovery}
              recoveryServer={recoveryServer}
              setRecoveryServer={setRecoveryServer}
              recoveryUsername={recoveryUsername}
              setRecoveryUsername={setRecoveryUsername}
              recoveryKeyInput={recoveryKeyInput}
              setRecoveryKeyInput={setRecoveryKeyInput}
            />
          )}
          {step.id === 'identity' && (
            <IdentityStep
              username={username}
              setUsername={setUsername}
              passphrase={passphrase}
              setPassphrase={setPassphrase}
              showPass={showPass}
              setShowPass={setShowPass}
              keyProtect={keyProtect}
              setKeyProtect={setKeyProtect}
              team={team || (mode === 'bootstrap' ? 'a new team' : 'this server')}
              mode={mode}
              setTeam={setTeam}
              strength={strength}
              ok={identityOk}
              onBack={back}
              onNext={onIdentityNext}
            />
          )}
          {step.id === 'keygen' && (
            <KeyGenStep lines={keyLines} error={keyError} onBack={back} />
          )}
          {step.id === 'safety' && (
            <SafetyStep
              fingerprint={fingerprint}
              recoveryKey={recoveryKey}
              onBack={back}
              onNext={next}
            />
          )}
          {step.id === 'done' && (
            <DoneStep
              username={username || ''}
              team={team || 'Dilla'}
              mode={mode}
              onOpen={async () => {
                const teamId = enrolledTeamIdRef.current;
                if (teamId) await activateTeamAndNavigate(teamId, navigate);
                else navigate('/app');
              }}
            />
          )}
        </div>
      </main>

      <footer className="onb-footer">
        <div className="onb-status">
          <span className="onb-dot" /> waiting · step {stepIdx + 1}/{STEPS.length}
        </div>
        {mode !== 'existing' && stepIdx === 0 && (
          <button
            className="onb-skip"
            type="button"
            onClick={() => setMode('existing')}
          >
            have an account? sign in →
          </button>
        )}
      </footer>
    </div>
  );
}

// ───────── Step 1: Connect ─────────
function ConnectStep({
  mode,
  setMode,
  hasExistingIdentity,
  server,
  setServer,
  token,
  setToken,
  passphrase,
  setPassphrase,
  connecting,
  log,
  error,
  onConnect,
  useRecovery,
  setUseRecovery,
  recoveryServer,
  setRecoveryServer,
  recoveryUsername,
  setRecoveryUsername,
  recoveryKeyInput,
  setRecoveryKeyInput,
}) {
  return (
    <>
      <h1 className="onb-title">Connect to a Dilla server</h1>
      <p className="onb-blurb">
        Run <code>./dilla-server</code> on your own infrastructure, then paste the URL it
        printed on first boot. Or use a bootstrap link from your admin.
      </p>

      <div className="onb-seg">
        <button className={mode === 'bootstrap' ? 'on' : ''} onClick={() => setMode('bootstrap')}>
          I have a bootstrap link
        </button>
        <button className={mode === 'invite' ? 'on' : ''} onClick={() => setMode('invite')}>
          I have an invite
        </button>
        <button className={mode === 'existing' ? 'on' : ''} onClick={() => setMode('existing')}>
          Already enrolled
        </button>
      </div>

      {hasExistingIdentity && mode !== 'existing' && (
        <div
          className="onb-callout"
          style={{
            borderLeftColor: 'var(--accent)',
            background: 'color-mix(in oklab, var(--accent) 8%, transparent)',
            marginBottom: 16,
          }}
        >
          <strong>An identity already exists on this device.</strong> Creating a new
          one here will collide with it.{' '}
          <button
            className="onb-link"
            type="button"
            onClick={() => setMode('existing')}
            style={{ fontSize: 12 }}
          >
            Sign in with your existing identity →
          </button>
        </div>
      )}

      {mode !== 'existing' && (
        <div className="onb-field">
          <label>Server URL</label>
          <input
            type="text"
            value={server}
            onChange={(e) => setServer(e.target.value)}
            placeholder="http://localhost:8080"
          />
        </div>
      )}

      {(mode === 'bootstrap' || mode === 'invite') && (
        <div className="onb-field">
          <label>{mode === 'bootstrap' ? 'Bootstrap token' : 'Invite token'}</label>
          <input
            type="text"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={mode === 'bootstrap' ? 'abc123def456…' : 'inv-4f7a-9c12'}
          />
          <div className="onb-hint">
            {mode === 'bootstrap'
              ? "One-time link from your server's first-run output. Becomes invalid after the admin registers."
              : 'A reusable or one-time link generated from Team Settings → Invites.'}
          </div>
        </div>
      )}

      {mode === 'existing' && !useRecovery && (
        <>
          <div className="onb-field">
            <label>
              Passphrase <span style={{ opacity: 0.6, fontWeight: 400 }}>(optional)</span>
            </label>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="leave blank to use passkey"
              autoFocus
            />
            <div className="onb-hint">
              If a passkey is registered on this device, we'll prompt the authenticator
              first. Passphrase is used as a fallback (or for accounts enrolled with
              passphrase-only).
            </div>
          </div>
          <div style={{ marginTop: -8, marginBottom: 12 }}>
            <button className="onb-link" type="button" onClick={() => setUseRecovery(true)}>
              lost passphrase? recover with key
            </button>
          </div>
        </>
      )}

      {mode === 'existing' && useRecovery && (
        <>
          <div className="onb-field">
            <label>Server URL</label>
            <input
              type="text"
              value={recoveryServer}
              onChange={(e) => setRecoveryServer(e.target.value)}
              placeholder="http://localhost:8080"
              autoFocus
            />
            <div className="onb-hint">
              The server that holds your encrypted identity blob.
            </div>
          </div>
          <div className="onb-field">
            <label>Username</label>
            <input
              type="text"
              value={recoveryUsername}
              onChange={(e) => setRecoveryUsername(e.target.value)}
              placeholder="username"
            />
          </div>
          <div className="onb-field">
            <label>Recovery key</label>
            <textarea
              value={recoveryKeyInput}
              onChange={(e) => setRecoveryKeyInput(e.target.value)}
              placeholder="XXXX-XXXX-XXXX-…"
              rows={3}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 13,
                width: '100%',
                background: 'var(--bg)',
                color: 'var(--fg)',
                border: '1px solid var(--hairline-2)',
                borderRadius: 4,
                padding: '8px 10px',
                resize: 'vertical',
              }}
            />
            <div className="onb-hint">
              The 32-byte recovery key you saved when you first enrolled.
            </div>
          </div>
          <div style={{ marginTop: -8, marginBottom: 12 }}>
            <button className="onb-link" type="button" onClick={() => setUseRecovery(false)}>
              ← back to passphrase / passkey unlock
            </button>
          </div>
        </>
      )}

      {log.length > 0 && (
        <pre className="onb-log">
          {log.map((l, i) => (
            <div key={i} className={'onb-log-line' + (l.err ? ' err' : '')}>
              <span className={'onb-log-prompt' + (l.err ? ' err' : '')}>
                {l.err ? '✗' : '›'}
              </span>{' '}
              {l.line}
            </div>
          ))}
          {connecting && (
            <div className="onb-log-line">
              <span className="onb-log-cursor">_</span>
            </div>
          )}
        </pre>
      )}

      {error && (
        <div
          className="onb-callout"
          style={{
            borderLeftColor: 'var(--danger)',
            background: 'color-mix(in oklab, var(--danger) 8%, transparent)',
          }}
        >
          <strong style={{ color: 'var(--danger)' }}>Failed.</strong> {error}
        </div>
      )}

      <div className="onb-actions">
        <span />
        <button
          className="onb-btn primary"
          disabled={
            connecting ||
            (mode === 'existing'
              ? useRecovery
                ? !recoveryServer || !recoveryUsername || !recoveryKeyInput.trim()
                : false /* passphrase optional — passkey unlock is attempted first */
              : !server || ((mode === 'bootstrap' || mode === 'invite') && !token))
          }
          onClick={onConnect}
        >
          {connecting
            ? 'Connecting…'
            : mode === 'existing'
              ? useRecovery
                ? 'Recover identity'
                : 'Unlock'
              : 'Connect'}
        </button>
      </div>
    </>
  );
}

// ───────── Step 2: Identity ─────────
function IdentityStep({
  username,
  setUsername,
  passphrase,
  setPassphrase,
  showPass,
  setShowPass,
  keyProtect,
  setKeyProtect,
  team,
  mode,
  setTeam,
  strength,
  ok,
  onBack,
  onNext,
}) {
  return (
    <>
      <h1 className="onb-title">Create your identity</h1>
      <p className="onb-blurb">
        Joining <strong>{team}</strong>. No password is sent to the server — you
        authenticate by signing challenges with a private key generated on this device.
      </p>

      <div className="onb-field">
        <label>Username</label>
        <input
          type="text"
          value={username}
          onChange={(e) =>
            setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))
          }
          placeholder="username"
          autoFocus
        />
        <div className="onb-hint">Lowercase letters, numbers, _, -. Visible to your team.</div>
      </div>

      {mode === 'bootstrap' && (
        <div className="onb-field">
          <label>Team name</label>
          <input
            type="text"
            value={team === 'a new team' ? '' : team}
            onChange={(e) => setTeam(e.target.value)}
            placeholder="berralitos"
          />
          <div className="onb-hint">The display name your team appears under on this server.</div>
        </div>
      )}

      <div className="onb-field">
        <label>Protect this device's private key with</label>
        <div className="onb-seg onb-seg-protect">
          <button
            className={keyProtect === 'passphrase' ? 'on' : ''}
            onClick={() => setKeyProtect('passphrase')}
          >
            Passphrase
          </button>
          <button
            className={keyProtect === 'hardware' ? 'on' : ''}
            onClick={() => setKeyProtect('hardware')}
            style={{ width: '190px' }}
          >
            Hardware key
          </button>
          <button
            className={keyProtect === 'both' ? 'on' : ''}
            onClick={() => setKeyProtect('both')}
          >
            Both
          </button>
        </div>
        <div className="onb-hint">
          {keyProtect === 'passphrase' &&
            'Argon2id-derived AES-256-GCM key seals your private key on disk.'}
          {keyProtect === 'hardware' &&
            'Any WebAuthn authenticator works — hardware keys (YubiKey, Titan), platform biometrics (Touch ID, Windows Hello), or passkey managers. Requires PRF support on the authenticator.'}
          {keyProtect === 'both' &&
            'Defence in depth — hardware key for daily use, passphrase as recovery if the key is lost.'}
        </div>
      </div>

      {(keyProtect === 'passphrase' || keyProtect === 'both') && (
        <div className="onb-field">
          <label>
            Passphrase{' '}
            <button className="onb-link" onClick={() => setShowPass((v) => !v)}>
              {showPass ? 'hide' : 'show'}
            </button>
          </label>
          <input
            type={showPass ? 'text' : 'password'}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="something long and memorable"
          />
          <div className="onb-strength">
            <div className="onb-strength-bars">
              {[0, 1, 2, 3].map((i) => (
                <span
                  key={i}
                  className={'onb-sb' + (i < strength.score ? ' on' : '')}
                  style={{ background: i < strength.score ? strength.color : undefined }}
                />
              ))}
            </div>
            <span className="onb-strength-label">{strength.label}</span>
          </div>
          <div className="onb-hint">Dilla never sees it — losing it locks you out permanently.</div>
        </div>
      )}

      {keyProtect === 'hardware' && (
        <div className="onb-field">
          <div className="onb-auth-chips">
            <span className="onb-chip">
              <b>USB</b> YubiKey · Titan
            </span>
            <span className="onb-chip">
              <b>OS</b> Touch ID · Windows Hello
            </span>
            <span className="onb-chip">
              <b>Passkey</b> 1Password · Proton Pass · Bitwarden · iCloud
            </span>
          </div>
          <div className="onb-hint">
            The browser passkey dialog opens on the next step. The PRF extension is
            evaluated then to derive your wrap key — no extra round-trip.
          </div>
        </div>
      )}

      <div className="onb-actions">
        <button className="onb-btn" onClick={onBack}>
          Back
        </button>
        <button className="onb-btn primary" disabled={!ok} onClick={onNext}>
          Generate keys
        </button>
      </div>
    </>
  );
}

// ───────── Step 3: Key generation ─────────
function KeyGenStep({ lines, error, onBack }) {
  return (
    <>
      <h1 className="onb-title">Generating keys…</h1>
      <p className="onb-blurb">
        Creating an ed25519 identity and sealing it with your passphrase. This happens on
        your device — no key material ever leaves it.
      </p>

      <pre className="onb-log onb-log-big">
        {lines.map((l, i) => (
          <div key={i} className={'onb-log-line' + (l.err ? ' err' : '')}>
            <span className={'onb-log-prompt' + (l.err ? ' err' : '')}>
              {l.line.startsWith('$') ? '' : l.err ? '✗' : '›'}
            </span>{' '}
            {l.line}
          </div>
        ))}
        {!error && (
          <div className="onb-log-line">
            <span className="onb-log-cursor">_</span>
          </div>
        )}
      </pre>

      {error && (
        <div className="onb-actions">
          <button className="onb-btn" onClick={onBack}>
            ← Back to identity
          </button>
        </div>
      )}
    </>
  );
}

// ───────── Step 4: Safety number ─────────
function SafetyStep({ fingerprint, recoveryKey, onBack, onNext }) {
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [copiedFp, setCopiedFp] = useState(false);
  const [copiedRk, setCopiedRk] = useState(false);
  const grid = useRef<number[][] | null>(null);
  if (!grid.current) {
    const g: number[][] = [];
    for (let y = 0; y < 21; y++) {
      const row: number[] = [];
      for (let x = 0; x < 21; x++) {
        const v = ((x * 31 + y * 17 + x * y * 5) ^ 0xa5) & 1;
        row.push(v);
      }
      g.push(row);
    }
    grid.current = g;
  }

  return (
    <>
      <h1 className="onb-title">Your safety number</h1>
      <p className="onb-blurb">
        Compare this number out-of-band with people you message to verify their device,
        not just their account. Anyone can claim to be "ada" — but only the real ada has
        the matching number.
      </p>

      <div className="onb-safety">
        <div className="onb-qr">
          <svg viewBox="0 0 21 21" width="156" height="156" shapeRendering="crispEdges">
            <rect width="21" height="21" fill="var(--bg)" />
            {grid.current.map((row, y) =>
              row.map((v, x) =>
                v ? (
                  <rect
                    key={x + 'x' + y}
                    x={x}
                    y={y}
                    width="1"
                    height="1"
                    fill="var(--accent)"
                  />
                ) : null,
              ),
            )}
            <CornerMarker x={0} y={0} />
            <CornerMarker x={14} y={0} />
            <CornerMarker x={0} y={14} />
          </svg>
        </div>
        <div className="onb-fp">
          <div className="onb-fp-label">FINGERPRINT</div>
          <div className="onb-fp-text">{fingerprint || '— pending —'}</div>
          <div className="onb-fp-actions">
            <button
              className="onb-btn"
              onClick={() => {
                if (!fingerprint) return;
                navigator.clipboard?.writeText(fingerprint);
                setCopiedFp(true);
                setTimeout(() => setCopiedFp(false), 1500);
              }}
            >
              {copiedFp ? 'Copied' : 'Copy'}
            </button>
            <button className="onb-btn" disabled>
              Print
            </button>
            <button className="onb-btn" disabled>
              Save QR
            </button>
          </div>
        </div>
      </div>

      <div className="onb-callout">
        <strong>Optional — but recommended.</strong> If you skip this, encryption still
        works; you just can't catch a server impersonating someone.
      </div>

      {recoveryKey && (
        <>
          <h2 className="onb-title" style={{ marginTop: 24, fontSize: '1.1rem' }}>
            Recovery key
          </h2>
          <p className="onb-blurb">
            Write this down or store it in a password manager. It's the only way back into
            your identity if you lose access to your passphrase and your passkey.
          </p>
          <div className="onb-fp">
            <div className="onb-fp-label">RECOVERY KEY · SHOWN ONCE</div>
            <div className="onb-fp-text" style={{ wordBreak: 'break-all', userSelect: 'all' }}>
              {recoveryKey}
            </div>
            <div className="onb-fp-actions">
              <button
                className="onb-btn"
                onClick={() => {
                  navigator.clipboard?.writeText(recoveryKey);
                  setCopiedRk(true);
                  setTimeout(() => setCopiedRk(false), 1500);
                }}
              >
                {copiedRk ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginTop: 12,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={recoveryConfirmed}
              onChange={(e) => setRecoveryConfirmed(e.target.checked)}
            />
            I've saved my recovery key somewhere safe.
          </label>
        </>
      )}

      <div className="onb-actions">
        <button className="onb-btn" onClick={onBack}>
          Back
        </button>
        <button
          className="onb-btn primary"
          onClick={onNext}
          disabled={!!recoveryKey && !recoveryConfirmed}
        >
          {recoveryKey ? "I've saved both" : "I've saved it"}
        </button>
      </div>
    </>
  );
}

// ───────── Step 5: Done ─────────
function DoneStep({ username, team, mode, onOpen }) {
  return (
    <>
      <h1 className="onb-title">You're in.</h1>
      <p className="onb-blurb">
        Identity created and bound to <strong>{team}</strong> on this device.
      </p>

      <div className="onb-summary">
        <div className="onb-sum-row">
          <span className="onb-sum-k">handle</span>
          <span className="onb-sum-v">{username}</span>
        </div>
        <div className="onb-sum-row">
          <span className="onb-sum-k">team</span>
          <span className="onb-sum-v">{team}</span>
        </div>
        <div className="onb-sum-row">
          <span className="onb-sum-k">role</span>
          <span className="onb-sum-v">
            {mode === 'bootstrap' ? (
              <>
                admin <span className="onb-pill">first user</span>
              </>
            ) : (
              'member'
            )}
          </span>
        </div>
        <div className="onb-sum-row">
          <span className="onb-sum-k">e2e</span>
          <span className="onb-sum-v">signal-protocol · x3dh + double-ratchet</span>
        </div>
      </div>

      <div className="onb-actions">
        <span />
        <button type="button" className="onb-btn primary" onClick={onOpen}>
          Open Dilla →
        </button>
      </div>
    </>
  );
}
