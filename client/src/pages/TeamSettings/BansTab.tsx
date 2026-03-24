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
    <div className="settings-section">
      <h2>{t('settings.bans', 'Bans')}</h2>
      <div className="banned-users-list">
        {bannedUsers.length === 0 && (
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>
            {t('members.noBanned', 'No banned users')}
          </p>
        )}
        {/* v8 ignore next 7 -- BansTab has no API to load banned users yet */}
        {bannedUsers.map((user) => (
          <div key={user.id} className="banned-user-item">
            <span className="banned-user-name">{user.username}</span>
            <button className="btn-secondary" onClick={() => handleUnban(user.id)}>
              {t('members.unban', 'Unban')}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
