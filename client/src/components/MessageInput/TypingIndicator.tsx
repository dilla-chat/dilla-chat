import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useMessageStore } from '../../stores/messageStore';

const TYPING_EXPIRY_MS = 5_000;

const AVATAR_COLORS = [
  '#0ea5c0',
  '#8b5cf6',
  '#ec4899',
  '#f59e0b',
  '#10b981',
  '#3b82f6',
];

function avatarColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export default function TypingIndicator({
  channelId,
  currentUserId,
}: Readonly<{ channelId: string; currentUserId: string }>) {
  const { t } = useTranslation();
  const typing = useMessageStore((s) => s.typing);
  const clearTyping = useMessageStore((s) => s.clearTyping);

  const typingUsers = (typing.get(channelId) ?? []).filter(
    (u) => u.userId !== currentUserId,
  );

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      for (const user of typingUsers) {
        if (now - user.timestamp > TYPING_EXPIRY_MS) {
          clearTyping(channelId, user.userId);
        }
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [channelId, typingUsers, clearTyping]);

  if (typingUsers.length === 0) return null;

  let text: string;
  if (typingUsers.length === 1) {
    text = t('messages.typingOne', '{{name}} is typing', { name: typingUsers[0].username });
  } else if (typingUsers.length === 2) {
    text = t('messages.typingTwo', '{{name1}} and {{name2}} are typing', {
      name1: typingUsers[0].username,
      name2: typingUsers[1].username,
    });
  } else {
    text = t('messages.typingSeveral', 'Several people are typing');
  }

  const visibleAvatars = typingUsers.slice(0, 3);

  return (
    <div className="typing-indicator" role="status" aria-live="polite">
      <div className="typing-indicator-avatars">
        {visibleAvatars.map((u) => (
          <div
            key={u.userId}
            className="typing-indicator-avatar"
            style={{ background: avatarColor(u.userId) }}
            title={u.username}
          >
            {u.username.charAt(0).toUpperCase()}
          </div>
        ))}
      </div>
      <span>{text}</span>
      <div className="typing-dots" aria-hidden="true">
        <div className="typing-dot" />
        <div className="typing-dot" />
        <div className="typing-dot" />
      </div>
    </div>
  );
}
