import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import './SafetyCompare.css';

interface Props {
  open: boolean;
  /** Your fingerprint as a 40-char hex string (or any string ≥ 32 chars) */
  yours: string;
  /** Their fingerprint */
  theirs: string;
  yourName: string;
  theirName: string;
  onClose: () => void;
  onMarkVerified: () => void;
  onMarkMismatch: () => void;
}

/** Chunk a fingerprint string into N-char blocks for visual comparison. */
function chunkFingerprint(fp: string, size = 5): string[] {
  const clean = fp.replace(/\s+/g, '');
  const out: string[] = [];
  for (let i = 0; i < clean.length; i += size) {
    out.push(clean.slice(i, i + size));
  }
  return out;
}

export default function SafetyCompare({
  open,
  yours,
  theirs,
  yourName,
  theirName,
  onClose,
  onMarkVerified,
  onMarkMismatch,
}: Readonly<Props>) {
  const [pulsing, setPulsing] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  const yoursChunks = chunkFingerprint(yours);
  const theirsChunks = chunkFingerprint(theirs);
  const match = yours.replace(/\s+/g, '') === theirs.replace(/\s+/g, '');

  const body = (
    <button
      type="button"
      className="safety-compare-overlay"
      aria-label="Close safety comparison"
      onClick={onClose}
    >
      <dialog
        open
        aria-label="Safety number comparison"
        className="safety-compare"
        onClick={(e) => e.stopPropagation()}
        onCancel={onClose}
      >
        <header className="safety-compare-header">
          <div className="safety-compare-eyebrow">SECURITY</div>
          <h2 className="safety-compare-title">Compare safety numbers</h2>
          <p className="safety-compare-subtitle">
            Read these aloud or compare visually. They should be identical.
          </p>
        </header>

        <div className="safety-compare-grid">
          <div className="safety-compare-column">
            <div className="safety-compare-name">{yourName}</div>
            <div className={`safety-compare-fingerprint ${pulsing ? 'pulsing' : ''}`}>
              {yoursChunks.map((chunk, idx) => (
                <span key={`y-${idx}-${chunk}`} className="safety-compare-block">
                  {chunk}
                </span>
              ))}
            </div>
          </div>

          <div className="safety-compare-divider" aria-hidden="true">
            <span>↔</span>
          </div>

          <div className="safety-compare-column">
            <div className="safety-compare-name">{theirName}</div>
            <div className={`safety-compare-fingerprint ${pulsing ? 'pulsing' : ''}`}>
              {theirsChunks.map((chunk, idx) => (
                <span
                  key={`t-${idx}-${chunk}`}
                  className={`safety-compare-block ${
                    yoursChunks[idx] && yoursChunks[idx] !== chunk ? 'diff' : ''
                  }`}
                >
                  {chunk}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="safety-compare-meta">
          {match ? (
            <span className="safety-compare-match">FINGERPRINTS MATCH</span>
          ) : (
            <span className="safety-compare-mismatch">FINGERPRINTS DIFFER</span>
          )}
          <button
            type="button"
            className="safety-compare-pulse-btn"
            onClick={() => {
              setPulsing(true);
              setTimeout(() => setPulsing(false), 1400);
            }}
          >
            Highlight blocks
          </button>
        </div>

        <footer className="safety-compare-actions">
          <button
            type="button"
            className="btn btn--danger"
            onClick={onMarkMismatch}
          >
            Doesn't match
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={onMarkVerified}
          >
            Mark verified ✓
          </button>
        </footer>
      </dialog>
    </button>
  );

  return createPortal(body, document.body);
}
