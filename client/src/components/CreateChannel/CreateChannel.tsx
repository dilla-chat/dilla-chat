import { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Hashtag, SoundHigh } from 'iconoir-react';
import { useTeamStore } from '../../stores/teamStore';
import { api } from '../../services/api';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import CategorySelect from '../CategorySelect/CategorySelect';
import './CreateChannel.css';

interface Props {
  defaultCategory?: string;
  onClose: () => void;
}

export default function CreateChannel({ defaultCategory, onClose }: Readonly<Props>) {
  const { t } = useTranslation();
  const { activeTeamId, addChannel } = useTeamStore();
  const [name, setName] = useState('');
  const [type, setType] = useState<'text' | 'voice'>('text');
  const [category, setCategory] = useState(defaultCategory ?? '');
  const [newCategory, setNewCategory] = useState('');
  const [topic, setTopic] = useState('');
  const [creating, setCreating] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, true, onClose);

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
    <div className="create-channel-overlay" role="dialog" aria-modal="true" aria-labelledby="create-channel-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="create-channel-modal" ref={modalRef}>
        <h2 id="create-channel-title" className="heading-3">{t('channels.create')}</h2>

        <div className="create-channel-field">
          <label className="micro">{t('channels.type', 'Channel Type')}</label>
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
          <label htmlFor="create-channel-name" className="micro">{t('channels.name', 'Channel Name')}</label>
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
          <label htmlFor="create-channel-category" className="micro">{t('channels.categoryLabel', 'Category')}</label>
          <CategorySelect
            id="create-channel-category"
            category={category}
            newCategory={newCategory}
            onCategoryChange={setCategory}
            onNewCategoryChange={setNewCategory}
          />
        </div>

        <div className="create-channel-field">
          <label htmlFor="create-channel-topic" className="micro">{t('channels.topicLabel', 'Topic')} ({t('channels.optional', 'optional')})</label>
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
