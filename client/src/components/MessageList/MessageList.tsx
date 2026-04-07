import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { IconMoodSmile, IconPlus, IconArrowBackUp, IconMessages, IconEdit, IconTrash, IconMessage, IconArrowDown } from '@tabler/icons-react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useMessageStore, type Message } from '../../stores/messageStore';
import { useTeamStore, type Member } from '../../stores/teamStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { api } from '../../services/api';
import { useDMStore } from '../../stores/dmStore';
import Reactions from '../Reactions/Reactions';
import FilePreview from '../FilePreview/FilePreview';
import EmojiPicker from '../EmojiPicker/EmojiPicker';
import UserProfile from '../UserProfile/UserProfile';
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
  scrollTrigger?: number;
}

// Sanitize links to open in new tab
const markdownComponents = {
  a: ({ ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props} target="_blank" rel="noopener noreferrer" />
  ),
};

const START_INDEX = 100000;

function formatDateDivider(dateStr: string): string {
  const date = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

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
  const [atBottom, setAtBottom] = useState(true);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [profilePopup, setProfilePopup] = useState<{ member: Member; x: number; y: number } | null>(null);
  const groups = groupMessages(channelMessages);

  const { members: membersMap, activeTeamId } = useTeamStore();
  const teamPresences = usePresenceStore((s) => (activeTeamId ? s.presences[activeTeamId] : undefined)) ?? {};
  const { setActiveDM } = useDMStore();
  const teamMembers = (activeTeamId ? membersMap.get(activeTeamId) : undefined) ?? [];

  const handleUserClick = (e: React.MouseEvent, authorId: string) => {
    e.stopPropagation();
    const member = teamMembers.find((m) => m.userId === authorId);
    if (!member) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // Position popup to the right of the clicked element, vertically aligned to its top
    const POPUP_WIDTH = 300;
    const GAP = 12;
    let x = rect.right + GAP;
    // If it would overflow viewport, place it to the left instead
    if (x + POPUP_WIDTH > window.innerWidth - 16) {
      x = Math.max(16, rect.left - POPUP_WIDTH - GAP);
    }
    const y = Math.min(rect.top, window.innerHeight - 360);
    setProfilePopup({ member, x, y });
  };

  const handleSendMessage = async (member: Member) => {
    if (!activeTeamId || member.userId === currentUserId) return;
    try {
      const dm = await api.createDM(activeTeamId, [member.userId]) as { id: string };
      setActiveDM(dm.id);
      setProfilePopup(null);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (!profilePopup) return;
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.user-profile-popover')) return;
      setProfilePopup(null);
    };
    const timer = setTimeout(() => document.addEventListener('mousedown', close), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', close);
    };
  }, [profilePopup]);

  const firstItemIndex = useMemo(() => START_INDEX - groups.length, [groups.length]);

  // Reset pill state on channel change
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: reset scroll pill state when switching channels
    setNewMessageCount(0);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: reset scroll pill state when switching channels
    setAtBottom(true);
  }, [channelId]);

  // Scroll to bottom on channel change
  useEffect(() => {
    if (virtuosoRef.current) {
      virtuosoRef.current.scrollToIndex({ index: START_INDEX - 1, align: 'end', behavior: 'auto' });
    }
  }, [channelId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Track new messages when scrolled up; scroll to bottom automatically when at bottom
  const prevMsgCount = useRef(channelMessages.length);
  useEffect(() => {
    if (channelMessages.length > prevMsgCount.current) {
      if (atBottom) {
        // Small delay to let Virtuoso render the new item first
        setTimeout(() => {
          virtuosoRef.current?.scrollToIndex({ index: START_INDEX - 1, align: 'end', behavior: 'smooth' });
        }, 50);
      } else {
        setNewMessageCount((prev) => prev + (channelMessages.length - prevMsgCount.current));
      }
    }
    prevMsgCount.current = channelMessages.length;
  }, [channelMessages.length, groups.length, atBottom]);

  const handleStartReached = useCallback(() => {
    if (canLoadMore && !isLoading) {
      onLoadMore();
    }
  }, [canLoadMore, isLoading, onLoadMore]);

  return (
    <div className="message-list-container">
    <Virtuoso
      ref={virtuosoRef}
      style={{ flex: 1 }}
      className="message-list"
      role="log"
      aria-live="polite"
      firstItemIndex={firstItemIndex}
      initialTopMostItemIndex={groups.length - 1}
      data={groups}
      followOutput={() => 'smooth'}
      startReached={handleStartReached}
      atBottomStateChange={(bottom) => {
        setAtBottom(bottom);
        if (bottom) setNewMessageCount(0);
      }}
      components={{
        Footer: () => <div style={{ height: 'var(--spacing-2xl)', minHeight: 32 }} />,
        Header: () => (
          <>
            {isLoading && <MessageSkeleton count={5} />}
            {!canLoadMore && channelMessages.length > 0 && (
              <div className="message-list-beginning">
                {t('channels.welcomeTitle', 'Welcome to ~{{name}}', { name: channelName })}
              </div>
            )}
          </>
        ),
      }}
      itemContent={(index, group) => {
        const firstMsg = group.messages[0];
        const isSystem = firstMsg.type === 'system';

        const currentDate = new Date(firstMsg.createdAt).toDateString();
        const groupIndex = index - firstItemIndex;
        const prevGroup = groupIndex > 0 ? groups[groupIndex - 1] : null;
        const prevDate = prevGroup ? new Date(prevGroup.messages[0].createdAt).toDateString() : null;
        const showDateDivider = !prevDate || prevDate !== currentDate;

        if (isSystem) {
          return (
            <>
              {showDateDivider && (
                <div className="date-divider">
                  <span className="date-divider-text">{formatDateDivider(firstMsg.createdAt)}</span>
                </div>
              )}
              <div className="message-system">
                <span className="message-system-text">{firstMsg.content}</span>
              </div>
            </>
          );
        }

        return (
          <>
            {showDateDivider && (
              <div className="date-divider">
                <span className="date-divider-text">{formatDateDivider(firstMsg.createdAt)}</span>
              </div>
            )}
            <div className="message-group">
              <div className="message-group-avatar">
                <div
                  className="message-avatar"
                  style={{ backgroundColor: usernameColor(group.username) }}
                  onClick={(e) => handleUserClick(e, group.authorId)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleUserClick(e as unknown as React.MouseEvent, group.authorId);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  {getInitials(group.username)}
                </div>
              </div>
              <div className="message-group-content">
                <div className="message-group-header">
                  <span
                    className="message-username"
                    style={{ color: usernameColor(group.username) }}
                    onClick={(e) => handleUserClick(e, group.authorId)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleUserClick(e as unknown as React.MouseEvent, group.authorId);
                      }
                    }}
                    role="button"
                    tabIndex={0}
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
                          className="message-action-btn clickable"
                          onClick={() =>
                            setEmojiPickerMsgId(
                              emojiPickerMsgId === msg.id ? null : msg.id,
                            )
                          }
                          title={t('reactions.addReaction', 'Add Reaction')}
                        >
                          <span className="message-action-icon">
                            <IconMoodSmile size={16} stroke={1.75} />
                            <IconPlus size={10} stroke={1.75} />
                          </span>
                        </button>
                      )}
                      {onReply && (
                        <button
                          className="message-action-btn clickable"
                          onClick={() => onReply(msg)}
                          title={t('messages.reply', 'Reply')}
                        >
                          <IconArrowBackUp size={20} stroke={1.75} />
                        </button>
                      )}
                      {onCreateThread && (
                        <button
                          className="message-action-btn clickable"
                          onClick={() => onCreateThread(msg)}
                          title={t('thread.createThread', 'Create Thread')}
                        >
                          <IconMessages size={20} stroke={1.75} />
                        </button>
                      )}
                      {msg.authorId === currentUserId && onEdit && (
                        <button
                          className="message-action-btn clickable"
                          onClick={() => onEdit(msg)}
                          title={t('messages.edit', 'Edit Message')}
                        >
                          <IconEdit size={20} stroke={1.75} />
                        </button>
                      )}
                      {msg.authorId === currentUserId && onDelete && (
                        <button
                          className="message-action-btn danger clickable"
                          onClick={() => onDelete(msg)}
                          title={t('messages.delete', 'Delete Message')}
                        >
                          <IconTrash size={20} stroke={1.75} />
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
                        <IconMessage size={16} stroke={1.75} />
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
          </>
        );
      }}
    />
    {!atBottom && (
      <button
        className="scroll-to-bottom-pill"
        onClick={() =>
          virtuosoRef.current?.scrollToIndex({ index: START_INDEX - 1, align: 'end', behavior: 'smooth' })
        }
        type="button"
      >
        <IconArrowDown size={14} stroke={1.75} />
        {newMessageCount > 0
          ? `${newMessageCount} new message${newMessageCount > 1 ? 's' : ''}`
          : 'Jump to latest'}
      </button>
    )}
    {profilePopup && (
      <UserProfile
        member={profilePopup.member}
        presence={teamPresences[profilePopup.member.userId]}
        x={profilePopup.x}
        y={profilePopup.y}
        onSendMessage={
          profilePopup.member.userId === currentUserId
            ? undefined
            : () => handleSendMessage(profilePopup.member)
        }
      />
    )}
    </div>
  );
}
