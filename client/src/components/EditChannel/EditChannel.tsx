import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTeamStore, type Channel } from '../../stores/teamStore';
import { api } from '../../services/api';
import CategorySelect from '../CategorySelect/CategorySelect';
import './EditChannel.css';

interface Props {
  channel: Channel;
  onClose: () => void;
}

export default function EditChannel({ channel, onClose }: Readonly<Props>) {
  const { t } = useTranslation();
  const { activeTeamId, updateChannel } = useTeamStore();
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic ?? '');
  const [category, setCategory] = useState(channel.category ?? '');
  const [newCategory, setNewCategory] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');


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
    <dialog className="edit-channel-overlay" open aria-labelledby="edit-channel-title">
      <button type="button" className="dialog-backdrop" onClick={onClose} aria-label="Close" />
      <div className="edit-channel-modal">
        <h2 id="edit-channel-title">{t('channels.editChannel', 'Edit Channel')}</h2>

        <div className="edit-channel-field">
          <label htmlFor="edit-channel-name">{t('channels.name', 'Channel Name')}</label>
          <input
            id="edit-channel-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('channels.namePlaceholder', 'General Chat')}
            maxLength={100}
          />
        </div>

        <div className="edit-channel-field">
          <label htmlFor="edit-channel-category">{t('channels.categoryLabel', 'Category')}</label>
          <CategorySelect
            id="edit-channel-category"
            category={category}
            newCategory={newCategory}
            onCategoryChange={setCategory}
            onNewCategoryChange={setNewCategory}
          />
        </div>

        <div className="edit-channel-field">
          <label htmlFor="edit-channel-topic">{t('channels.topicLabel', 'Topic')} ({t('channels.optional', 'optional')})</label>
          <textarea
            id="edit-channel-topic"
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
    </dialog>
  );
}
