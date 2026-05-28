import { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import './AddPeerWizard.css';

type WizardStep = 'token' | 'confirm' | 'handshake' | 'done';

const STEP_ORDER: WizardStep[] = ['token', 'confirm', 'handshake', 'done'];
const STEP_LABEL: Record<WizardStep, string> = {
  token: 'TOKEN',
  confirm: 'CONFIRM',
  handshake: 'HANDSHAKE',
  done: 'DONE',
};

function wizardStepStatus(idx: number, currentIdx: number): string {
  if (idx < currentIdx) return 'done';
  if (idx === currentIdx) return 'active';
  return 'pending';
}

interface Props {
  open: boolean;
  onClose: () => void;
  onComplete?: (peer: { url: string; label: string }) => void;
}

const HANDSHAKE_LOG = [
  '> resolving peer endpoint',
  '> ✓ resolved',
  '> initiating noise XK handshake',
  '> ✓ noise XK complete',
  '> exchanging mesh credentials',
  '> ✓ credentials verified',
  '> registering bidirectional sync',
  '> ✓ peer added',
];

export default function AddPeerWizard({ open, onClose, onComplete }: Readonly<Props>) {
  const [step, setStep] = useState<WizardStep>('token');
  const [tokenInput, setTokenInput] = useState('');
  const [peerUrl, setPeerUrl] = useState('');
  const [logLines, setLogLines] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Reset on open
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset of form state when modal reopens
      setStep('token');
      setTokenInput('');
      setPeerUrl('');
      setLogLines(0);
    }
  }, [open]);

  // Auto-run handshake animation
  useEffect(() => {
    if (step !== 'handshake') return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset when entering handshake phase
    setLogLines(0);
    intervalRef.current = setInterval(() => {
      setLogLines((n) => {
        if (n >= HANDSHAKE_LOG.length) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          setTimeout(() => setStep('done'), 500);
          return n;
        }
        return n + 1;
      });
    }, 320);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [step]);

  // Esc to close (except mid-handshake)
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && step !== 'handshake') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, step, onClose]);

  if (!open) return null;

  const handleParseToken = () => {
    // Mock: pull a "peer-url" out of the token (anything after the last @ or whole string)
    const cleaned = tokenInput.trim();
    if (!cleaned) return;
    const lastAt = cleaned.lastIndexOf('@');
    const url = lastAt >= 0 ? cleaned.slice(lastAt + 1) : cleaned;
    setPeerUrl(url || 'unknown-peer');
    setStep('confirm');
  };

  const body = (
    <button
      type="button"
      className="add-peer-overlay"
      aria-label="Close add peer wizard"
      onClick={() => {
        if (step !== 'handshake') onClose();
      }}
    >
      <dialog
        open
        aria-label="Add federation peer"
        className="add-peer"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <header className="add-peer-header">
          <div className="add-peer-eyebrow">FEDERATION</div>
          <h2 className="add-peer-title">Add a peer node</h2>
          <nav className="add-peer-steps" aria-label="Wizard progress">
            {STEP_ORDER.map((s, i) => {
              const currentIdx = STEP_ORDER.indexOf(step);
              const status = wizardStepStatus(i, currentIdx);
              return (
                <span key={s} className={`add-peer-step ${status}`}>
                  <span className="add-peer-step-num">{i + 1}</span>
                  <span className="add-peer-step-name">{STEP_LABEL[s]}</span>
                </span>
              );
            })}
          </nav>
        </header>

        <div className="add-peer-body">
          {step === 'token' && (
            <>
              <p className="add-peer-subtitle">
                Paste the federation token you received from the other node's admin.
              </p>
              <label className="add-peer-label">
                <span>Token</span>
                <textarea
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder="peer-token-xxxxxxxxxxxxxxxx@peer.example.local"
                  rows={4}
                  className="add-peer-textarea"
                  autoFocus
                />
              </label>
              <div className="add-peer-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={onClose}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={handleParseToken}
                  disabled={!tokenInput.trim()}
                >
                  Parse →
                </button>
              </div>
            </>
          )}

          {step === 'confirm' && (
            <>
              <p className="add-peer-subtitle">
                Confirm this is the node you intend to peer with.
              </p>
              <div className="add-peer-confirm-card">
                <div className="add-peer-confirm-row">
                  <span className="add-peer-confirm-key">node</span>
                  <span className="add-peer-confirm-value">{peerUrl}</span>
                </div>
                <div className="add-peer-confirm-row">
                  <span className="add-peer-confirm-key">protocol</span>
                  <span className="add-peer-confirm-value">noise XK + WebSocket</span>
                </div>
                <div className="add-peer-confirm-row">
                  <span className="add-peer-confirm-key">sync</span>
                  <span className="add-peer-confirm-value">bidirectional, lamport-ordered</span>
                </div>
              </div>
              <div className="add-peer-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => setStep('token')}
                >
                  ← Back
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => setStep('handshake')}
                >
                  Begin handshake →
                </button>
              </div>
            </>
          )}

          {step === 'handshake' && (
            <>
              <p className="add-peer-subtitle">Running handshake — please wait.</p>
              <div className="add-peer-log">
                {HANDSHAKE_LOG.slice(0, logLines).map((line) => (
                  <div
                    key={line}
                    className={`add-peer-log-line ${line.includes('✓') ? 'ok' : 'info'}`}
                  >
                    {line}
                  </div>
                ))}
                {logLines < HANDSHAKE_LOG.length && (
                  <div className="add-peer-log-line info">
                    <span className="add-peer-spinner" aria-hidden="true">_</span>
                  </div>
                )}
              </div>
            </>
          )}

          {step === 'done' && (
            <>
              <p className="add-peer-subtitle">Peer is online and replicating.</p>
              <div className="add-peer-success">
                <div className="add-peer-success-tick">✓</div>
                <div className="add-peer-success-label">{peerUrl}</div>
              </div>
              <div className="add-peer-actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => {
                    onComplete?.({ url: peerUrl, label: peerUrl });
                    onClose();
                  }}
                >
                  Close
                </button>
              </div>
            </>
          )}
        </div>
      </dialog>
    </button>
  );

  return createPortal(body, document.body);
}
