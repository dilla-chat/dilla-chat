import { useTranslation } from 'react-i18next';

export default function ModerationTab({ teamId: _teamId }: Readonly<{ teamId: string }>) {
  const { t } = useTranslation();

  return (
    <div className="settings-section">
      <h2>{t('settings.moderation')}</h2>
      <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>
        {t('settings.moderationDesc', 'Configure moderation tools and auto-moderation rules.')}
      </p>
    </div>
  );
}
