import './PresenceIndicator.css';

export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline';

interface Props {
  status: PresenceStatus;
  size?: 'small' | 'medium' | 'large';
  className?: string;
}

export default function PresenceIndicator({ status, size = 'medium', className = '' }: Props) {
  return (
    <span
      className={`presence-indicator presence-${size} ${className}`}
      data-status={status}
    />
  );
}
