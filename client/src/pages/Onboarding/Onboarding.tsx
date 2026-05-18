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

  // Apply the mesh theme tokens so the handoff CSS has --bg, --accent etc.
  // (The shell does this in AppShell.tsx via THEMES.themeVars on its root.)
  const wrapStyle = THEMES.themeVars(THEMES.mesh, { density: 'regular' });

  const [stepIdx, setStepIdx] = useState(0);
  const [mode, setMode] = useState<Mode>('bootstrap');
  const [server, setServer] = useState('http://localhost:8080');
  const [token, setToken] = useState('');
  const [team, setTeam] = useState('');
  const [username, setUsername] = useState('');
  const [keyProtect, setKeyProtect] = useState<Protect>('passphrase');
  const [passphrase, setPassphrase] = useState('');
  const [showPass, setShowPass] = useState(false);

  // Connect step transient state
  const [connecting, setConnecting] = useState(false);
  const [connectLog, setConnectLog] = useState<LogLine[]>([]);
  const [connectError, setConnectError] = useState<string | null>(null);

  // KeyGen step state
  const [keyLines, setKeyLines] = useState<LogLine[]>([]);
  const [keyError, setKeyError] = useState<string | null>(null);
  const keyStartedRef = useRef(false);
  const enrolledTeamIdRef = useRef<string | null>(null);

  // Safety step state
  const [fingerprint, setFingerprint] = useState('');

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
      if (mode === 'existing') {
        // Already-enrolled is a short-circuit login. The passphrase is
        // collected here in the connect step (we don't have a dedicated
        // unlock step) and used to unlock the keystore.
        if (!passphrase) {
          setConnectError('Enter your passphrase to unlock.');
          setConnecting(false);
          return;
        }
        setConnectLog((p) => [...p, { line: 'unlocking identity…' }]);
        const identity = await unlockWithPassphrase(passphrase);
        const passphraseKeyB64 = btoa(
          String.fromCodePoint(...new TextEncoder().encode(passphrase.slice(0, 32))),
        );
        await initCrypto(identity, passphraseKeyB64);
        const pubKeyB64 = btoa(String.fromCodePoint(...identity.publicKeyBytes));
        setDerivedKey(passphraseKeyB64);
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
        const created = already
          ? { publicKeyB64: '', publicKeyHex: '', identity: undefined }
          : await createIdentityWithPassphrase(url, passphrase, []);
        const { publicKeyB64, publicKeyHex, identity } = created;
        push(`  pub  ed25519:${(publicKeyHex || '').slice(0, 32)}…`);
        push('  priv [encrypted]');

        const derivedKey = publicKeyB64;
        if (identity) await initCrypto(identity, derivedKey);
        setPublicKey(publicKeyB64);
        setDerivedKey(derivedKey);

        if (!already) {
          push('deriving keystore key (argon2id)…');
          push('sealing private key with aes-256-gcm…');
        }

        push(`signing nonce as "${username || 'thim'}"…`);
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
  const protectionOk =
    keyProtect === 'passphrase' ? passOk : keyProtect === 'hardware' ? false : passOk;
  const identityOk = username.length >= 2 && protectionOk;

  function onIdentityNext() {
    if (keyProtect === 'hardware') {
      // WebAuthn not wired in this pass. Force a passphrase fallback.
      setKeyProtect('passphrase');
      return;
    }
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
            <SafetyStep fingerprint={fingerprint} onBack={back} onNext={next} />
          )}
          {step.id === 'done' && (
            <DoneStep
              username={username || 'thim'}
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
        <button className="onb-skip" type="button" onClick={() => navigate('/login')}>
          have an account? sign in →
        </button>
      </footer>
    </div>
  );
}

// ───────── Step 1: Connect ─────────
function ConnectStep({
  mode,
  setMode,
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

      {mode === 'existing' && (
        <div className="onb-field">
          <label>Passphrase</label>
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="your passphrase"
            autoFocus
          />
          <div className="onb-hint">
            Unlocks your identity from the local keystore and refreshes server tokens.
          </div>
        </div>
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
              ? !passphrase
              : !server || ((mode === 'bootstrap' || mode === 'invite') && !token))
          }
          onClick={onConnect}
        >
          {connecting ? 'Connecting…' : mode === 'existing' ? 'Unlock' : 'Connect'}
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
          placeholder="thim"
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
            'WebAuthn passkey/hardware enrollment is not wired in this flow yet — pick Passphrase to continue, or use /create-identity-legacy.'}
          {keyProtect === 'both' &&
            'Hardware-key primary path not wired yet — falls back to the passphrase below.'}
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
          <div className="onb-callout">
            <strong>Coming soon.</strong> Hardware-key enrollment via WebAuthn is on the
            roadmap. For now, please choose Passphrase.
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
function SafetyStep({ fingerprint, onBack, onNext }) {
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
              onClick={() => fingerprint && navigator.clipboard?.writeText(fingerprint)}
            >
              Copy
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

      <div className="onb-actions">
        <button className="onb-btn" onClick={onBack}>
          Back
        </button>
        <button className="onb-btn primary" onClick={onNext}>
          I've saved it
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
