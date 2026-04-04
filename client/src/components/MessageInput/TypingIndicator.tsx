import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useMessageStore } from '../../stores/messageStore';

const TYPING_EXPIRY_MS = 5_000;

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
    text = t('messages.typingOne', '{{name}} is typing...', { name: typingUsers[0].username });
  } else if (typingUsers.length === 2) {
    text = t('messages.typingTwo', '{{name1}} and {{name2}} are typing...', {
      name1: typingUsers[0].username,
      name2: typingUsers[1].username,
    });
  } else {
    text = t('messages.typingSeveral', 'Several people are typing...');
  }

  return (
    <div className="text-xs text-foreground-muted px-1 py-0.5 min-h-[18px] font-medium" role="status" aria-live="polite">
      {text}
    </div>
  );
}
