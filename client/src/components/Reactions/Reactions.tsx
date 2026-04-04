import { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'iconoir-react';
import type { Reaction } from '../../stores/messageStore';
import EmojiPicker from '../EmojiPicker/EmojiPicker';

interface Props {
  reactions: Reaction[];
  currentUserId: string;
  onToggleReaction: (emoji: string) => void;
  onAddReaction: (emoji: string) => void;
}

export default function Reactions({ reactions, currentUserId, onToggleReaction, onAddReaction }: Readonly<Props>) {
  const { t } = useTranslation();
  const [showPicker, setShowPicker] = useState(false);
  const [hoveredEmoji, setHoveredEmoji] = useState<string | null>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);

  if (reactions.length === 0 && !showPicker) return null;

  return (
    <div className="flex flex-wrap gap-xs mt-xs items-center">
      {reactions.map((r) => {
        const isMe = r.users.includes(currentUserId);
        return (
          <button
            key={r.emoji}
            className={`inline-flex items-center gap-xs px-sm rounded-md text-base h-6 relative clickable ${
              isMe
                ? 'border border-brand bg-brand-a15 text-brand hover:bg-brand-a20 hover:border-brand'
                : 'bg-surface-tertiary border border-transparent text-foreground-muted hover:bg-surface-active hover:border-white-overlay-subtle'
            }`}
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
            <span className="text-lg leading-none">{r.emoji}</span>
            <span className={`text-sm font-medium min-w-[9px] text-center ${isMe ? 'text-brand' : 'text-foreground-muted'}`}>{r.count}</span>
            {hoveredEmoji === r.emoji && (
              <span className="absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2 bg-glass-floating backdrop-blur-glass-heavy border border-glass-border text-heading px-md py-sm rounded-sm text-base font-medium whitespace-nowrap pointer-events-none z-50 shadow-[0_8px_16px_var(--overlay-light)]">
                {r.users.length <= 3
                  ? r.users.join(', ')
                  : r.users.slice(0, 3).join(', ') + ` +${r.users.length - 3}`}
              </span>
            )}
          </button>
        );
      })}
      <div className="relative inline-flex items-center">
        <button
          ref={addBtnRef}
          className="inline-flex items-center justify-center w-7 h-6 p-0 rounded-md bg-surface-tertiary border border-transparent text-interactive text-base font-normal clickable hover:bg-surface-active hover:border-white-overlay-subtle hover:text-interactive-hover"
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
