import { useEffect } from 'react';
import './TeamRailContextMenu.css';

interface Props {
  x: number;
  y: number;
  onClose: () => void;
  onSettings: () => void;
  onInvites: () => void;
  onFederation: () => void;
  onMarkAllRead: () => void;
  onLeave: () => void;
}

export default function TeamRailContextMenu({
  x,
  y,
  onClose,
  onSettings,
  onInvites,
  onFederation,
  onMarkAllRead,
  onLeave,
}: Readonly<Props>) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const wrap = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div
      className="team-rail-menu"
      role="menu"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <button role="menuitem" onClick={wrap(onSettings)}>Settings</button>
      <button role="menuitem" onClick={wrap(onInvites)}>Invites</button>
      <button role="menuitem" onClick={wrap(onFederation)}>Federation</button>
      <button role="menuitem" onClick={wrap(onMarkAllRead)}>Mark all read</button>
      <button role="menuitem" className="danger" onClick={wrap(onLeave)}>Leave</button>
    </div>
  );
}
