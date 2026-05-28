// Singleton confirm dialog host. Listens to useConfirmStore and renders a
// modal whenever a request is pending. Mounted once at the app shell
// level (AppShell, plus the legacy /app/settings route which renders
// outside that shell). dillaConfirm() in callers pushes a request +
// returns a Promise that resolves when the user clicks Cancel/Confirm
// or presses Escape/Enter.

import { useEffect, useRef } from 'react';
import { useConfirmStore } from '../../stores/confirmStore';

export default function ConfirmDialog() {
  const pending = useConfirmStore((s) => s.pending);
  const answer = useConfirmStore((s) => s.answer);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  // Keyboard: Escape cancels, Enter confirms. Bound on window so it
  // catches even when focus is inside a child input (rare here, but
  // future-proofs the dialog if we add fields).
  useEffect(() => {
    if (!pending) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        answer(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        answer(true);
      }
    }
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [pending, answer]);

  // Focus the safer action on open: Cancel for danger prompts so the
  // user can't accidentally Enter-through a destructive action; Confirm
  // for the rest because it's almost always the expected default.
  useEffect(() => {
    if (!pending) return;
    const target = pending.danger ? cancelRef.current : confirmRef.current;
    target?.focus();
  }, [pending]);

  if (!pending) return null;

  const title = pending.title || 'Are you sure?';
  const confirmLabel = pending.confirmLabel || 'Confirm';
  const cancelLabel = pending.cancelLabel || 'Cancel';

  return (
    <div
      className="modal-overlay"
      onClick={() => answer(false)}
      onKeyDown={(e) => { if (e.key === 'Escape') answer(false); }}
      role="presentation"
    >
      <div
        className="modal-card confirm-card"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="modal-x" onClick={() => answer(false)} aria-label="Cancel">×</button>
        </header>
        <div className="modal-body">
          <p style={{ whiteSpace: 'pre-line', lineHeight: 1.5 }}>{pending.body}</p>
        </div>
        <footer className="modal-foot">
          <button
            ref={cancelRef}
            className="btn"
            onClick={() => answer(false)}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            className={'btn ' + (pending.danger ? 'btn--danger' : 'btn--primary')}
            onClick={() => answer(true)}
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
