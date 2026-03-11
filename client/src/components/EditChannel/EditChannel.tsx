import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useTeamStore, type Channel } from '../../stores/teamStore';
import { api } from '../../services/api';
import './EditChannel.css';

interface Props {
  channel: Channel;
  onClose: () => void;
}

export default function EditChannel({ channel, onClose }: Props) {
  const { t } = useTranslation();
  const { activeTeamId, channels, updateChannel } = useTeamStore();
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic ?? '');
  const [category, setCategory] = useState(channel.category ?? '');
  const [newCategory, setNewCategory] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const existingCategories = useMemo(() => {
    if (!activeTeamId) return [];
    const chans = channels.get(activeTeamId) ?? [];
    const uiLabels = new Set([t('channels.voiceChannels', 'Voice Channels'), t('channels.textChannels', 'Text Channels')]);
    return [...new Set(chans.map((c) => c.category).filter((c): c is string => Boolean(c) && !uiLabels.has(c)))];
  }, [activeTeamId, channels, t]);

  const handleSave = async () => {
    if (!activeTeamId || !name.trim()) return;
    setSaving(true);
    setError('');
    try {
      const finalCategory = category === '__new__' ? newCategory : category;
      const updates: Record<string, unknown> = {};
      if (name.trim() !== channel.name) updates.name = name.trim();
      if (topic !== (channel.topic ?? '')) updates.topic = topic;
      if (finalCategory !== (channel.category ?? '')) updates.category = finalCategory;

      if (Object.keys(updates).length > 0) {
        await api.updateChannel(activeTeamId, channel.id, updates);
        updateChannel(activeTeamId, {
          ...channel,
          name: name.trim(),
          topic,
          category: finalCategory || '',
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update channel');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="edit-channel-overlay" onClick={onClose}>
      <div className="edit-channel-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t('channels.editChannel', 'Edit Channel')}</h2>

        <div className="edit-channel-field">
          <label>{t('channels.name', 'Channel Name')}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('channels.namePlaceholder', 'General Chat')}
            maxLength={100}
          />
        </div>

        <div className="edit-channel-field">
          <label>{t('channels.categoryLabel', 'Category')}</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">{t('channels.noCategory', 'No category')}</option>
            {existingCategories.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
            <option value="__new__">{t('channels.newCategory', '+ Create new')}</option>
          </select>
          {category === '__new__' && (
            <input
              type="text"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              placeholder={t('channels.categoryPlaceholder', 'Category name')}
              style={{ marginTop: 8 }}
            />
          )}
        </div>

        <div className="edit-channel-field">
          <label>{t('channels.topicLabel', 'Topic')} ({t('channels.optional', 'optional')})</label>
          <textarea
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder={t('channels.topicPlaceholder', 'What is this channel about?')}
          />
        </div>

        {error && <div className="edit-channel-error">{error}</div>}

        <div className="edit-channel-actions">
          <button className="btn-cancel" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            className="btn-save"
            onClick={handleSave}
            disabled={!name.trim() || saving}
          >
            {saving ? t('common.saving', 'Saving...') : t('common.save', 'Save')}
          </button>
        </div>
      </div>
    </div>
  );
}
