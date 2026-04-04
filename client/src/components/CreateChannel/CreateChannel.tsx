import { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Hashtag, SoundHigh } from 'iconoir-react';
import { useTeamStore } from '../../stores/teamStore';
import { api } from '../../services/api';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import CategorySelect from '../CategorySelect/CategorySelect';

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
    <dialog className="fixed inset-0 border-none p-0 bg-transparent max-w-none max-h-none bg-overlay-dark backdrop-blur-[4px] flex items-center justify-center z-[1000]" open aria-labelledby="create-channel-title">
      <button type="button" className="dialog-backdrop" onClick={onClose} aria-label="Close" />
      <div className="bg-glass-modal backdrop-blur-glass-heavy border border-glass-border shadow-glass-elevated rounded-lg p-xl w-[440px] max-w-[90vw] text-foreground-primary" ref={modalRef}>
        <h2 id="create-channel-title" className="heading-3 m-0 mb-5">{t('channels.create')}</h2>

        <div className="mb-lg">
          <label className="text-micro font-medium uppercase tracking-wide text-foreground-muted block mb-1.5">{t('channels.type', 'Channel Type')}</label>
          <div className="flex gap-sm">
            <button
              className={`flex-1 p-2.5 rounded-sm border cursor-pointer text-base flex items-center justify-center gap-1.5${type === 'text' ? ' border-accent text-foreground-primary bg-brand-a15' : ' border-border bg-input text-foreground-secondary'}`}
              onClick={() => setType('text')}
              data-testid="channel-type-text"
              data-active={type === 'text'}
            >
              <Hashtag width={16} height={16} strokeWidth={2} /> {t('channels.text')}
            </button>
            <button
              className={`flex-1 p-2.5 rounded-sm border cursor-pointer text-base flex items-center justify-center gap-1.5${type === 'voice' ? ' border-accent text-foreground-primary bg-brand-a15' : ' border-border bg-input text-foreground-secondary'}`}
              onClick={() => setType('voice')}
              data-testid="channel-type-voice"
              data-active={type === 'voice'}
            >
              <SoundHigh width={16} height={16} strokeWidth={2} /> {t('channels.voice')}
            </button>
          </div>
        </div>

        <div className="mb-lg">
          <label htmlFor="create-channel-name" className="text-micro font-medium uppercase tracking-wide text-foreground-muted block mb-1.5">{t('channels.name', 'Channel Name')}</label>
          <input
            id="create-channel-name"
            type="text"
            className="w-full py-2.5 pl-2.5 pr-8 rounded-sm bg-input text-foreground-primary text-base font-inherit box-border"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('channels.namePlaceholder', 'General Chat')}
            maxLength={100}
          />
        </div>

        <div className="mb-lg">
          <label htmlFor="create-channel-category" className="text-micro font-medium uppercase tracking-wide text-foreground-muted block mb-1.5">{t('channels.categoryLabel', 'Category')}</label>
          <CategorySelect
            id="create-channel-category"
            category={category}
            newCategory={newCategory}
            onCategoryChange={setCategory}
            onNewCategoryChange={setNewCategory}
          />
        </div>

        <div className="mb-lg">
          <label htmlFor="create-channel-topic" className="text-micro font-medium uppercase tracking-wide text-foreground-muted block mb-1.5">{t('channels.topicLabel', 'Topic')} ({t('channels.optional', 'optional')})</label>
          <textarea
            id="create-channel-topic"
            className="w-full py-2.5 pl-2.5 pr-8 rounded-sm bg-input text-foreground-primary text-base font-inherit box-border resize-y min-h-[60px]"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder={t('channels.topicPlaceholder', 'What is this channel about?')}
          />
        </div>

        <div className="flex justify-end gap-md mt-5">
          <button className="py-sm px-xl rounded-sm border-none text-base cursor-pointer bg-transparent text-foreground-primary hover:underline" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            className="py-sm px-xl rounded-sm border border-[var(--white-overlay-light)] text-base cursor-pointer bg-[var(--gradient-accent)] text-white shadow-[0_2px_8px_var(--accent-alpha-20)] transition-[filter,box-shadow] duration-150 hover:brightness-110 hover:shadow-[0_4px_16px_var(--accent-alpha-30)] disabled:opacity-50 disabled:cursor-not-allowed disabled:brightness-100 disabled:shadow-none"
            onClick={handleCreate}
            disabled={!name.trim() || creating}
          >
            {creating ? t('common.creating', 'Creating...') : t('channels.create')}
          </button>
        </div>
      </div>
    </dialog>
  );
}
