import { useTranslation } from 'react-i18next';

export default function ModerationTab({ teamId: _teamId }: Readonly<{ teamId: string }>) {
  const { t } = useTranslation();

  return (
    <div>
      <h2 className="text-foreground-primary mb-5">{t('settings.moderation')}</h2>
      <p className="text-foreground-muted text-sm">
        {t('settings.moderationDesc', 'Configure moderation tools and auto-moderation rules.')}
      </p>
    </div>
  );
}
