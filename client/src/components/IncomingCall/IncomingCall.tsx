import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import './IncomingCall.css';

interface Props {
  open: boolean;
  callerName: string;
  callerInitial?: string;
  callerColor?: string;
  channelName?: string;
  onAccept: () => void;
  onDecline: () => void;
}

export default function IncomingCall({
  open,
  callerName,
  callerInitial,
  callerColor,
  channelName,
  onAccept,
  onDecline,
}: Readonly<Props>) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        onAccept();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onDecline();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onAccept, onDecline]);

  if (!open) return null;

  const initial =
    (callerInitial ?? callerName.charAt(0)).toUpperCase() || '?';

  const body = (
    <div className="incoming-call-overlay" role="alertdialog" aria-label="Incoming call">
      <div className="incoming-call-card">
        <div className="incoming-call-pulse">
          <div
            className="incoming-call-avatar"
            style={callerColor ? { background: callerColor } : undefined}
          >
            {initial}
          </div>
        </div>

        <div className="incoming-call-info">
          <div className="incoming-call-status">INCOMING CALL</div>
          <div className="incoming-call-name">{callerName}</div>
          {channelName && (
            <div className="incoming-call-channel">via #{channelName}</div>
          )}
        </div>

        <div className="incoming-call-actions">
          <button
            type="button"
            className="incoming-call-btn decline"
            onClick={onDecline}
            title="Decline (Esc)"
          >
            <span aria-hidden="true">✕</span>
            <span className="incoming-call-btn-label">Decline</span>
            <kbd>ESC</kbd>
          </button>
          <button
            type="button"
            className="incoming-call-btn accept"
            onClick={onAccept}
            title="Accept (Enter)"
          >
            <span aria-hidden="true">✓</span>
            <span className="incoming-call-btn-label">Accept</span>
            <kbd>↵</kbd>
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(body, document.body);
}
