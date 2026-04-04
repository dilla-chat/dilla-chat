import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../services/api';

export default function BansTab({ teamId }: Readonly<{ teamId: string }>) {
  const { t } = useTranslation();
  const [bannedUsers, setBannedUsers] = useState<Array<{ id: string; username: string }>>([]);

  /* v8 ignore next 7 -- BansTab has no API to load banned users yet */
  const handleUnban = async (userId: string) => {
    try {
      await api.unbanMember(teamId, userId);
      setBannedUsers((prev) => prev.filter((u) => u.id !== userId));
    } catch {
      // Error
    }
  };

  return (
    <div>
      <h2 className="text-foreground-primary mb-5">{t('settings.bans', 'Bans')}</h2>
      <div className="flex flex-col gap-0.5">
        {bannedUsers.length === 0 && (
          <p className="text-foreground-muted text-sm">
            {t('members.noBanned', 'No banned users')}
          </p>
        )}
        {/* v8 ignore next 7 -- BansTab has no API to load banned users yet */}
        {bannedUsers.map((user) => (
          <div key={user.id} className="flex items-center justify-between py-2.5 px-3 rounded-sm hover:bg-surface-hover">
            <span className="text-base text-foreground-primary">{user.username}</span>
            <button className="btn-secondary" onClick={() => handleUnban(user.id)}>
              {t('members.unban', 'Unban')}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
