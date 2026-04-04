import { useTranslation } from 'react-i18next';
import type { Member, Role } from '../../stores/teamStore';
import type { UserPresence } from '../../stores/presenceStore';
import PresenceIndicator from '../PresenceIndicator/PresenceIndicator';

interface Props {
  member: Member;
  presence?: UserPresence;
  x: number;
  y: number;
  onSendMessage?: () => void;
  onClose?: () => void;
}

export default function UserProfile({ member, presence, x, y, onSendMessage }: Readonly<Props>) {
  const { t } = useTranslation();

  const initials = (member.displayName || member.username)
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  const status = presence?.status ?? 'offline';
  const statusLabel = t(`presence.${status === 'offline' ? 'offline' : status}`);

  return (
    <dialog
      className="fixed bg-glass-floating backdrop-blur-[var(--glass-blur-heavy)] border border-glass-border shadow-glass-elevated rounded-lg w-[300px] z-[1000] overflow-hidden text-foreground-primary p-0 max-w-none max-h-none"
      style={{ left: Math.max(0, x), top: y }}
      open
      data-testid="user-profile-popover"
    >
      <div className="h-[60px] bg-accent" />
      <div className="px-4 pb-4 relative">
        <div className="relative inline-block -mt-[30px] mb-2">
          <div className="size-16 rounded-full bg-accent text-white flex items-center justify-center text-[22px] font-semibold border-4 border-surface-tertiary" data-testid="user-profile-avatar">{initials}</div>
          <PresenceIndicator status={status} size="large" className="border-floating" />
        </div>

        <div className="text-xl font-semibold text-foreground-primary mb-0.5">
          {member.displayName || member.username}
        </div>
        <div className="text-sm text-foreground-secondary mb-2.5">@{member.username}</div>

        <div className="flex flex-col gap-0.5 mb-3 py-2 border-t border-[var(--white-overlay-subtle)]">
          <span className="text-sm text-foreground-secondary">{statusLabel}</span>
          {presence?.custom_status && (
            <span className="text-[0.8125rem] text-foreground-primary opacity-80">{presence.custom_status}</span>
          )}
        </div>

        {member.roles.length > 0 && (
          <div className="mb-3" data-testid="user-profile-roles">
            <div className="text-micro font-medium uppercase tracking-wide text-foreground-muted mb-1.5">{t('profile.roles')}</div>
            <div className="flex flex-wrap gap-1">
              {member.roles.map((role: Role) => (
                <span key={role.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-xl text-xs bg-surface">
                  <span className="size-2 rounded-full" style={{ background: role.color || '#8fa3b8' }} />
                  {role.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {onSendMessage && (
          <button className="w-full p-2 border border-[var(--white-overlay-light)] rounded-sm bg-[var(--gradient-accent)] text-white text-base font-medium cursor-pointer mt-1 transition-[filter,box-shadow] duration-150 shadow-[0_2px_8px_var(--accent-alpha-20)] hover:brightness-110 hover:shadow-[0_4px_16px_var(--accent-alpha-30)]" onClick={onSendMessage}>
            {t('profile.sendMessage')}
          </button>
        )}
      </div>
    </dialog>
  );
}
