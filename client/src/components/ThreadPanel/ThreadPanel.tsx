import { useRef, useEffect, useCallback, useState, useMemo, type UIEvent } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Xmark, EditPencil, Trash } from 'iconoir-react';
import { useThreadStore, type Thread } from '../../stores/threadStore';
import { useMessageStore, type Message } from '../../stores/messageStore';
import { useAuthStore } from '../../stores/authStore';
import { useTeamStore } from '../../stores/teamStore';
import { api } from '../../services/api';
import { usernameColor, getInitials } from '../../utils/colors';
import { formatTime } from '../../utils/messageGrouping';
import { ws } from '../../services/websocket';
import { cryptoService } from '../../services/crypto';
import { cacheMessage, getCachedMessage, deleteCachedMessage } from '../../services/messageCache';
import MessageInput from '../MessageInput/MessageInput';


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

export default function ThreadPanel({ thread, onClose }: Readonly<Props>) {
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
  const currentUser = teamEntry?.user ?? null;
  const currentUserId = currentUser?.id ?? '';

  const msgs = useMemo(() => threadMessages[thread.id] ?? [], [threadMessages, thread.id]);

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
            const cached = await getCachedMessage(msg.id);
            if (cached !== null) return { ...serverToMessage(msg), content: cached };
            let content: string;
            if (derivedKey) {
              try {
                content = await cryptoService.decryptMessage(
                  msg.author_id, msg.content, false, thread.channel_id, derivedKey,
                );
                await cacheMessage(msg.id, thread.channel_id, content);
              } catch {
                content = msg.content;
              }
            } else {
              content = msg.content;
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
  }, [activeTeamId, thread.id, setThreadMessages, derivedKey, thread.channel_id]);

  // Subscribe to thread WebSocket events
  useEffect(() => {
    const unsubNew = ws.on('thread:message:new', async (payload: ServerMessage) => {
      if (payload.thread_id !== thread.id) return;
      const cached = await getCachedMessage(payload.id);
      let content: string;
      if (cached !== null) {
        content = cached;
      } else if (derivedKey) {
        try {
          content = await cryptoService.decryptMessage(
            payload.author_id, payload.content, false, thread.channel_id, derivedKey,
          );
          await cacheMessage(payload.id, thread.channel_id, content);
        } catch {
          content = payload.content;
        }
      } else {
        content = payload.content;
      }
      addThreadMessage(thread.id, { ...serverToMessage(payload), content });
    });

    const unsubEdit = ws.on('thread:message:updated', async (payload: ServerMessage) => {
      if (payload.thread_id !== thread.id) return;
      await deleteCachedMessage(payload.id);
      let content: string;
      if (derivedKey) {
        try {
          content = await cryptoService.decryptMessage(
            payload.author_id, payload.content, false, thread.channel_id, derivedKey,
          );
          await cacheMessage(payload.id, thread.channel_id, content);
        } catch {
          content = payload.content;
        }
      } else {
        content = payload.content;
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
  }, [thread.id, addThreadMessage, updateThreadMessage, removeThreadMessage, derivedKey, thread.channel_id]);

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

  const handleScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
      shouldAutoScroll.current = atBottom;

      if (el.scrollTop < 100 && hasMore && !loading) {
        handleLoadMore();
      }
    },
    [hasMore, loading, handleLoadMore],
  );

  const handleSend = useCallback(
    async (content: string) => {
      if (!activeTeamId) return;
      let encrypted: string;
      if (derivedKey) {
        try {
          encrypted = await cryptoService.encryptMessage(
            thread.channel_id, content, false, thread.channel_id, derivedKey,
          );
        } catch {
          encrypted = content;
        }
      } else {
        encrypted = content;
      }
      ws.sendThreadMessage(activeTeamId, thread.id, encrypted);
    },
    [activeTeamId, thread.id, thread.channel_id, derivedKey],
  );

  const handleEdit = useCallback(
    async (messageId: string, content: string) => {
      if (!activeTeamId) return;
      let encrypted: string;
      if (derivedKey) {
        try {
          encrypted = await cryptoService.encryptMessage(
            thread.channel_id, content, false, thread.channel_id, derivedKey,
          );
        } catch {
          encrypted = content;
        }
      } else {
        encrypted = content;
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
    <div className="w-[400px] min-w-[400px] bg-glass-secondary backdrop-blur-glass border-l border-glass-border flex flex-col h-full max-md:fixed max-md:inset-0 max-md:w-auto max-md:min-w-0 max-md:z-[150] max-md:border-l-0 md:max-lg:w-[320px] md:max-lg:min-w-[320px]">
      <div className="flex items-center justify-between px-lg py-md border-b border-divider shadow-[0_1px_2px_var(--overlay-light)] shrink-0">
        <div className="flex flex-col min-w-0 flex-1">
          <div className="title truncate text-foreground-primary">{threadTitle}</div>
          <div className="text-xs text-foreground-muted mt-0.5">
            {(() => {
              if (thread.message_count === 0) return t('thread.noReplies', 'No replies yet. Start the conversation!');
              if (thread.message_count === 1) return t('thread.reply', '1 reply');
              return t('thread.replies', '{{count}} replies', { count: thread.message_count });
            })()}
          </div>
        </div>
        <button
          className="bg-transparent border-none text-interactive cursor-pointer px-sm py-xs rounded-sm text-[18px] leading-none shrink-0 ml-sm hover:text-interactive-hover hover:bg-surface-hover"
          onClick={onClose}
          title={t('thread.closeThread', 'Close')}
        >
          <Xmark width={20} height={20} strokeWidth={2} />
        </button>
      </div>

      {/* Parent message */}
      {parentMessage && (
        <div className="px-lg py-md bg-input border-b border-divider shrink-0">
          <div className="flex items-center gap-sm mb-1.5">
            <div
              className="w-6 h-6 rounded-full flex items-center justify-center text-micro font-semibold text-interactive-active shrink-0"
              style={{ backgroundColor: usernameColor(parentMessage.username) }}
            >
              {getInitials(parentMessage.username)}
            </div>
            <span className="text-base font-semibold" style={{ color: usernameColor(parentMessage.username) }}>
              {parentMessage.username}
            </span>
            <span className="text-micro text-foreground-muted">{formatTime(parentMessage.createdAt)}</span>
          </div>
          <div className="text-base text-foreground-secondary leading-[1.4] overflow-hidden line-clamp-3 [&_p]:m-0">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents} skipHtml>
              {parentMessage.content}
            </ReactMarkdown>
          </div>
        </div>
      )}

      {/* Thread messages */}
      <div
        className="flex-1 overflow-y-auto py-sm flex flex-col scrollbar-thin"
        style={{ scrollbarColor: 'var(--scrollbar-thin-thumb) var(--scrollbar-thin-track)' }}
        ref={containerRef}
        onScroll={handleScroll}
        data-testid="thread-messages"
      >
        {loading && (
          <div className="text-center p-md text-foreground-muted text-sm">{t('app.loading', 'Loading...')}</div>
        )}

        {!loading && msgs.length === 0 && (
          <div className="text-center px-lg py-2xl text-foreground-muted text-base">
            {t('thread.noReplies', 'No replies yet. Start the conversation!')}
          </div>
        )}

        {msgs.length > 0 && (
          <div className="flex items-center gap-sm px-lg py-sm text-xs font-semibold text-foreground-muted after:content-[''] after:flex-1 after:h-px after:bg-border-subtle">
            {msgs.length === 1
              ? t('thread.reply', '1 reply')
              : t('thread.replies', '{{count}} replies', { count: msgs.length })}
          </div>
        )}

        {msgs.map((msg) => (
          <div key={msg.id} className="flex px-lg py-xs mt-sm hover:bg-surface-hover">
            <div className="shrink-0 w-8 mr-md pt-0.5">
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold text-interactive-active select-none"
                style={{ backgroundColor: usernameColor(msg.username) }}
              >
                {getInitials(msg.username)}
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-1.5 mb-0.5">
                <span className="text-base font-semibold cursor-pointer hover:underline" style={{ color: usernameColor(msg.username) }}>
                  {msg.username}
                </span>
                <span className="text-micro text-foreground-muted">{formatTime(msg.createdAt)}</span>
              </div>
              {msg.deleted ? (
                <div className="text-base text-foreground-muted opacity-50">
                  {t('messages.deleted', '[message deleted]')}
                </div>
              ) : (
                <div className="relative text-base text-foreground-primary break-words overflow-wrap-anywhere leading-[1.375] [&_p]:m-0 [&_.message-edited]:text-micro group">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents} skipHtml>
                    {msg.content}
                  </ReactMarkdown>
                  {msg.editedAt && (
                    <span className="message-edited">{t('messages.edited', '(edited)')}</span>
                  )}
                  {msg.authorId === currentUserId && (
                    <div className="hidden group-hover:flex absolute -top-2.5 right-0 bg-glass-floating backdrop-blur-glass-light border border-glass-border rounded-sm p-0.5 gap-0.5 z-[1]">
                      <button
                        className="bg-transparent border-none text-interactive cursor-pointer px-[5px] py-[3px] rounded-sm text-xs leading-none hover:bg-surface-hover hover:text-interactive-hover"
                        onClick={() => setEditingMessage({ id: msg.id, content: msg.content })}
                        title={t('messages.edit', 'Edit Message')}
                      >
                        <EditPencil width={16} height={16} strokeWidth={2} />
                      </button>
                      <button
                        className="bg-transparent border-none text-interactive cursor-pointer px-[5px] py-[3px] rounded-sm text-xs leading-none hover:bg-surface-hover hover:text-foreground-danger"
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
      <div className="px-md pb-lg shrink-0">
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
