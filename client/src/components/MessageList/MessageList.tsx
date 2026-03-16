import { useRef, useEffect, useCallback, useState, type UIEvent } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Emoji, Plus, Reply, Threads, EditPencil, Trash, ChatBubble } from 'iconoir-react';
import { useMessageStore, type Message } from '../../stores/messageStore';
import Reactions from '../Reactions/Reactions';
import FilePreview from '../FilePreview/FilePreview';
import EmojiPicker from '../EmojiPicker/EmojiPicker';
import type { Attachment } from '../../services/api';
import { usernameColor } from '../../utils/colors';
import './MessageList.css';

interface Props {
  channelId: string;
  channelName?: string;
  teamId?: string;
  currentUserId: string;
  onLoadMore: () => void;
  onReply?: (message: Message) => void;
  onEdit?: (message: Message) => void;
  onDelete?: (message: Message) => void;
  onCreateThread?: (message: Message) => void;
  onOpenThread?: (messageId: string) => void;
  onReaction?: (messageId: string, emoji: string) => void;
  threadInfo?: Record<string, { count: number; lastReplyAt: string | null }>;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (isToday) return `Today at ${time}`;
  if (isYesterday) return `Yesterday at ${time}`;
  return `${date.toLocaleDateString()} ${time}`;
}

function getInitials(username: string): string {
  return (username || '?').slice(0, 2).toUpperCase();
}


interface MessageGroup {
  authorId: string;
  username: string;
  messages: Message[];
}

function groupMessages(messages: Message[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  for (const msg of messages) {
    const last = groups[groups.length - 1];
    const isSystem = msg.type === 'system';
    if (
      !isSystem &&
      last &&
      last.authorId === msg.authorId &&
      !msg.deleted
    ) {
      // Group if within 7 minutes of previous
      const lastMsg = last.messages[last.messages.length - 1];
      const timeDiff =
        new Date(msg.createdAt).getTime() - new Date(lastMsg.createdAt).getTime();
      if (timeDiff < 7 * 60 * 1000) {
        last.messages.push(msg);
        continue;
      }
    }
    groups.push({
      authorId: msg.authorId,
      username: msg.username,
      messages: [msg],
    });
  }
  return groups;
}

// Sanitize links to open in new tab
const markdownComponents = {
  a: ({ ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props} target="_blank" rel="noopener noreferrer" />
  ),
};

export default function MessageList({
  channelId,
  channelName = '',
  teamId = '',
  currentUserId,
  onLoadMore,
  onReply,
  onEdit,
  onDelete,
  onCreateThread,
  onOpenThread,
  onReaction,
  threadInfo,
}: Props) {
  const { t } = useTranslation();
  const { messages, loadingHistory, hasMore } = useMessageStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);
  const prevScrollHeight = useRef(0);
  const [emojiPickerMsgId, setEmojiPickerMsgId] = useState<string | null>(null);

  const channelMessages = messages.get(channelId) ?? [];
  const isLoading = loadingHistory.get(channelId) ?? false;
  const canLoadMore = hasMore.get(channelId) ?? true;
  const groups = groupMessages(channelMessages);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (shouldAutoScroll.current && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [channelMessages.length]);

  // Scroll to bottom on channel change
  useEffect(() => {
    shouldAutoScroll.current = true;
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView();
    }
  }, [channelId]);

  // Preserve scroll position when prepending history
  useEffect(() => {
    const container = containerRef.current;
    if (container && prevScrollHeight.current > 0) {
      const newScrollHeight = container.scrollHeight;
      container.scrollTop = newScrollHeight - prevScrollHeight.current;
      prevScrollHeight.current = 0;
    }
  }, [channelMessages.length]);

  const handleScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
      shouldAutoScroll.current = atBottom;

      // Load more when scrolled to top
      if (el.scrollTop < 100 && canLoadMore && !isLoading) {
        prevScrollHeight.current = el.scrollHeight;
        onLoadMore();
      }
    },
    [canLoadMore, isLoading, onLoadMore],
  );

  return (
    <div className="message-list" ref={containerRef} onScroll={handleScroll}>
      {isLoading && (
        <div className="message-list-loading">{t('app.loading', 'Loading...')}</div>
      )}
      {!canLoadMore && channelMessages.length > 0 && (
        <div className="message-list-beginning" style={{ fontFamily: 'var(--font-display)' }}>
          {t('channels.welcomeTitle', 'Welcome to ~{{name}}', { name: channelName })}
        </div>
      )}

      {groups.map((group) => {
        const firstMsg = group.messages[0];
        const isSystem = firstMsg.type === 'system';

        if (isSystem) {
          return (
            <div key={firstMsg.id} className="message-system">
              <span className="message-system-text">{firstMsg.content}</span>
            </div>
          );
        }

        return (
          <div key={firstMsg.id} className="message-group">
            <div className="message-group-avatar">
              <div
                className="message-avatar"
                style={{ backgroundColor: usernameColor(group.username) }}
              >
                {getInitials(group.username)}
              </div>
            </div>
            <div className="message-group-content">
              <div className="message-group-header">
                <span
                  className="message-username"
                  style={{ color: usernameColor(group.username) }}
                >
                  {group.username}
                </span>
                <span className="message-timestamp">{formatTime(firstMsg.createdAt)}</span>
              </div>
              {group.messages.map((msg) => (
                <div
                  key={msg.id}
                  id={`msg-${msg.id}`}
                  className={`message-item ${msg.deleted ? 'deleted' : ''}`}
                >
                  {msg.deleted ? (
                    <span className="message-deleted-text">
                      {t('messages.deleted', '[message deleted]')}
                    </span>
                  ) : (
                    <div className="message-content">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={markdownComponents}
                        skipHtml
                      >
                        {msg.content.replace(/^\[DEV: unencrypted\] /, '')}
                      </ReactMarkdown>
                      {msg.editedAt && (
                        <span className="message-edited">
                          {t('messages.edited', '(edited)')}
                        </span>
                      )}
                    </div>
                  )}
                  {!msg.deleted && (
                    <div className="message-actions">
                      {onReaction && (
                        <button
                          className="message-action-btn"
                          onClick={() => setEmojiPickerMsgId(emojiPickerMsgId === msg.id ? null : msg.id)}
                          title={t('reactions.addReaction', 'Add Reaction')}
                        >
                        <span className="message-action-icon"><Emoji width={16} height={16} strokeWidth={2} /><Plus width={10} height={10} strokeWidth={2} /></span>
                        </button>
                      )}
                      {onReply && (
                        <button
                          className="message-action-btn"
                          onClick={() => onReply(msg)}
                          title={t('messages.reply', 'Reply')}
                        >
                          <Reply width={20} height={20} strokeWidth={2} />
                        </button>
                      )}
                      {onCreateThread && (
                        <button
                          className="message-action-btn"
                          onClick={() => onCreateThread(msg)}
                          title={t('thread.createThread', 'Create Thread')}
                        >
                          <Threads width={20} height={20} strokeWidth={2} />
                        </button>
                      )}
                      {msg.authorId === currentUserId && onEdit && (
                        <button
                          className="message-action-btn"
                          onClick={() => onEdit(msg)}
                          title={t('messages.edit', 'Edit Message')}
                        >
                          <EditPencil width={20} height={20} strokeWidth={2} />
                        </button>
                      )}
                      {msg.authorId === currentUserId && onDelete && (
                        <button
                          className="message-action-btn danger"
                          onClick={() => onDelete(msg)}
                          title={t('messages.delete', 'Delete Message')}
                        >
                          <Trash width={20} height={20} strokeWidth={2} />
                        </button>
                      )}
                    </div>
                  )}
                  {emojiPickerMsgId === msg.id && (
                    <div className="message-emoji-picker-anchor">
                      <EmojiPicker
                        onSelect={(emoji) => {
                          onReaction?.(msg.id, emoji);
                          setEmojiPickerMsgId(null);
                        }}
                        onClose={() => setEmojiPickerMsgId(null)}
                      />
                    </div>
                  )}
                  {!msg.deleted && (msg as Message & { attachments?: Attachment[] }).attachments && (
                    <FilePreview
                      attachments={(msg as Message & { attachments?: Attachment[] }).attachments!}
                      teamId={teamId}
                    />
                  )}
                  {!msg.deleted && msg.reactions && msg.reactions.length > 0 && (
                    <Reactions
                      reactions={msg.reactions}
                      currentUserId={currentUserId}
                      onToggleReaction={(emoji) => onReaction?.(msg.id, emoji)}
                      onAddReaction={(emoji) => onReaction?.(msg.id, emoji)}
                    />
                  )}
                  {threadInfo?.[msg.id] && (
                    <button
                      className="message-thread-indicator"
                      onClick={() => onOpenThread?.(msg.id)}
                    >
                      <span className="thread-indicator-icon"><ChatBubble width={16} height={16} strokeWidth={2} /></span>
                      <span className="thread-indicator-count">
                        {threadInfo[msg.id].count === 1
                          ? t('thread.reply', '1 reply')
                          : t('thread.replies', '{{count}} replies', { count: threadInfo[msg.id].count })}
                      </span>
                      {threadInfo[msg.id].lastReplyAt && (
                        <span className="thread-indicator-time">
                          {t('thread.lastReply', 'Last reply {{time}}', {
                            time: formatTime(threadInfo[msg.id].lastReplyAt!),
                          })}
                        </span>
                      )}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}

      <div ref={bottomRef} />
    </div>
  );
}
