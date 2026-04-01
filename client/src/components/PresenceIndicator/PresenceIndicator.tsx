import { memo } from 'react';
import './PresenceIndicator.css';

export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline';

interface Props {
  status: PresenceStatus;
  size?: 'small' | 'medium' | 'large';
  className?: string;
}

const statusLabels: Record<PresenceStatus, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do Not Disturb',
  offline: 'Offline',
};

export default memo(function PresenceIndicator({ status, size = 'medium', className = '' }: Readonly<Props>) {
  return (
    <span
      className={`presence-indicator presence-${size} ${className}`}
      data-status={status}
      role="img"
      aria-label={statusLabels[status]}
    />
  );
});
