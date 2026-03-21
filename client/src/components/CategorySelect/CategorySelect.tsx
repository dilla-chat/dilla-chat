import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useTeamStore } from '../../stores/teamStore';

interface CategorySelectProps {
  id: string;
  category: string;
  newCategory: string;
  onCategoryChange: (value: string) => void;
  onNewCategoryChange: (value: string) => void;
  className?: string;
}

export default function CategorySelect({
  id,
  category,
  newCategory,
  onCategoryChange,
  onNewCategoryChange,
  className,
}: Readonly<CategorySelectProps>) {
  const { t } = useTranslation();
  const { activeTeamId, channels } = useTeamStore();

  const existingCategories = useMemo(() => {
    if (!activeTeamId) return [];
    const chans = channels.get(activeTeamId) ?? [];
    const uiLabels = new Set([
      t('channels.voiceChannels', 'Voice Channels'),
      t('channels.textChannels', 'Text Channels'),
    ]);
    return [
      ...new Set(
        chans.map((c) => c.category).filter((c): c is string => Boolean(c) && !uiLabels.has(c)),
      ),
    ];
  }, [activeTeamId, channels, t]);

  return (
    <>
      <select id={id} value={category} onChange={(e) => onCategoryChange(e.target.value)}>
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
          onChange={(e) => onNewCategoryChange(e.target.value)}
          placeholder={t('channels.categoryPlaceholder', 'Category name')}
          className={className}
          style={{ marginTop: 8 }}
        />
      )}
    </>
  );
}
