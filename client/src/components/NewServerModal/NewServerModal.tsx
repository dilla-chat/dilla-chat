import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import './NewServerModal.css';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called when user submits the Create form */
  onCreate?: (data: { name: string; serverUrl: string }) => void;
  /** Called when user submits the Join form */
  onJoin?: (data: { serverUrl: string; invite: string }) => void;
}

export default function NewServerModal({
  open,
  onClose,
  onCreate,
  onJoin,
}: Readonly<Props>) {
  const [mode, setMode] = useState<'create' | 'join'>('join');
  const [name, setName] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [invite, setInvite] = useState('');

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset of form state when modal reopens
      setMode('join');
      setName('');
      setServerUrl('');
      setInvite('');
    }
  }, [open]);

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

  const canSubmit =
    mode === 'create'
      ? name.trim() && serverUrl.trim()
      : serverUrl.trim() && invite.trim();

  const handleSubmit = () => {
    if (!canSubmit) return;
    if (mode === 'create') {
      onCreate?.({ name: name.trim(), serverUrl: serverUrl.trim() });
    } else {
      onJoin?.({ serverUrl: serverUrl.trim(), invite: invite.trim() });
    }
    onClose();
  };

  const body = (
    <button
      type="button"
      className="new-server-modal-overlay"
      aria-label="Close new server modal"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Add team"
        className="new-server-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="new-server-modal-header">
          <div className="new-server-modal-eyebrow">TEAM</div>
          <h2 className="new-server-modal-title">Add a team</h2>
        </header>

        <div className="new-server-modal-toggle" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'create'}
            className={`new-server-modal-toggle-btn ${mode === 'create' ? 'active' : ''}`}
            onClick={() => setMode('create')}
          >
            CREATE
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'join'}
            className={`new-server-modal-toggle-btn ${mode === 'join' ? 'active' : ''}`}
            onClick={() => setMode('join')}
          >
            JOIN VIA INVITE
          </button>
        </div>

        <div className="new-server-modal-body">
          {mode === 'create' ? (
            <>
              <label className="new-server-modal-label">
                Team name
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="berralitos"
                  className="new-server-modal-input"
                  autoFocus
                />
              </label>
              <label className="new-server-modal-label">
                Server URL
                <input
                  type="url"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  placeholder="https://gbg-1.dilla.local"
                  className="new-server-modal-input"
                />
              </label>
            </>
          ) : (
            <>
              <label className="new-server-modal-label">
                Server URL
                <input
                  type="url"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  placeholder="https://gbg-1.dilla.local"
                  className="new-server-modal-input"
                  autoFocus
                />
              </label>
              <label className="new-server-modal-label">
                Invite token
                <input
                  type="text"
                  value={invite}
                  onChange={(e) => setInvite(e.target.value)}
                  placeholder="paste invite token"
                  className="new-server-modal-input"
                />
              </label>
            </>
          )}
        </div>

        <footer className="new-server-modal-actions">
          <button
            type="button"
            className="new-server-modal-btn secondary"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="new-server-modal-btn primary"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {mode === 'create' ? 'Create →' : 'Join →'}
          </button>
        </footer>
      </div>
    </button>
  );

  return createPortal(body, document.body);
}
