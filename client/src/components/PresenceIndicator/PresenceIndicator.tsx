import './PresenceIndicator.css';

export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline';

interface Props {
  status: PresenceStatus;
  size?: 'small' | 'medium' | 'large';
  className?: string;
}

const STATUS_COLORS: Record<PresenceStatus, string> = {
  online: '#23a55a',
  idle: '#f0b232',
  dnd: '#f23f43',
  offline: '#80848e',
};

export default function PresenceIndicator({ status, size = 'medium', className = '' }: Props) {
  return (
    <span
      className={`presence-indicator presence-${size} ${className}`}
      style={{ backgroundColor: STATUS_COLORS[status] }}
      data-status={status}
    />
  );
}
