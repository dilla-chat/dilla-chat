import { useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import './UserPopover.css';

interface Props {
  username: string;
  userId: string;
  avatarColor: string;
  roles?: string[];
  position: { top: number; left: number };
  onClose: () => void;
  onMessage?: () => void;
  onMention?: () => void;
}

export default function UserPopover({
  username,
  userId,
  avatarColor,
  roles,
  position,
  onClose,
  onMessage,
  onMention,
}: Readonly<Props>) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  const initials = username.slice(0, 2).toUpperCase();
  const fingerprint =
    userId.length > 8 ? `${userId.slice(0, 6)}...${userId.slice(-4)}` : userId;

  return createPortal(
    <div ref={ref} className="user-popover" style={{ top: position.top, left: position.left }}>
      <div
        className="user-popover-banner"
        style={{ background: `linear-gradient(135deg, ${avatarColor}30, ${avatarColor}10)` }}
      />
      <div className="user-popover-body">
        <div className="user-popover-avatar" style={{ background: avatarColor }}>
          {initials}
        </div>
        <div className="user-popover-name">{username}</div>
        <div className="user-popover-fingerprint">{fingerprint}</div>
        {roles && roles.length > 0 && (
          <div className="user-popover-roles">
            {roles.map(role => (
              <span key={role} className="user-popover-role">
                {role}
              </span>
            ))}
          </div>
        )}
        <div className="user-popover-actions">
          {onMessage && (
            <button className="user-popover-action" onClick={onMessage} type="button">
              Message
            </button>
          )}
          {onMention && (
            <button className="user-popover-action" onClick={onMention} type="button">
              Mention
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
