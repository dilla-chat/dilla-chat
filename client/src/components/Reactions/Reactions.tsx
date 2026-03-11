import { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'iconoir-react';
import type { Reaction } from '../../stores/messageStore';
import EmojiPicker from '../EmojiPicker/EmojiPicker';
import './Reactions.css';

interface Props {
  reactions: Reaction[];
  currentUserId: string;
  onToggleReaction: (emoji: string) => void;
  onAddReaction: (emoji: string) => void;
}

export default function Reactions({ reactions, currentUserId, onToggleReaction, onAddReaction }: Props) {
  const { t } = useTranslation();
  const [showPicker, setShowPicker] = useState(false);
  const [hoveredEmoji, setHoveredEmoji] = useState<string | null>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);

  if (reactions.length === 0 && !showPicker) return null;

  return (
    <div className="reactions-row">
      {reactions.map((r) => {
        const isMe = r.users.includes(currentUserId);
        return (
          <button
            key={r.emoji}
            className={`reaction-chip ${isMe ? 'reaction-chip-active' : ''}`}
            onClick={() => onToggleReaction(r.emoji)}
            onMouseEnter={() => setHoveredEmoji(r.emoji)}
            onMouseLeave={() => setHoveredEmoji(null)}
            title={
              r.users.length <= 3
                ? t('reactions.reactedBy', 'Reacted by {{users}}', { users: r.users.join(', ') })
                : t('reactions.reactedBy', 'Reacted by {{users}}', {
                    users: r.users.slice(0, 3).join(', '),
                  }) +
                  ' ' +
                  t('reactions.andMore', 'and {{count}} more', { count: r.users.length - 3 })
            }
          >
            <span className="reaction-emoji">{r.emoji}</span>
            <span className="reaction-count">{r.count}</span>
            {hoveredEmoji === r.emoji && (
              <span className="reaction-tooltip">
                {r.users.length <= 3
                  ? r.users.join(', ')
                  : r.users.slice(0, 3).join(', ') + ` +${r.users.length - 3}`}
              </span>
            )}
          </button>
        );
      })}
      <div className="reaction-add-wrapper">
        <button
          ref={addBtnRef}
          className="reaction-add-btn"
          onClick={() => setShowPicker(!showPicker)}
          title={t('reactions.addReaction', 'Add Reaction')}
        >
          <Plus width={18} height={18} strokeWidth={2.5} />
        </button>
        {showPicker && (
          <EmojiPicker
            onSelect={(emoji) => {
              onAddReaction(emoji);
              setShowPicker(false);
            }}
            onClose={() => setShowPicker(false)}
          />
        )}
      </div>
    </div>
  );
}
