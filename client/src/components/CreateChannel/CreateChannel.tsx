import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Hashtag, SoundHigh } from 'iconoir-react';
import { useTeamStore } from '../../stores/teamStore';
import { api } from '../../services/api';
import './CreateChannel.css';

interface Props {
  defaultCategory?: string;
  onClose: () => void;
}

export default function CreateChannel({ defaultCategory, onClose }: Props) {
  const { t } = useTranslation();
  const { activeTeamId, channels, addChannel } = useTeamStore();
  const [name, setName] = useState('');
  const [type, setType] = useState<'text' | 'voice'>('text');
  const [category, setCategory] = useState(defaultCategory ?? '');
  const [newCategory, setNewCategory] = useState('');
  const [topic, setTopic] = useState('');
  const [creating, setCreating] = useState(false);

  const existingCategories = useMemo(() => {
    if (!activeTeamId) return [];
    const chans = channels.get(activeTeamId) ?? [];
    // Filter out UI-generated labels that aren't real DB categories
    const uiLabels = new Set([t('channels.voiceChannels', 'Voice Channels'), t('channels.textChannels', 'Text Channels')]);
    return [...new Set(chans.map((c) => c.category).filter((c): c is string => Boolean(c) && !uiLabels.has(c)))];
  }, [activeTeamId, channels, t]);

  const handleCreate = async () => {
    if (!activeTeamId || !name.trim()) return;
    setCreating(true);
    try {
      const finalCategory = category === '__new__' ? newCategory : category;
      const result = (await api.createChannel(activeTeamId, {
        name: name.trim(),
        type,
        topic: topic || undefined,
        category: finalCategory || undefined,
      })) as Record<string, unknown>;

      addChannel(activeTeamId, {
        id: result.id as string,
        teamId: activeTeamId,
        name: name.trim(),
        topic,
        type,
        position: result.position as number ?? 0,
        category: (category === '__new__' ? newCategory : category) || '',
      });
      onClose();
    } catch {
      // Error handled silently for now
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="create-channel-overlay" onClick={onClose}>
      <div className="create-channel-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="create-channel-title">
        <h2 id="create-channel-title">{t('channels.create')}</h2>

        <div className="create-channel-field">
          <label>{t('channels.type', 'Channel Type')}</label>
          <div className="channel-type-toggle">
            <button
              className={`channel-type-btn ${type === 'text' ? 'active' : ''}`}
              onClick={() => setType('text')}
            >
              <Hashtag width={16} height={16} strokeWidth={2} /> {t('channels.text')}
            </button>
            <button
              className={`channel-type-btn ${type === 'voice' ? 'active' : ''}`}
              onClick={() => setType('voice')}
            >
              <SoundHigh width={16} height={16} strokeWidth={2} /> {t('channels.voice')}
            </button>
          </div>
        </div>

        <div className="create-channel-field">
          <label htmlFor="create-channel-name">{t('channels.name', 'Channel Name')}</label>
          <input
            id="create-channel-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('channels.namePlaceholder', 'General Chat')}
            maxLength={100}
          />
        </div>

        <div className="create-channel-field">
          <label htmlFor="create-channel-category">{t('channels.categoryLabel', 'Category')}</label>
          <select id="create-channel-category" value={category} onChange={(e) => setCategory(e.target.value)}>
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

        <div className="create-channel-field">
          <label htmlFor="create-channel-topic">{t('channels.topicLabel', 'Topic')} ({t('channels.optional', 'optional')})</label>
          <textarea
            id="create-channel-topic"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder={t('channels.topicPlaceholder', 'What is this channel about?')}
          />
        </div>

        <div className="create-channel-actions">
          <button className="btn-cancel" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            className="btn-create"
            onClick={handleCreate}
            disabled={!name.trim() || creating}
          >
            {creating ? t('common.creating', 'Creating...') : t('channels.create')}
          </button>
        </div>
      </div>
    </div>
  );
}
