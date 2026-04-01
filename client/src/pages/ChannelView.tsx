import { useEffect, useCallback, useState, useRef, useMemo } from 'react';
import { useTeamStore, type Channel } from '../stores/teamStore';
import { useAuthStore } from '../stores/authStore';
import { useMessageStore, type Message } from '../stores/messageStore';
import { useThreadStore, type Thread } from '../stores/threadStore';
import { ws } from '../services/websocket';
import { api } from '../services/api';
import { deleteCachedMessage } from '../services/messageCache';
import { tryDecrypt, tryEncrypt, serverToMessage, type ServerMessage } from '../hooks/useMessageDecryption';
import { useToast } from '../components/Toast/useToast';
import MessageList from '../components/MessageList/MessageList';
import MessageInput from '../components/MessageInput/MessageInput';

const MESSAGE_PAGE_SIZE = 50;

interface Props {
  channel: Channel;
}

export default function ChannelView({ channel }: Readonly<Props>) {
  const { activeTeamId, members } = useTeamStore();
  const teamMembers = activeTeamId ? members.get(activeTeamId) ?? [] : [];
  const { teams, derivedKey } = useAuthStore();
  const { addMessage, prependMessages, updateMessage, deleteMessage, setTyping, setLoadingHistory, setHasMore, loadingHistory, hasMore } =
    useMessageStore();
  const {
    threads,
    setThreads, addThread, updateThread: storeUpdateThread,
    setActiveThread, setThreadPanelOpen,
    addThreadMessage, updateThreadMessage, removeThreadMessage,
  } = useThreadStore();
  const { toast } = useToast();
  const [editingMessage, setEditingMessage] = useState<{ id: string; content: string } | null>(null);
  const initialLoadDone = useRef<Set<string>>(new Set());
  const threadsLoadDone = useRef<Set<string>>(new Set());

  const teamEntry = activeTeamId ? teams.get(activeTeamId) : null;
  const currentUser = teamEntry?.user ?? null;
  const currentUserId = currentUser?.id ?? '';

  // Subscribe to channel broadcasts so the server delivers real-time events
  useEffect(() => {
    if (!activeTeamId) return;
    ws.joinChannel(activeTeamId, channel.id);
    return () => {
      ws.leaveChannel(activeTeamId, channel.id);
    };
  }, [activeTeamId, channel.id]);

  // Load initial message history via WS (with REST fallback)
  useEffect(() => {
    if (!activeTeamId || initialLoadDone.current.has(channel.id)) return;

    const loadHistory = async () => {
      setLoadingHistory(channel.id, true);
      try {
        let msgs: ServerMessage[];
        if (ws.isConnected(activeTeamId)) {
          msgs = await ws.request<ServerMessage[]>(activeTeamId, 'messages:list', {
            channel_id: channel.id,
            limit: MESSAGE_PAGE_SIZE,
          });
        } else {
          msgs = (await api.getMessages(activeTeamId, channel.id, MESSAGE_PAGE_SIZE)) as ServerMessage[];
        }
        const decrypted = await Promise.all(
          msgs.map(async (msg) => {
            const content = await tryDecrypt(msg.id, msg.content, msg.author_id, channel.id, derivedKey);
            return serverToMessage(msg, content, teamMembers);
          }),
        );
        prependMessages(channel.id, decrypted);
        setHasMore(channel.id, decrypted.length >= MESSAGE_PAGE_SIZE);
        initialLoadDone.current.add(channel.id);
      } catch {
        // API might not be available in dev
      } finally {
        setLoadingHistory(channel.id, false);
      }
    };

    loadHistory();
  }, [activeTeamId, channel.id, derivedKey, prependMessages, setLoadingHistory, setHasMore]);

  // Subscribe to WebSocket events
  useEffect(() => {
    const unsubNew = ws.on('message:new', async (payload: ServerMessage) => {
      if (payload.channel_id !== channel.id) return;
      const content = await tryDecrypt(payload.id, payload.content, payload.author_id, channel.id, derivedKey);
      addMessage(channel.id, serverToMessage(payload, content, teamMembers));
    });

    const unsubEdit = ws.on('message:updated', async (payload: { message_id: string; channel_id: string; content: string; author_id: string }) => {
      if (payload.channel_id !== channel.id) return;
      // Invalidate cache so new ciphertext is decrypted fresh
      await deleteCachedMessage(payload.message_id);
      const content = await tryDecrypt(payload.message_id, payload.content, payload.author_id, channel.id, derivedKey);
      updateMessage(channel.id, payload.message_id, content);
    });

    const unsubDelete = ws.on('message:deleted', (payload: { message_id: string; channel_id: string }) => {
      if (payload.channel_id !== channel.id) return;
      deleteMessage(channel.id, payload.message_id);
    });

    const unsubTyping = ws.on('typing:indicator', (payload: { channel_id: string; user_id: string; username: string }) => {
      if (payload.channel_id !== channel.id) return;
      setTyping(channel.id, {
        userId: payload.user_id,
        username: payload.username,
        timestamp: Date.now(),
      });
    });

    return () => {
      unsubNew();
      unsubEdit();
      unsubDelete();
      unsubTyping();
    };
  }, [channel.id, derivedKey, addMessage, updateMessage, deleteMessage, setTyping]);

  // Load threads for the channel via WS (with REST fallback)
  useEffect(() => {
    if (!activeTeamId || threadsLoadDone.current.has(channel.id)) return;

    const loadThreads = async () => {
      try {
        let raw: Thread[];
        if (ws.isConnected(activeTeamId)) {
          raw = await ws.request<Thread[]>(activeTeamId, 'threads:list', {
            channel_id: channel.id,
          });
        } else {
          raw = (await api.getChannelThreads(activeTeamId, channel.id)) as Thread[];
        }
        setThreads(channel.id, raw);
        threadsLoadDone.current.add(channel.id);
      } catch {
        // Thread loading is non-critical; silently degrade.
      }
    };
    loadThreads();
  }, [activeTeamId, channel.id, setThreads]);

  // Subscribe to thread WebSocket events
  useEffect(() => {
    const unsubThreadCreated = ws.on('thread:created', (payload: Thread) => {
      if (payload.channel_id !== channel.id) return;
      addThread(channel.id, payload);
    });

    const unsubThreadUpdated = ws.on('thread:updated', (payload: Thread) => {
      if (payload.channel_id !== channel.id) return;
      storeUpdateThread(payload);
    });

    const unsubThreadMsgNew = ws.on('thread:message:new', async (payload: ServerMessage) => {
      if (!payload.thread_id) return;
      const content = await tryDecrypt(payload.id, payload.content, payload.author_id, channel.id, derivedKey);
      addThreadMessage(payload.thread_id, serverToMessage(payload, content, teamMembers));
      // Update thread message count in local state
      const channelThreads = threads[channel.id] ?? [];
      const thread = channelThreads.find((th) => th.id === payload.thread_id);
      if (thread) {
        storeUpdateThread({
          ...thread,
          message_count: thread.message_count + 1,
          last_message_at: payload.created_at,
        });
      }
    });

    const unsubThreadMsgEdit = ws.on('thread:message:updated', async (payload: ServerMessage) => {
      if (!payload.thread_id) return;
      await deleteCachedMessage(payload.id);
      const content = await tryDecrypt(payload.id, payload.content, payload.author_id, channel.id, derivedKey);
      updateThreadMessage(payload.thread_id, serverToMessage(payload, content, teamMembers));
    });

    const unsubThreadMsgDel = ws.on('thread:message:deleted', (payload: { message_id: string; thread_id: string }) => {
      if (!payload.thread_id) return;
      removeThreadMessage(payload.thread_id, payload.message_id);
    });

    return () => {
      unsubThreadCreated();
      unsubThreadUpdated();
      unsubThreadMsgNew();
      unsubThreadMsgEdit();
      unsubThreadMsgDel();
    };
  }, [channel.id, threads, addThread, storeUpdateThread, addThreadMessage, updateThreadMessage, removeThreadMessage]);

  // Build threadInfo map: parentMessageId -> { count, lastReplyAt }
  const rawThreads = threads[channel.id];
  const channelThreads = Array.isArray(rawThreads) ? rawThreads : [];
  const threadInfo = useMemo(() => {
    const info: Record<string, { count: number; lastReplyAt: string | null }> = {};
    for (const th of channelThreads) {
      info[th.parent_message_id] = {
        count: th.message_count,
        lastReplyAt: th.last_message_at,
      };
    }
    return info;
  }, [channelThreads]);

  const handleLoadMore = useCallback(async () => {
    if (!activeTeamId) return;
    const isLoading = loadingHistory.get(channel.id) ?? false;
    const canLoadMore = hasMore.get(channel.id) ?? true;
    if (isLoading || !canLoadMore) return;

    const messages = useMessageStore.getState().messages.get(channel.id) ?? [];
    const oldestId = messages.length > 0 ? messages[0].id : undefined;

    setLoadingHistory(channel.id, true);
    try {
      let msgs: ServerMessage[];
      if (ws.isConnected(activeTeamId)) {
        msgs = await ws.request<ServerMessage[]>(activeTeamId, 'messages:list', {
          channel_id: channel.id,
          limit: MESSAGE_PAGE_SIZE,
          before: oldestId,
        });
      } else {
        msgs = (await api.getMessages(activeTeamId, channel.id, MESSAGE_PAGE_SIZE, oldestId)) as ServerMessage[];
      }
      const decrypted = await Promise.all(
        msgs.map(async (msg) => {
          const content = await tryDecrypt(msg.id, msg.content, msg.author_id, channel.id, derivedKey);
          return serverToMessage(msg, content, teamMembers);
        }),
      );
      prependMessages(channel.id, decrypted);
      setHasMore(channel.id, decrypted.length >= MESSAGE_PAGE_SIZE);
    } catch {
      // History fetch failed; UI already shows current messages.
    } finally {
      setLoadingHistory(channel.id, false);
    }
  }, [activeTeamId, channel.id, derivedKey, loadingHistory, hasMore, prependMessages, setLoadingHistory, setHasMore]);

  const handleSend = useCallback(
    async (content: string) => {
      if (!activeTeamId) { console.warn('[ChannelView] no activeTeamId, dropping message'); return; }
      console.log('[ChannelView] sending message', { activeTeamId, channelId: channel.id, wsConnected: ws.isConnected(activeTeamId) });
      try {
        const encrypted = await tryEncrypt(content, channel.id, derivedKey);
        ws.sendMessage(activeTeamId, channel.id, encrypted);
      } catch (err) {
        console.warn('[ChannelView] encryption failed, message not sent', err);
        toast('Encryption key not available — log out and back in to unlock your identity', 'error');
      }
    },
    [activeTeamId, channel.id, derivedKey],
  );

  const handleEdit = useCallback(
    async (messageId: string, content: string) => {
      if (!activeTeamId) return;
      try {
        const encrypted = await tryEncrypt(content, channel.id, derivedKey);
        ws.editMessage(activeTeamId, messageId, channel.id, encrypted);
        setEditingMessage(null);
      } catch (err) {
        console.warn('[ChannelView] encryption failed, edit not sent', err);
      }
    },
    [activeTeamId, channel.id, derivedKey],
  );

  const handleDelete = useCallback(
    (message: Message) => {
      if (!activeTeamId) return;
      ws.deleteMessage(activeTeamId, message.id, channel.id);
    },
    [activeTeamId, channel.id],
  );

  const handleTyping = useCallback(() => {
    if (!activeTeamId) return;
    ws.startTyping(activeTeamId, channel.id);
  }, [activeTeamId, channel.id]);

  const handleCreateThread = useCallback(
    async (message: Message) => {
      if (!activeTeamId) return;
      try {
        const thread = await api.createThread(activeTeamId, channel.id, message.id) as Thread;
        addThread(channel.id, thread);
        setActiveThread(thread.id);
        setThreadPanelOpen(true);
      } catch {
        // Thread creation is best-effort; user can retry.
      }
    },
    [activeTeamId, channel.id, addThread, setActiveThread, setThreadPanelOpen],
  );

  const handleOpenThread = useCallback(
    (messageId: string) => {
      const thread = channelThreads.find((th) => th.parent_message_id === messageId);
      if (thread) {
        setActiveThread(thread.id);
        setThreadPanelOpen(true);
      }
    },
    [channelThreads, setActiveThread, setThreadPanelOpen],
  );

  return (
    <div style={{ flex: 1, position: 'relative', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <MessageList
        channelId={channel.id}
        channelName={channel.name}
        currentUserId={currentUserId}
        onLoadMore={handleLoadMore}
        onReply={() => {
          // Thread/reply functionality — future phase
        }}
        onEdit={(msg) => setEditingMessage({ id: msg.id, content: msg.content })}
        onDelete={handleDelete}
        onCreateThread={handleCreateThread}
        onOpenThread={handleOpenThread}
        threadInfo={threadInfo}
      />

      <MessageInput
        channelId={channel.id}
        channelName={channel.name}
        currentUserId={currentUserId}
        editingMessage={editingMessage}
        onSend={handleSend}
        onEdit={handleEdit}
        onCancelEdit={() => setEditingMessage(null)}
        onTyping={handleTyping}
      />
    </div>
  );
}
