import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore, type User } from '../../stores/authStore';
import { api } from '../../services/api';
import {
  createIdentityWithPassphrase,
  hasIdentity,
  signChallenge,
  exportIdentityBlob,
  unlockWithPassphrase,
} from '../../services/keyStore';
import { refreshServerTokens, tryReconnectToCurrentServer } from '../../services/authReconnect';
import { initCrypto, getIdentityKeys } from '../../services/crypto';
import { fromBase64 } from '../../services/cryptoCore';
import {
  normalizeServerUrl,
  uploadPrekeyBundle,
  activateTeamAndNavigate,
} from '../../utils/serverConnection';
import { friendlyError } from '../../utils/errorMessages';
import './Onboarding.css';

type Step = 'connect' | 'identity' | 'keys' | 'safety' | 'done';

const STEP_ORDER: Step[] = ['connect', 'identity', 'keys', 'safety', 'done'];
const STEP_LABEL: Record<Step, string> = {
  connect: 'CONNECT',
  identity: 'IDENTITY',
  keys: 'KEYS',
  safety: 'SAFETY',
  done: 'DONE',
};

interface LogLine {
  text: string;
  level: 'info' | 'ok' | 'danger';
}

// Visible progress log for the keys step. Lines are pushed as each phase
// of identity creation + server registration completes, so the user sees
// real activity instead of a fake animation. The 'ready' line fires when
// the team is fully enrolled and we're about to advance to safety.
const KEYS_INITIAL: LogLine[] = [];

function StepBadge({ step, currentStep }: { step: Step; currentStep: Step }) {
  const order = STEP_ORDER.indexOf(step);
  const current = STEP_ORDER.indexOf(currentStep);
  const status = order < current ? 'done' : order === current ? 'active' : 'pending';
  return (
    <div className={`onboarding-step-badge ${status}`}>
      <span className="onboarding-step-num">{order + 1}</span>
      <span className="onboarding-step-name">{STEP_LABEL[step]}</span>
    </div>
  );
}

export default function Onboarding() {
  const { t: i18n } = useTranslation();
  const navigate = useNavigate();
  const { setDerivedKey, setPublicKey, addTeam } = useAuthStore();
  const [step, setStep] = useState<Step>('connect');

  // Connect step state
  const [connectMode, setConnectMode] = useState<'bootstrap' | 'invite' | 'enrolled'>(
    'invite',
  );
  const [serverUrl, setServerUrl] = useState('');
  const [token, setToken] = useState('');
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectLog, setConnectLog] = useState<LogLine[]>([]);
  const [teamInfo, setTeamInfo] = useState<{ team_name?: string; created_by?: string } | null>(
    null,
  );

  // Identity step state
  const [username, setUsername] = useState('');
  const [protection, setProtection] = useState<'passphrase' | 'hardware' | 'both'>(
    'passphrase',
  );
  const [passphrase, setPassphrase] = useState('');
  const [passphraseConfirm, setPassphraseConfirm] = useState('');
  const [teamName, setTeamName] = useState('');
  const [identityError, setIdentityError] = useState<string | null>(null);

  // Keys step state — driven by real progress, not a timed animation.
  const [keysLog, setKeysLog] = useState<LogLine[]>(KEYS_INITIAL);
  const [keysError, setKeysError] = useState<string | null>(null);
  const keysStartedRef = useRef(false);

  // Safety step — real fingerprint derived from the new identity's public key.
  const [fingerprint, setFingerprint] = useState('');
  const enrolledTeamIdRef = useRef<string | null>(null);

  const passphraseValid = passphrase.length >= 12 && passphrase === passphraseConfirm;

  function appendKeysLog(line: LogLine) {
    setKeysLog((prev) => [...prev, line]);
  }

  // Real connect: invite mode validates against the server. Bootstrap and
  // enrolled modes are stubs awaiting their own wiring passes (the existing
  // /setup and /login routes still cover those flows for now).
  const handleConnect = async () => {
    setConnectError(null);
    setConnectLog([]);
    if (!serverUrl.trim()) return;

    const url = normalizeServerUrl(serverUrl);
    setConnectLog((prev) => [...prev, { text: `> contacting ${url}`, level: 'info' }]);

    if (connectMode === 'enrolled') {
      // Already-enrolled is fundamentally a login flow — no token, no
      // identity creation, no safety step. Unlock with the entered
      // passphrase, refresh server tokens against persisted teams, then
      // jump straight to /app (or /join if no teams survived).
      if (!passphrase) {
        setConnectError('Enter your passphrase to unlock your identity.');
        return;
      }
      try {
        setConnectLog((prev) => [...prev, { text: '> unlocking identity', level: 'info' }]);
        const identity = await unlockWithPassphrase(passphrase);
        // Match Login.tsx: passphrase-derived key for session crypto. Hash
        // is the first 32 bytes of the passphrase, base64-encoded.
        const passphraseKeyB64 = btoa(
          String.fromCodePoint(...new TextEncoder().encode(passphrase.slice(0, 32))),
        );
        await initCrypto(identity, passphraseKeyB64);

        const pubKeyB64 = btoa(String.fromCodePoint(...identity.publicKeyBytes));
        setDerivedKey(passphraseKeyB64);
        setPublicKey(pubKeyB64);

        setConnectLog((prev) => [
          ...prev,
          { text: '> ✓ identity unlocked', level: 'ok' },
          { text: '> refreshing server tokens', level: 'info' },
        ]);
        await refreshServerTokens(useAuthStore.getState().teams, pubKeyB64);
        const hasTeams =
          useAuthStore.getState().teams.size > 0 ||
          (await tryReconnectToCurrentServer(pubKeyB64));
        setConnectLog((prev) => [
          ...prev,
          { text: hasTeams ? '> ✓ reconnected' : '> no teams found', level: 'ok' },
        ]);
        navigate(hasTeams ? '/app' : '/join');
      } catch (e) {
        setConnectError(friendlyError(e, i18n));
      }
      return;
    }

    if (connectMode === 'bootstrap') {
      // No pre-flight API call exists for the bootstrap token (it's
      // validated atomically by api.bootstrap). Just confirm the server is
      // reachable; actual token validation happens in the keys step.
      try {
        const res = await fetch(`${url}/api/v1/health`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        setConnectLog((prev) => [
          ...prev,
          { text: '> ✓ server reachable', level: 'ok' },
          { text: '> advancing… (bootstrap token will be validated next)', level: 'info' },
        ]);
        setTimeout(() => setStep('identity'), 600);
      } catch (e) {
        setConnectError(friendlyError(e, i18n));
        setConnectLog((prev) => [...prev, { text: '> server unreachable', level: 'danger' }]);
      }
      return;
    }

    try {
      const info = (await api.getInviteInfo(url, token)) as {
        team_name?: string;
        created_by?: string;
      };
      setTeamInfo(info);
      setConnectLog((prev) => [
        ...prev,
        { text: '> ✓ invite accepted', level: 'ok' },
        ...(info.team_name ? [{ text: `> team: ${info.team_name}`, level: 'ok' as const }] : []),
        { text: '> advancing…', level: 'info' },
      ]);
      setTimeout(() => setStep('identity'), 600);
    } catch (e) {
      setConnectError(friendlyError(e, i18n));
      setConnectLog((prev) => [...prev, { text: '> token rejected', level: 'danger' }]);
    }
  };

  const handleIdentity = () => {
    setIdentityError(null);
    if (!username.trim()) {
      setIdentityError('Pick a username.');
      return;
    }
    if (connectMode === 'bootstrap' && !teamName.trim()) {
      setIdentityError('Team name is required when bootstrapping a new server.');
      return;
    }
    if (protection === 'passphrase') {
      if (!passphraseValid) {
        setIdentityError(
          passphrase.length < 12
            ? 'Passphrase needs to be at least 12 characters.'
            : 'Passphrase confirmation does not match.',
        );
        return;
      }
    } else {
      setIdentityError(
        'Hardware-key onboarding is not wired yet. Choose Passphrase to continue.',
      );
      return;
    }
    setStep('keys');
  };

  const handleSafety = () => {
    setStep('done');
  };

  // Keys step: when entered, run the real enrollment flow:
  //   1. Create identity in IndexedDB (Ed25519 + Argon2id-derived AES key)
  //   2. initCrypto(...) so cryptoService can sign challenges
  //   3. Request a server challenge, sign it
  //   4. api.register(...) with the invite token → team joined
  //   5. uploadPrekeyBundle(...) for E2E channel keys
  //   6. exportIdentityBlob → upload for cross-device recovery (best-effort)
  // Once enrolled the user's public-key fingerprint is captured and shown
  // in the safety step before they finally land in /app.
  useEffect(() => {
    if (step !== 'keys') return;
    if (keysStartedRef.current) return;
    keysStartedRef.current = true;

    (async () => {
      const url = normalizeServerUrl(serverUrl);
      try {
        // Step 1: identity (only if not already created — guard against
        // /onboarding re-entry after a prior abandoned run).
        appendKeysLog({ text: '> generating ed25519 keypair', level: 'info' });
        const alreadyHasIdentity = await hasIdentity();
        if (alreadyHasIdentity) {
          appendKeysLog({ text: '> ✓ existing identity unlocked', level: 'ok' });
        } else {
          appendKeysLog({ text: '> deriving symmetric key via argon2id', level: 'info' });
        }
        const { publicKeyB64, publicKeyHex, identity } = alreadyHasIdentity
          ? { publicKeyB64: '', publicKeyHex: '', identity: undefined }
          : await createIdentityWithPassphrase(url, passphrase, []);
        if (alreadyHasIdentity) {
          appendKeysLog({ text: '> ✓ keypair ready', level: 'ok' });
        } else {
          appendKeysLog({ text: '> ✓ keypair generated', level: 'ok' });
          appendKeysLog({ text: '> ✓ symmetric key derived', level: 'ok' });
        }

        // initCrypto requires both identity + derivedKey. For passphrase-
        // protected accounts the derivedKey is the public key (matches the
        // legacy CreateIdentity passphrase flow).
        const derivedKey = publicKeyB64;
        if (identity) await initCrypto(identity, derivedKey);
        setPublicKey(publicKeyB64);
        setDerivedKey(derivedKey);

        // Step 2: register with the team via invite.
        appendKeysLog({ text: '> requesting server challenge', level: 'info' });
        const tempId = url;
        api.addTeam(tempId, url);
        const { challenge_id, nonce } = await api.requestChallenge(tempId, publicKeyB64);
        const nonceBytes = fromBase64(nonce);
        const keys = getIdentityKeys();
        const sig = await signChallenge(keys.signingKey, nonceBytes);
        const sigB64 = btoa(String.fromCodePoint(...sig));

        appendKeysLog({ text: '> signing challenge', level: 'info' });
        const result =
          connectMode === 'bootstrap'
            ? ((await api.bootstrap(
                tempId,
                challenge_id,
                publicKeyB64,
                sigB64,
                username.trim(),
                token,
                teamName.trim() || undefined,
              )) as { user: User; token: string; team?: Record<string, unknown> | null })
            : ((await api.register(
                tempId,
                challenge_id,
                publicKeyB64,
                sigB64,
                username.trim(),
                token,
              )) as { user: User; token: string; team?: Record<string, unknown> | null });

        const realTeamId = (result.team?.id as string) || tempId;
        if (realTeamId !== tempId) {
          api.removeTeam(tempId);
          api.addTeam(realTeamId, url);
        }
        api.setToken(realTeamId, result.token);
        addTeam(
          realTeamId,
          result.token,
          result.user,
          (result.team ?? teamInfo ?? {}) as Record<string, unknown>,
          url,
        );
        enrolledTeamIdRef.current = realTeamId;
        appendKeysLog({ text: '> ✓ enrolled in team', level: 'ok' });

        // Step 3: prekey bundle + identity blob (best-effort).
        appendKeysLog({ text: '> uploading prekey bundle (X3DH)', level: 'info' });
        await uploadPrekeyBundle(derivedKey, realTeamId);
        appendKeysLog({ text: '> ✓ prekey bundle uploaded', level: 'ok' });
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
            appendKeysLog({ text: '> ✓ identity blob backed up', level: 'ok' });
          }
        } catch {
          // Non-fatal — recovery just won't work via this server.
        }

        // Fingerprint for the safety step.
        setFingerprint(publicKeyHex.match(/.{1,4}/g)?.slice(0, 8).join(' ') ?? publicKeyHex);
        appendKeysLog({ text: '> ready', level: 'ok' });
        setTimeout(() => setStep('safety'), 600);
      } catch (e) {
        const msg = friendlyError(e, i18n);
        appendKeysLog({ text: `> error: ${msg}`, level: 'danger' });
        setKeysError(msg);
        keysStartedRef.current = false; // allow retry by re-entering keys step
      }
    })();
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="onboarding">
      <header className="onboarding-header">
        <div className="onboarding-brand">
          <span className="onboarding-tile" aria-hidden="true">D</span>
          <span className="onboarding-word">DILLA</span>
          <span className="onboarding-caret">_</span>
        </div>
        <nav className="onboarding-steps" aria-label="Onboarding progress">
          {STEP_ORDER.map((s) => (
            <StepBadge key={s} step={s} currentStep={step} />
          ))}
        </nav>
      </header>

      <main className="onboarding-body">
        {step === 'connect' && (
          <section className="onboarding-step">
            <h1 className="onboarding-title">Connect to a mesh node</h1>
            <p className="onboarding-subtitle">
              Choose how this device joins the network.
            </p>

            <div className="onboarding-toggle">
              {(['bootstrap', 'invite', 'enrolled'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`onboarding-toggle-btn ${connectMode === m ? 'active' : ''}`}
                  onClick={() => setConnectMode(m)}
                >
                  {m === 'bootstrap'
                    ? 'BOOTSTRAP NEW'
                    : m === 'invite'
                      ? 'JOIN VIA INVITE'
                      : 'ALREADY ENROLLED'}
                </button>
              ))}
            </div>

            <div className="onboarding-form">
              {connectMode === 'enrolled' ? (
                <label className="onboarding-label">
                  Passphrase
                  <input
                    type="password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    placeholder="your passphrase"
                    className="onboarding-input"
                    autoFocus
                  />
                </label>
              ) : (
                <>
                  <label className="onboarding-label">
                    Server URL
                    <input
                      type="url"
                      value={serverUrl}
                      onChange={(e) => setServerUrl(e.target.value)}
                      placeholder="https://gbg-1.dilla.local"
                      className="onboarding-input"
                    />
                  </label>

                  <label className="onboarding-label">
                    {connectMode === 'invite' ? 'Invite token' : 'Bootstrap token'}
                    <input
                      type="text"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder="paste token here"
                      className="onboarding-input"
                    />
                  </label>
                </>
              )}
            </div>

            {connectError && (
              <div className="onboarding-callout danger">{connectError}</div>
            )}

            {connectLog.length > 0 && (
              <div className="onboarding-log">
                {connectLog.map((line) => (
                  <div key={line.text} className={`onboarding-log-line ${line.level}`}>
                    {line.text}
                  </div>
                ))}
              </div>
            )}

            <div className="onboarding-actions">
              <button
                type="button"
                className="onboarding-btn primary"
                onClick={handleConnect}
                disabled={
                  connectMode === 'enrolled'
                    ? !passphrase
                    : !serverUrl.trim() || !token.trim()
                }
              >
                {connectMode === 'enrolled' ? 'Unlock →' : 'Continue →'}
              </button>
            </div>
          </section>
        )}

        {step === 'identity' && (
          <section className="onboarding-step">
            <h1 className="onboarding-title">Pick a handle and protection</h1>
            <p className="onboarding-subtitle">
              Your handle is public. Your keys are protected by what you choose here.
            </p>

            <label className="onboarding-label">
              Username
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="@you"
                className="onboarding-input"
                autoFocus
              />
            </label>

            {connectMode === 'bootstrap' && (
              <label className="onboarding-label">
                Team name
                <input
                  type="text"
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  placeholder="berralitos"
                  className="onboarding-input"
                />
              </label>
            )}

            <div className="onboarding-toggle">
              {(['passphrase', 'hardware', 'both'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`onboarding-toggle-btn ${protection === m ? 'active' : ''}`}
                  onClick={() => setProtection(m)}
                >
                  {m.toUpperCase()}
                </button>
              ))}
            </div>

            {protection === 'passphrase' ? (
              <>
                <label className="onboarding-label">
                  Passphrase
                  <input
                    type="password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    placeholder="at least 12 characters"
                    className="onboarding-input"
                  />
                </label>
                <label className="onboarding-label">
                  Confirm passphrase
                  <input
                    type="password"
                    value={passphraseConfirm}
                    onChange={(e) => setPassphraseConfirm(e.target.value)}
                    className="onboarding-input"
                  />
                </label>
                <div className="onboarding-callout">
                  Argon2id-derived AES-256-GCM key seals your private key on disk.
                  Dilla never sees the passphrase — losing it locks you out permanently.
                </div>
              </>
            ) : (
              <div className="onboarding-hardware">
                <div className="onboarding-tap-animation">
                  <div className="onboarding-tap-ripple" />
                  <span>HARDWARE-KEY ONBOARDING — COMING SOON</span>
                </div>
                <div className="onboarding-callout warn">
                  Passkey + WebAuthn enrollment is not wired into this flow yet.
                  Choose Passphrase to continue, or use /create-identity-legacy.
                </div>
              </div>
            )}

            {identityError && (
              <div className="onboarding-callout danger">{identityError}</div>
            )}

            <div className="onboarding-actions">
              <button
                type="button"
                className="onboarding-btn secondary"
                onClick={() => setStep('connect')}
              >
                ← Back
              </button>
              <button
                type="button"
                className="onboarding-btn primary"
                onClick={handleIdentity}
                disabled={
                  !username.trim() ||
                  (connectMode === 'bootstrap' && !teamName.trim()) ||
                  (protection === 'passphrase' && !passphraseValid)
                }
              >
                Continue →
              </button>
            </div>
          </section>
        )}

        {step === 'keys' && (
          <section className="onboarding-step">
            <h1 className="onboarding-title">Generating keys</h1>
            <p className="onboarding-subtitle">
              Identity creation and registration happen locally — the server only sees
              your public key and a signature it asked for.
            </p>

            <div className="onboarding-log large">
              {keysLog.map((line, i) => (
                <div key={`${i}:${line.text}`} className={`onboarding-log-line ${line.level}`}>
                  {line.text}
                </div>
              ))}
              {!keysError && (
                <div className="onboarding-log-line info">
                  <span className="onboarding-spinner" aria-hidden="true">_</span>
                </div>
              )}
            </div>

            {keysError && (
              <div className="onboarding-actions">
                <button
                  type="button"
                  className="onboarding-btn secondary"
                  onClick={() => {
                    setKeysError(null);
                    setKeysLog([]);
                    setStep('identity');
                  }}
                >
                  ← Back to identity
                </button>
              </div>
            )}
          </section>
        )}

        {step === 'safety' && (
          <section className="onboarding-step">
            <h1 className="onboarding-title">Your safety number</h1>
            <p className="onboarding-subtitle">
              Share this with peers you talk to. They can compare it to confirm
              your identity hasn't been swapped.
            </p>

            <div className="onboarding-safety">
              <div className="onboarding-safety-grid" aria-label="Safety number visual">
                {Array.from({ length: 36 }).map((_, i) => (
                  <span
                    key={i}
                    className={`onboarding-safety-cell ${i % 3 === 0 ? 'on' : ''}`}
                  />
                ))}
              </div>
              <div className="onboarding-safety-number">
                {fingerprint || '— fingerprint unavailable —'}
              </div>
              <div className="onboarding-safety-actions">
                <button type="button" className="onboarding-btn secondary">
                  Copy
                </button>
                <button type="button" className="onboarding-btn secondary">
                  Print
                </button>
                <button type="button" className="onboarding-btn secondary">
                  Save QR
                </button>
              </div>
            </div>

            <div className="onboarding-callout warn">
              Verify in person whenever you can. Anyone who can swap your key
              can read messages addressed to you.
            </div>

            <div className="onboarding-actions">
              <button
                type="button"
                className="onboarding-btn primary"
                onClick={handleSafety}
              >
                I've stored it →
              </button>
            </div>
          </section>
        )}

        {step === 'done' && (
          <section className="onboarding-step">
            <h1 className="onboarding-title">All set</h1>
            <p className="onboarding-subtitle">
              You're enrolled on the mesh. Welcome.
            </p>

            <table className="onboarding-summary">
              <tbody>
                <tr>
                  <td className="onboarding-summary-key">handle</td>
                  <td>@{username || 'you'}</td>
                </tr>
                <tr>
                  <td className="onboarding-summary-key">team</td>
                  <td>{serverUrl.replace(/^https?:\/\//, '') || 'unknown'}</td>
                </tr>
                <tr>
                  <td className="onboarding-summary-key">role</td>
                  <td>member</td>
                </tr>
                <tr>
                  <td className="onboarding-summary-key">e2e</td>
                  <td>SIGNAL · X3DH · AES-256-GCM</td>
                </tr>
                <tr>
                  <td className="onboarding-summary-key">node</td>
                  <td>{serverUrl.replace(/^https?:\/\//, '') || '—'}</td>
                </tr>
              </tbody>
            </table>

            <div className="onboarding-actions">
              <button
                type="button"
                className="onboarding-btn primary"
                onClick={async () => {
                  const teamId = enrolledTeamIdRef.current;
                  if (teamId) {
                    await activateTeamAndNavigate(teamId, navigate);
                  } else {
                    navigate('/app');
                  }
                }}
              >
                Open Dilla →
              </button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
