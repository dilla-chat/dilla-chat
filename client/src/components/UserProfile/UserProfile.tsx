import { useTranslation } from 'react-i18next';
import type { Member, Role } from '../../stores/teamStore';
import type { UserPresence } from '../../stores/presenceStore';
import PresenceIndicator from '../PresenceIndicator/PresenceIndicator';
import './UserProfile.css';

interface Props {
  member: Member;
  presence?: UserPresence;
  x: number;
  y: number;
  onSendMessage?: () => void;
  onClose: () => void;
}

export default function UserProfile({ member, presence, x, y, onSendMessage }: Props) {
  const { t } = useTranslation();

  const initials = (member.displayName || member.username)
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  const status = (presence?.status ?? 'offline') as 'online' | 'idle' | 'dnd' | 'offline';
  const statusLabel = t(`presence.${status === 'offline' ? 'offline' : status}`);

  return (
    <div
      className="user-profile-popover"
      style={{ left: Math.max(0, x), top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="user-profile-banner" />
      <div className="user-profile-body">
        <div className="user-profile-avatar-wrapper">
          <div className="user-profile-avatar">{initials}</div>
          <PresenceIndicator status={status} size="large" className="border-floating" />
        </div>

        <div className="user-profile-display-name">
          {member.displayName || member.username}
        </div>
        <div className="user-profile-username">@{member.username}</div>

        <div className="user-profile-status-row">
          <span className="user-profile-status-text">{statusLabel}</span>
          {presence?.custom_status && (
            <span className="user-profile-custom-status">{presence.custom_status}</span>
          )}
        </div>

        {member.roles.length > 0 && (
          <div className="user-profile-section">
            <div className="user-profile-section-title">{t('profile.roles')}</div>
            <div className="user-profile-roles">
              {member.roles.map((role: Role) => (
                <span key={role.id} className="user-profile-role-badge">
                  <span className="user-profile-role-dot" style={{ background: role.color || '#99aab5' }} />
                  {role.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {onSendMessage && (
          <button className="user-profile-send-btn" onClick={onSendMessage}>
            {t('profile.sendMessage')}
          </button>
        )}
      </div>
    </div>
  );
}
