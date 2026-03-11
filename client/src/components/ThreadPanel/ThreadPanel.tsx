import { useRef, useEffect, useCallback, useState, type UIEvent } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Xmark, EditPencil, Trash } from 'iconoir-react';
import { useThreadStore, type Thread } from '../../stores/threadStore';
import { useMessageStore, type Message } from '../../stores/messageStore';
import { useAuthStore } from '../../stores/authStore';
import { useTeamStore } from '../../stores/teamStore';
import { api } from '../../services/api';
import { ws } from '../../services/websocket';
import { cryptoService } from '../../services/crypto';
import MessageInput from '../MessageInput/MessageInput';
import './ThreadPanel.css';

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
  return username.slice(0, 2).toUpperCase();
}

function usernameColor(username: string): string {
  const colors = [
    '#f44336', '#e91e63', '#9c27b0', '#673ab7',
    '#3f51b5', '#2196f3', '#03a9f4', '#00bcd4',
    '#009688', '#4caf50', '#8bc34a', '#ff9800',
  ];
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

const markdownComponents = {
  a: ({ ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props} target="_blank" rel="noopener noreferrer" />
  ),
};

interface ServerMessage {
  id: string;
  channel_id: string;
  author_id: string;
  username: string;
  content: string;
  type: string;
  thread_id: string | null;
  edited_at: string | null;
  deleted: boolean;
  created_at: string;
  reactions: Array<{ emoji: string; users: string[]; count: number }>;
}

function serverToMessage(msg: ServerMessage): Message {
  return {
    id: msg.id,
    channelId: msg.channel_id,
    authorId: msg.author_id,
    username: msg.username,
    content: msg.content,
    encryptedContent: msg.content,
    type: msg.type,
    threadId: msg.thread_id,
    editedAt: msg.edited_at,
    deleted: msg.deleted,
    createdAt: msg.created_at,
    reactions: msg.reactions ?? [],
  };
}

const THREAD_PAGE_SIZE = 50;

interface Props {
  thread: Thread;
  onClose: () => void;
}

export default function ThreadPanel({ thread, onClose }: Props) {
  const { t } = useTranslation();
  const { activeTeamId } = useTeamStore();
  const { teams, derivedKey } = useAuthStore();
  const { threadMessages, setThreadMessages, addThreadMessage, updateThreadMessage, removeThreadMessage } =
    useThreadStore();
  const { messages: channelMessages } = useMessageStore();

  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [editingMessage, setEditingMessage] = useState<{ id: string; content: string } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);
  const initialLoadDone = useRef<Set<string>>(new Set());

  const teamEntry = activeTeamId ? teams.get(activeTeamId) : null;
  const currentUser = teamEntry?.user as { id?: string; username?: string } | null;
  const currentUserId = currentUser?.id ?? '';

  const msgs = threadMessages[thread.id] ?? [];

  // Find parent message from channel messages
  const allChannelMsgs = channelMessages.get(thread.channel_id) ?? [];
  const parentMessage = allChannelMsgs.find((m) => m.id === thread.parent_message_id);

  // Load thread messages
  useEffect(() => {
    if (!activeTeamId || initialLoadDone.current.has(thread.id)) return;

    const load = async () => {
      setLoading(true);
      try {
        let raw: ServerMessage[];
        if (ws.isConnected(activeTeamId)) {
          raw = await ws.request<ServerMessage[]>(activeTeamId, 'threads:messages', {
            thread_id: thread.id, limit: THREAD_PAGE_SIZE,
          });
        } else {
          raw = await api.getThreadMessages(activeTeamId, thread.id) as ServerMessage[];
        }
        const converted = await Promise.all(
          raw.map(async (msg) => {
            let content = msg.content;
            if (derivedKey) {
              try {
                content = await cryptoService.decryptMessage(
                  msg.author_id, msg.content, false, thread.channel_id, derivedKey,
                );
              } catch { /* use raw */ }
            }
            return { ...serverToMessage(msg), content };
          }),
        );
        setThreadMessages(thread.id, converted);
        setHasMore(converted.length >= THREAD_PAGE_SIZE);
        initialLoadDone.current.add(thread.id);
      } catch {
        // API may not be available
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [activeTeamId, thread.id, setThreadMessages]);

  // Subscribe to thread WebSocket events
  useEffect(() => {
    const unsubNew = ws.on('thread:message:new', async (payload: ServerMessage) => {
      if (payload.thread_id !== thread.id) return;
      let content = payload.content;
      if (derivedKey) {
        try {
          content = await cryptoService.decryptMessage(
            payload.author_id, payload.content, false, thread.channel_id, derivedKey,
          );
        } catch { /* use raw content */ }
      }
      addThreadMessage(thread.id, { ...serverToMessage(payload), content });
    });

    const unsubEdit = ws.on('thread:message:updated', async (payload: ServerMessage) => {
      if (payload.thread_id !== thread.id) return;
      let content = payload.content;
      if (derivedKey) {
        try {
          content = await cryptoService.decryptMessage(
            payload.author_id, payload.content, false, thread.channel_id, derivedKey,
          );
        } catch { /* use raw content */ }
      }
      updateThreadMessage(thread.id, { ...serverToMessage(payload), content });
    });

    const unsubDelete = ws.on('thread:message:deleted', (payload: { message_id: string; thread_id: string }) => {
      if (payload.thread_id !== thread.id) return;
      removeThreadMessage(thread.id, payload.message_id);
    });

    return () => {
      unsubNew();
      unsubEdit();
      unsubDelete();
    };
  }, [thread.id, addThreadMessage, updateThreadMessage, removeThreadMessage]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (shouldAutoScroll.current && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [msgs.length]);

  // Scroll to bottom on thread change
  useEffect(() => {
    shouldAutoScroll.current = true;
    initialLoadDone.current = new Set();
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView();
    }
  }, [thread.id]);

  const handleScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
      shouldAutoScroll.current = atBottom;

      if (el.scrollTop < 100 && hasMore && !loading) {
        handleLoadMore();
      }
    },
    [hasMore, loading],
  );

  const handleLoadMore = useCallback(async () => {
    if (!activeTeamId || loading || !hasMore) return;
    const oldestId = msgs.length > 0 ? msgs[0].id : undefined;
    setLoading(true);
    try {
      let raw: ServerMessage[];
      if (ws.isConnected(activeTeamId)) {
        raw = await ws.request<ServerMessage[]>(activeTeamId, 'threads:messages', {
          thread_id: thread.id, before: oldestId, limit: THREAD_PAGE_SIZE,
        });
      } else {
        raw = await api.getThreadMessages(activeTeamId, thread.id, oldestId, THREAD_PAGE_SIZE) as ServerMessage[];
      }
      const converted = raw.map(serverToMessage);
      const existingIds = new Set(msgs.map((m) => m.id));
      const newMsgs = converted.filter((m) => !existingIds.has(m.id));
      if (newMsgs.length > 0) {
        setThreadMessages(thread.id, [...newMsgs, ...msgs]);
      }
      setHasMore(converted.length >= THREAD_PAGE_SIZE);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [activeTeamId, thread.id, msgs, loading, hasMore, setThreadMessages]);

  const handleSend = useCallback(
    async (content: string) => {
      if (!activeTeamId) return;
      let encrypted = content;
      if (derivedKey) {
        try {
          encrypted = await cryptoService.encryptMessage(
            thread.channel_id, content, false, thread.channel_id, derivedKey,
          );
        } catch { /* fall through with plaintext */ }
      }
      ws.sendThreadMessage(activeTeamId, thread.id, encrypted);
    },
    [activeTeamId, thread.id, thread.channel_id, derivedKey],
  );

  const handleEdit = useCallback(
    async (messageId: string, content: string) => {
      if (!activeTeamId) return;
      let encrypted = content;
      if (derivedKey) {
        try {
          encrypted = await cryptoService.encryptMessage(
            thread.channel_id, content, false, thread.channel_id, derivedKey,
          );
        } catch { /* fall through */ }
      }
      ws.editThreadMessage(activeTeamId, thread.id, messageId, encrypted);
      setEditingMessage(null);
    },
    [activeTeamId, thread.id, thread.channel_id, derivedKey],
  );

  const handleDelete = useCallback(
    (messageId: string) => {
      if (!activeTeamId) return;
      ws.deleteThreadMessage(activeTeamId, thread.id, messageId);
    },
    [activeTeamId, thread.id],
  );

  const threadTitle = thread.title || t('thread.title', 'Thread');

  return (
    <div className="thread-panel">
      <div className="thread-panel-header">
        <div className="thread-panel-header-info">
          <div className="thread-panel-title">{threadTitle}</div>
          <div className="thread-panel-subtitle">
            {thread.message_count > 0
              ? thread.message_count === 1
                ? t('thread.reply', '1 reply')
                : t('thread.replies', '{{count}} replies', { count: thread.message_count })
              : t('thread.noReplies', 'No replies yet. Start the conversation!')}
          </div>
        </div>
        <button className="thread-panel-close" onClick={onClose} title={t('thread.closeThread', 'Close')}>
          <Xmark width={20} height={20} strokeWidth={2} />
        </button>
      </div>

      {/* Parent message */}
      {parentMessage && (
        <div className="thread-parent-message">
          <div className="thread-parent-header">
            <div
              className="thread-parent-avatar"
              style={{ backgroundColor: usernameColor(parentMessage.username) }}
            >
              {getInitials(parentMessage.username)}
            </div>
            <span className="thread-parent-username" style={{ color: usernameColor(parentMessage.username) }}>
              {parentMessage.username}
            </span>
            <span className="thread-parent-time">{formatTime(parentMessage.createdAt)}</span>
          </div>
          <div className="thread-parent-content">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {parentMessage.content}
            </ReactMarkdown>
          </div>
        </div>
      )}

      {/* Thread messages */}
      <div className="thread-messages" ref={containerRef} onScroll={handleScroll}>
        {loading && (
          <div className="thread-messages-loading">{t('app.loading', 'Loading...')}</div>
        )}

        {!loading && msgs.length === 0 && (
          <div className="thread-no-replies">
            {t('thread.noReplies', 'No replies yet. Start the conversation!')}
          </div>
        )}

        {msgs.length > 0 && (
          <div className="thread-reply-count">
            {msgs.length === 1
              ? t('thread.reply', '1 reply')
              : t('thread.replies', '{{count}} replies', { count: msgs.length })}
          </div>
        )}

        {msgs.map((msg) => (
          <div key={msg.id} className="thread-message-group">
            <div className="thread-message-avatar-col">
              <div
                className="thread-message-avatar"
                style={{ backgroundColor: usernameColor(msg.username) }}
              >
                {getInitials(msg.username)}
              </div>
            </div>
            <div className="thread-message-content-col">
              <div className="thread-message-header">
                <span className="thread-message-username" style={{ color: usernameColor(msg.username) }}>
                  {msg.username}
                </span>
                <span className="thread-message-time">{formatTime(msg.createdAt)}</span>
              </div>
              {msg.deleted ? (
                <div className="thread-message-deleted">
                  {t('messages.deleted', '[message deleted]')}
                </div>
              ) : (
                <div className="thread-message-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {msg.content}
                  </ReactMarkdown>
                  {msg.editedAt && (
                    <span className="message-edited">{t('messages.edited', '(edited)')}</span>
                  )}
                  {msg.authorId === currentUserId && (
                    <div className="thread-message-actions">
                      <button
                        className="thread-message-action-btn"
                        onClick={() => setEditingMessage({ id: msg.id, content: msg.content })}
                        title={t('messages.edit', 'Edit Message')}
                      >
                        <EditPencil width={16} height={16} strokeWidth={2} />
                      </button>
                      <button
                        className="thread-message-action-btn danger"
                        onClick={() => handleDelete(msg.id)}
                        title={t('messages.delete', 'Delete Message')}
                      >
                        <Trash width={16} height={16} strokeWidth={2} />
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}

        <div ref={bottomRef} />
      </div>

      {/* Thread input */}
      <div className="thread-input-area">
        <MessageInput
          channelId={thread.id}
          channelName={threadTitle}
          currentUserId={currentUserId}
          editingMessage={editingMessage}
          onSend={handleSend}
          onEdit={handleEdit}
          onCancelEdit={() => setEditingMessage(null)}
          onTyping={() => {}}
          placeholder={t('thread.replyPlaceholder', 'Reply in thread...')}
        />
      </div>
    </div>
  );
}
