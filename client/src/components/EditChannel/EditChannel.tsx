import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTeamStore, type Channel } from '../../stores/teamStore';
import { api } from '../../services/api';
import CategorySelect from '../CategorySelect/CategorySelect';

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
    <dialog className="fixed inset-0 border-none p-0 bg-transparent max-w-none max-h-none bg-overlay-dark backdrop-blur-[4px] flex items-center justify-center z-[1000]" open aria-labelledby="edit-channel-title">
      <button type="button" className="dialog-backdrop" onClick={onClose} aria-label="Close" />
      <div className="bg-glass-modal backdrop-blur-glass-heavy border border-glass-border shadow-glass-elevated rounded-lg p-xl w-[440px] max-w-[90vw] text-foreground-primary" data-testid="edit-channel-modal">
        <h2 id="edit-channel-title" className="m-0 mb-5 text-xl font-semibold">{t('channels.editChannel', 'Edit Channel')}</h2>

        <div className="mb-lg">
          <label htmlFor="edit-channel-name" className="text-micro font-medium uppercase tracking-wide text-foreground-muted block mb-1.5">{t('channels.name', 'Channel Name')}</label>
          <input
            id="edit-channel-name"
            type="text"
            className="w-full py-2.5 pl-2.5 pr-8 rounded-sm bg-input text-foreground-primary text-base font-inherit box-border"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('channels.namePlaceholder', 'General Chat')}
            maxLength={100}
          />
        </div>

        <div className="mb-lg">
          <label htmlFor="edit-channel-category" className="text-micro font-medium uppercase tracking-wide text-foreground-muted block mb-1.5">{t('channels.categoryLabel', 'Category')}</label>
          <CategorySelect
            id="edit-channel-category"
            category={category}
            newCategory={newCategory}
            onCategoryChange={setCategory}
            onNewCategoryChange={setNewCategory}
          />
        </div>

        <div className="mb-lg">
          <label htmlFor="edit-channel-topic" className="text-micro font-medium uppercase tracking-wide text-foreground-muted block mb-1.5">{t('channels.topicLabel', 'Topic')} ({t('channels.optional', 'optional')})</label>
          <textarea
            id="edit-channel-topic"
            className="w-full py-2.5 pl-2.5 pr-8 rounded-sm bg-input text-foreground-primary text-base font-inherit box-border resize-y min-h-[60px]"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder={t('channels.topicPlaceholder', 'What is this channel about?')}
          />
        </div>

        {error && <div className="text-foreground-danger text-sm mb-md">{error}</div>}

        <div className="flex justify-end gap-md mt-5">
          <button className="py-sm px-xl rounded-sm border-none text-base cursor-pointer bg-transparent text-foreground-primary hover:underline" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            className="py-sm px-xl rounded-sm border border-[var(--white-overlay-light)] text-base cursor-pointer bg-[var(--gradient-accent)] text-white shadow-[0_2px_8px_var(--accent-alpha-20)] transition-[filter,box-shadow] duration-150 hover:brightness-110 hover:shadow-[0_4px_16px_var(--accent-alpha-30)] disabled:opacity-50 disabled:cursor-not-allowed disabled:brightness-100 disabled:shadow-none"
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
