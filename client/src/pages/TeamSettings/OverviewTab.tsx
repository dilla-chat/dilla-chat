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
    <div className="settings-section">
      <h2>{t('settings.overview', 'Overview')}</h2>

      <div className="settings-field">
        <label>{t('settings.teamName', 'Team Name')}</label>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="settings-field">
        <label>{t('settings.description', 'Description')}</label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>

      <div className="settings-field">
        <label>{t('settings.iconUrl', 'Icon URL')}</label>
        <input value={iconUrl} onChange={(e) => setIconUrl(e.target.value)} />
      </div>

      <div className="settings-field">
        <label>{t('settings.maxFileSize', 'Max File Size (bytes)')}</label>
        <input
          type="number"
          value={maxFileSize}
          onChange={(e) => setMaxFileSize(Number(e.target.value))}
        />
      </div>

      <div className="settings-toggle">
        <div className="settings-toggle-info">
          <div className="settings-toggle-label">
            {t('settings.allowInvites', 'Allow Member Invites')}
          </div>
          <div className="settings-toggle-desc">
            {t('settings.allowInvitesDesc', 'Let non-admin members create invite links')}
          </div>
        </div>
        <button
          className={`toggle-switch ${allowInvites ? 'active' : ''}`}
          onClick={() => setAllowInvites(!allowInvites)}
        />
      </div>

      <div style={{ marginTop: 24 }}>
        <button className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? t('common.saving', 'Saving...') : t('common.save', 'Save Changes')}
        </button>
      </div>
    </div>
  );
}
