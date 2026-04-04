import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../services/api';
import type { Team } from './types';

export default function OverviewTab({
  teamId,
  team,
  onSave,
}: Readonly<{
  teamId: string;
  team: Team;
  onSave: (t: Team) => void;
}>) {
  const { t } = useTranslation();
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description);
  const [iconUrl, setIconUrl] = useState(team.iconUrl);
  const [maxFileSize, setMaxFileSize] = useState(team.maxFileSize);
  const [allowInvites, setAllowInvites] = useState(team.allowMemberInvites);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.updateTeam(teamId, {
        name,
        description,
        icon_url: iconUrl,
        max_file_size: maxFileSize,
        allow_member_invites: allowInvites,
      });
      onSave({ ...team, name, description, iconUrl, maxFileSize, allowMemberInvites: allowInvites });
    } catch {
      // Error handled silently for now
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h2 className="text-foreground-primary mb-5">{t('settings.overview', 'Overview')}</h2>

      <div className="mb-5">
        <label className="text-micro font-medium uppercase tracking-wide text-foreground-muted block mb-2">{t('settings.teamName', 'Team Name')}</label>
        <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="mb-5">
        <label className="text-micro font-medium uppercase tracking-wide text-foreground-muted block mb-2">{t('settings.description', 'Description')}</label>
        <textarea className="form-input" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>

      <div className="mb-5">
        <label className="text-micro font-medium uppercase tracking-wide text-foreground-muted block mb-2">{t('settings.iconUrl', 'Icon URL')}</label>
        <input className="form-input" value={iconUrl} onChange={(e) => setIconUrl(e.target.value)} />
      </div>

      <div className="mb-5">
        <label className="text-micro font-medium uppercase tracking-wide text-foreground-muted block mb-2">{t('settings.maxFileSize', 'Max File Size (bytes)')}</label>
        <input
          className="form-input"
          type="number"
          value={maxFileSize}
          onChange={(e) => setMaxFileSize(Number(e.target.value))}
        />
      </div>

      <div className="flex items-center justify-between py-3 border-b border-border-subtle">
        <div className="flex-1">
          <div className="text-base font-medium text-foreground-primary">
            {t('settings.allowInvites', 'Allow Member Invites')}
          </div>
          <div className="text-sm text-foreground-secondary mt-0.5">
            {t('settings.allowInvitesDesc', 'Let non-admin members create invite links')}
          </div>
        </div>
        <button
          className={`toggle-switch ${allowInvites ? 'active' : ''}`}
          onClick={() => setAllowInvites(!allowInvites)}
        />
      </div>

      <div className="mt-6">
        <button className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? t('common.saving', 'Saving...') : t('common.save', 'Save Changes')}
        </button>
      </div>
    </div>
  );
}
