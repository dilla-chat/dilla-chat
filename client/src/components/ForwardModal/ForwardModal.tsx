import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import './ForwardModal.css';

export interface ForwardTarget {
  /** Stable id for the target (channel id or DM id) */
  id: string;
  /** Display label, e.g. "#design" or "@ada" or "group: ada, ben" */
  label: string;
  /** 'channel' or 'dm' */
  kind: 'channel' | 'dm';
}

export interface ForwardSource {
  author: string;
  authorColor?: string;
  timestamp: string;
  body: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  source: ForwardSource | null;
  targets: ForwardTarget[];
  onForward: (target: ForwardTarget) => void;
}

export default function ForwardModal({
  open,
  onClose,
  source,
  targets,
  onForward,
}: Readonly<Props>) {
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return targets;
    return targets.filter((t) => t.label.toLowerCase().includes(q));
  }, [query, targets]);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset of form state when modal reopens
      setQuery('');
      setSelectedIdx(0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const t = filtered[selectedIdx];
        if (t) {
          onForward(t);
          onClose();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, filtered, selectedIdx, onClose, onForward]);

  if (!open) return null;

  const body = (
    <div className="forward-modal-wrap">
      <button
        type="button"
        className="forward-modal-overlay"
        aria-label="Close forward modal"
        onClick={onClose}
      />
      <dialog
        open
        aria-label="Forward message"
        className="forward-modal"
        onCancel={onClose}
      >
        <header className="forward-modal-header">
          <div className="forward-modal-eyebrow">FORWARD</div>
          <h2 className="forward-modal-title">Send this to…</h2>
        </header>

        {source && (
          <div className="forward-modal-source">
            <div className="forward-modal-source-meta">
              <span
                className="forward-modal-source-author"
                style={source.authorColor ? { color: source.authorColor } : undefined}
              >
                {source.author}
              </span>
              <span className="forward-modal-source-time">{source.timestamp}</span>
            </div>
            <div className="forward-modal-source-body">{source.body}</div>
          </div>
        )}

        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIdx(0);
          }}
          placeholder="Filter channels & DMs…"
          className="forward-modal-search"
          aria-label="Filter targets"
          autoFocus
        />

        <div className="forward-modal-list">
          {filtered.length === 0 && (
            <div className="forward-modal-empty">No matches</div>
          )}
          {filtered.map((t, idx) => {
            const selected = idx === selectedIdx;
            return (
              <button
                key={t.id}
                type="button"
                aria-pressed={selected}
                className={`forward-modal-row ${selected ? 'selected' : ''}`}
                onClick={() => {
                  onForward(t);
                  onClose();
                }}
                onMouseEnter={() => setSelectedIdx(idx)}
              >
                <span className="forward-modal-row-kind">
                  {t.kind === 'channel' ? '#' : '@'}
                </span>
                <span className="forward-modal-row-label">{t.label}</span>
              </button>
            );
          })}
        </div>

        <footer className="forward-modal-actions">
          <button
            type="button"
            className="btn"
            onClick={onClose}
          >
            Cancel
          </button>
        </footer>
      </dialog>
    </div>
  );

  return createPortal(body, document.body);
}
