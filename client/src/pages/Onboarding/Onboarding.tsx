import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
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

const KEYS_LOG: LogLine[] = [
  { text: '> generating ed25519 keypair', level: 'info' },
  { text: '> ✓ keypair generated', level: 'ok' },
  { text: '> deriving symmetric key via argon2id', level: 'info' },
  { text: '> ✓ symmetric key derived', level: 'ok' },
  { text: '> uploading prekey bundle (X3DH)', level: 'info' },
  { text: '> ✓ prekey bundle uploaded', level: 'ok' },
  { text: '> ready', level: 'ok' },
];

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
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('connect');

  // Connect step state
  const [connectMode, setConnectMode] = useState<'bootstrap' | 'invite' | 'enrolled'>(
    'invite',
  );
  const [serverUrl, setServerUrl] = useState('');
  const [token, setToken] = useState('');
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectLog, setConnectLog] = useState<LogLine[]>([]);

  // Identity step state
  const [username, setUsername] = useState('');
  const [protection, setProtection] = useState<'passphrase' | 'hardware' | 'both'>(
    'passphrase',
  );

  // Keys step state (animated log)
  const [keysShown, setKeysShown] = useState(0);
  const keysIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Auto-advance keys step
  useEffect(() => {
    if (step !== 'keys') return;
    setKeysShown(1);
    keysIntervalRef.current = setInterval(() => {
      setKeysShown((n) => {
        if (n >= KEYS_LOG.length) {
          if (keysIntervalRef.current) clearInterval(keysIntervalRef.current);
          // Auto-advance to safety after a brief pause
          setTimeout(() => setStep('safety'), 600);
          return n;
        }
        return n + 1;
      });
    }, 280);
    return () => {
      if (keysIntervalRef.current) clearInterval(keysIntervalRef.current);
    };
  }, [step]);

  const handleConnect = () => {
    setConnectError(null);
    // Simulate validation — tokens with "invalid"/"bad"/"expired" trigger error path
    const t = token.toLowerCase();
    if (t.includes('invalid') || t.includes('bad') || t.includes('expired')) {
      setConnectError('Token rejected by server. Check with whoever sent it.');
      setConnectLog([
        { text: `> contacting ${serverUrl || 'unknown server'}`, level: 'info' },
        { text: '> token rejected (invalid or expired)', level: 'danger' },
      ]);
      return;
    }
    setConnectLog([
      { text: `> contacting ${serverUrl || 'unknown server'}`, level: 'info' },
      { text: '> ✓ server accepted invite', level: 'ok' },
      { text: '> advancing…', level: 'info' },
    ]);
    setTimeout(() => setStep('identity'), 600);
  };

  const handleIdentity = () => {
    if (!username.trim()) return;
    setStep('keys');
  };

  const handleSafety = () => {
    setStep('done');
  };

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

              {connectMode !== 'enrolled' && (
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
                disabled={!serverUrl.trim() || (connectMode !== 'enrolled' && !token.trim())}
              >
                Continue →
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

            {protection !== 'passphrase' && (
              <div className="onboarding-hardware">
                <div className="onboarding-tap-animation">
                  <div className="onboarding-tap-ripple" />
                  <span>TAP YOUR KEY</span>
                </div>
                <div className="onboarding-hardware-chips">
                  <span className="onboarding-hardware-chip">USB</span>
                  <span className="onboarding-hardware-chip">OS</span>
                  <span className="onboarding-hardware-chip">PASSKEY</span>
                </div>
              </div>
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
                disabled={!username.trim()}
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
              Hold tight — this happens locally and is never shared with the server.
            </p>

            <div className="onboarding-log large">
              {KEYS_LOG.slice(0, keysShown).map((line) => (
                <div key={line.text} className={`onboarding-log-line ${line.level}`}>
                  {line.text}
                </div>
              ))}
              {keysShown < KEYS_LOG.length && (
                <div className="onboarding-log-line info">
                  <span className="onboarding-spinner" aria-hidden="true">_</span>
                </div>
              )}
            </div>
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
                57842 19034 88291 60017<br />
                33920 11458 90442 17763
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
                onClick={() => navigate('/app')}
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
