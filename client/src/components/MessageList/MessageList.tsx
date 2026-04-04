import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Emoji, Plus, Reply, Threads, EditPencil, Trash, ChatBubble } from 'iconoir-react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useMessageStore, type Message } from '../../stores/messageStore';
import Reactions from '../Reactions/Reactions';
import FilePreview from '../FilePreview/FilePreview';
import EmojiPicker from '../EmojiPicker/EmojiPicker';
import type { Attachment } from '../../services/api';
import MessageSkeleton from '../Skeleton/MessageSkeleton';
import { usernameColor, getInitials } from '../../utils/colors';
import { groupMessages, formatTime } from '../../utils/messageGrouping';

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
  scrollTrigger?: number;
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
  const { messages, loadingHistory, hasMore } = useMessageStore();
  const channelMessages = messages.get(channelId) ?? [];
  const isLoading = loadingHistory.get(channelId) ?? false;
  const canLoadMore = hasMore.get(channelId) ?? true;
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

  // Scroll to bottom when new messages arrive (e.g. after send + server echo)
  const prevMsgCount = useRef(channelMessages.length);
  useEffect(() => {
    if (channelMessages.length > prevMsgCount.current && virtuosoRef.current) {
      // Small delay to let Virtuoso render the new item first
      setTimeout(() => {
        virtuosoRef.current?.scrollToIndex({ index: groups.length - 1, behavior: 'smooth' });
      }, 50);
    }
    prevMsgCount.current = channelMessages.length;
  }, [channelMessages.length, groups.length]);

  const handleStartReached = useCallback(() => {
    if (canLoadMore && !isLoading) {
      onLoadMore();
    }
  }, [canLoadMore, isLoading, onLoadMore]);

  return (
    <Virtuoso
      ref={virtuosoRef}
      style={{ flex: 1 }}
      className="flex-1 pt-sm"
      role="log"
      aria-live="polite"
      firstItemIndex={firstItemIndex}
      initialTopMostItemIndex={groups.length - 1}
      data={groups}
      followOutput={() => 'smooth'}
      startReached={handleStartReached}
      components={{
        Header: () => (
          <>
            {isLoading && <MessageSkeleton count={5} />}
            {!canLoadMore && channelMessages.length > 0 && (
              <div className="text-center p-lg text-foreground-muted text-base font-display font-semibold border-b border-divider mb-sm">
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
            <div className="flex justify-center px-lg py-xs" data-testid="system-message">
              <span className="text-sm tracking-wide uppercase font-medium text-foreground-muted">
                {firstMsg.content}
              </span>
            </div>
          );
        }

        return (
          <div className="flex pr-12 pl-lg mt-[1.0625rem] relative first:mt-4"
               style={{ paddingRight: '48px' }}
               data-testid="message-group">
            <div className="shrink-0 w-10 mr-lg mt-0.5">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center text-[15px] font-semibold text-interactive-active select-none cursor-pointer transition-opacity duration-150 hover:opacity-85"
                style={{ backgroundColor: usernameColor(group.username) }}
              >
                {getInitials(group.username)}
              </div>
            </div>
            <div className="flex-1 min-w-0 text-left">
              <div className="flex items-baseline gap-1.5 mb-0.5 leading-[1.375rem]">
                <span
                  className="text-lg font-medium text-heading cursor-pointer hover:underline"
                  style={{ color: usernameColor(group.username) }}
                >
                  {group.username}
                </span>
                <span className="text-xs text-foreground-muted font-medium">
                  {formatTime(firstMsg.createdAt)}
                </span>
              </div>
              {group.messages.map((msg) => (
                <div
                  key={msg.id}
                  id={`msg-${msg.id}`}
                  className={`group/msg relative py-0.5 leading-[1.375rem] min-h-[1.375rem] hover:bg-surface-hover hover:rounded-sm hover:mx-[-0.25rem] hover:px-xs ${msg.deleted ? 'opacity-50' : ''}`}
                >
                  {msg.deleted ? (
                    <span className="text-lg text-foreground-muted opacity-50">
                      {t('messages.deleted', '[message deleted]')}
                    </span>
                  ) : (
                    <div className="message-content text-lg text-foreground break-words overflow-wrap-anywhere leading-[1.375rem]">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={markdownComponents}
                        skipHtml
                      >
                        {msg.content.replace(/^\[DEV: unencrypted\] /, '')}
                      </ReactMarkdown>
                      {msg.editedAt && (
                        <span className="text-[0.625rem] text-foreground-muted ml-xs font-normal">
                          {t('messages.edited', '(edited)')}
                        </span>
                      )}
                    </div>
                  )}
                  {!msg.deleted && (
                    <div className="hidden group-hover/msg:flex group-focus-within/msg:flex absolute -top-4 -right-8 bg-glass-floating backdrop-blur-glass-light border border-glass-border rounded-md p-0.5 gap-0 z-[1] shadow-[0_2px_8px_0_var(--overlay-light)]" data-testid="message-actions">
                      {onReaction && (
                        <button
                          className="bg-transparent border-none text-interactive p-xs px-sm text-md leading-none clickable hover:text-interactive-hover"
                          onClick={() =>
                            setEmojiPickerMsgId(
                              emojiPickerMsgId === msg.id ? null : msg.id,
                            )
                          }
                          title={t('reactions.addReaction', 'Add Reaction')}
                        >
                          <span className="flex items-center">
                            <Emoji width={16} height={16} strokeWidth={2} />
                            <Plus width={10} height={10} strokeWidth={2} />
                          </span>
                        </button>
                      )}
                      {onReply && (
                        <button
                          className="bg-transparent border-none text-interactive p-xs px-sm text-md leading-none clickable hover:text-interactive-hover"
                          onClick={() => onReply(msg)}
                          title={t('messages.reply', 'Reply')}
                        >
                          <Reply width={20} height={20} strokeWidth={2} />
                        </button>
                      )}
                      {onCreateThread && (
                        <button
                          className="bg-transparent border-none text-interactive p-xs px-sm text-md leading-none clickable hover:text-interactive-hover"
                          onClick={() => onCreateThread(msg)}
                          title={t('thread.createThread', 'Create Thread')}
                        >
                          <Threads width={20} height={20} strokeWidth={2} />
                        </button>
                      )}
                      {msg.authorId === currentUserId && onEdit && (
                        <button
                          className="bg-transparent border-none text-interactive p-xs px-sm text-md leading-none clickable hover:text-interactive-hover"
                          onClick={() => onEdit(msg)}
                          title={t('messages.edit', 'Edit Message')}
                        >
                          <EditPencil width={20} height={20} strokeWidth={2} />
                        </button>
                      )}
                      {msg.authorId === currentUserId && onDelete && (
                        <button
                          className="bg-transparent border-none text-interactive p-xs px-sm text-md leading-none clickable hover:text-foreground-danger"
                          onClick={() => onDelete(msg)}
                          title={t('messages.delete', 'Delete Message')}
                        >
                          <Trash width={20} height={20} strokeWidth={2} />
                        </button>
                      )}
                    </div>
                  )}
                  {emojiPickerMsgId === msg.id && (
                    <div className="relative z-[100]">
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
                      className="flex items-center gap-1.5 mt-xs py-0.5 px-sm pl-[3px] bg-transparent border-none rounded-md cursor-pointer text-base text-foreground-link font-medium transition-colors duration-150 hover:bg-surface-hover"
                      onClick={() => onOpenThread?.(msg.id)}
                    >
                      <span className="text-lg">
                        <ChatBubble width={16} height={16} strokeWidth={2} />
                      </span>
                      <span className="font-semibold">
                        {threadInfo[msg.id].count === 1
                          ? t('thread.reply', '1 reply')
                          : t('thread.replies', '{{count}} replies', {
                              count: threadInfo[msg.id].count,
                            })}
                      </span>
                      {threadInfo[msg.id].lastReplyAt && (
                        <span className="text-foreground-muted text-xs font-normal">
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
