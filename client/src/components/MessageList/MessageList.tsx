import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Emoji, Plus, Reply, Threads, EditPencil, Trash, ChatBubble } from 'iconoir-react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import type { Message } from '../../stores/messageStore';
import { useChannelMessages, useChannelLoading, useChannelHasMore } from '../../stores/selectors';
import Reactions from '../Reactions/Reactions';
import FilePreview from '../FilePreview/FilePreview';
import EmojiPicker from '../EmojiPicker/EmojiPicker';
import type { Attachment } from '../../services/api';
import MessageSkeleton from '../Skeleton/MessageSkeleton';
import { usernameColor, getInitials } from '../../utils/colors';
import { groupMessages, formatTime } from '../../utils/messageGrouping';
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

// Sanitize links to open in new tab
const markdownComponents = {
  a: ({ ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props} target="_blank" rel="noopener noreferrer" />
  ),
};

const START_INDEX = 100000;

export default function MessageList({
  channelId,
  channelName = '',
  currentUserId,
  onLoadMore,
  onReply,
  onEdit,
  onDelete,
  onCreateThread,
  onOpenThread,
  onReaction,
  threadInfo,
}: Readonly<Props>) {
  const { t } = useTranslation();
  const channelMessages = useChannelMessages(channelId);
  const isLoading = useChannelLoading(channelId);
  const canLoadMore = useChannelHasMore(channelId);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [emojiPickerMsgId, setEmojiPickerMsgId] = useState<string | null>(null);
  const groups = groupMessages(channelMessages);

  const firstItemIndex = useMemo(() => START_INDEX - groups.length, [groups.length]);

  // Scroll to bottom on channel change
  useEffect(() => {
    if (virtuosoRef.current) {
      virtuosoRef.current.scrollToIndex({ index: groups.length - 1, behavior: 'auto' });
    }
  }, [channelId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleStartReached = useCallback(() => {
    if (canLoadMore && !isLoading) {
      onLoadMore();
    }
  }, [canLoadMore, isLoading, onLoadMore]);

  return (
    <Virtuoso
      ref={virtuosoRef}
      style={{ flex: 1 }}
      className="message-list"
      role="log"
      aria-live="polite"
      firstItemIndex={firstItemIndex}
      initialTopMostItemIndex={groups.length - 1}
      data={groups}
      followOutput="smooth"
      startReached={handleStartReached}
      components={{
        Header: () => (
          <>
            {isLoading && <MessageSkeleton count={5} />}
            {!canLoadMore && channelMessages.length > 0 && (
              <div
                className="message-list-beginning"
                style={{ fontFamily: 'var(--font-display)' }}
              >
                {t('channels.welcomeTitle', 'Welcome to ~{{name}}', { name: channelName })}
              </div>
            )}
          </>
        ),
      }}
      itemContent={(_index, group) => {
        const firstMsg = group.messages[0];
        const isSystem = firstMsg.type === 'system';

        if (isSystem) {
          return (
            <div className="message-system">
              <span className="message-system-text">{firstMsg.content}</span>
            </div>
          );
        }

        return (
          <div className="message-group">
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
                          onClick={() =>
                            setEmojiPickerMsgId(
                              emojiPickerMsgId === msg.id ? null : msg.id,
                            )
                          }
                          title={t('reactions.addReaction', 'Add Reaction')}
                        >
                          <span className="message-action-icon">
                            <Emoji width={16} height={16} strokeWidth={2} />
                            <Plus width={10} height={10} strokeWidth={2} />
                          </span>
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
                  {!msg.deleted &&
                    (msg as Message & { attachments?: Attachment[] }).attachments && (
                      <FilePreview
                        attachments={
                          (msg as Message & { attachments?: Attachment[] }).attachments!
                        }
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
                      <span className="thread-indicator-icon">
                        <ChatBubble width={16} height={16} strokeWidth={2} />
                      </span>
                      <span className="thread-indicator-count">
                        {threadInfo[msg.id].count === 1
                          ? t('thread.reply', '1 reply')
                          : t('thread.replies', '{{count}} replies', {
                              count: threadInfo[msg.id].count,
                            })}
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
      }}
    />
  );
}
