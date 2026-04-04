import { useEffect, useCallback, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { DMChannel } from '../../stores/dmStore';
import { useTeamStore } from '../../stores/teamStore';
import { useAuthStore } from '../../stores/authStore';
import { useMessageStore, type Message } from '../../stores/messageStore';
import { ws } from '../../services/websocket';
import { api } from '../../services/api';
import { cryptoService } from '../../services/crypto';
import { cacheMessage, getCachedMessage, deleteCachedMessage } from '../../services/messageCache';
import MessageList from '../MessageList/MessageList';
import MessageInput from '../MessageInput/MessageInput';

const DM_PAGE_SIZE = 50;

interface ServerMessage {
  id: string;
  channel_id: string;
  dm_id?: string;
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

function serverToMessage(msg: ServerMessage, dmId: string): Message {
  return {
    id: msg.id,
    channelId: dmId,
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

interface Props {
  dm: DMChannel;
  currentUserId: string;
  showMembers?: boolean;
}

export default function DMView({ dm, currentUserId, showMembers = false }: Readonly<Props>) {
  const { t } = useTranslation();
  const { activeTeamId } = useTeamStore();
  const { derivedKey } = useAuthStore();
  const { addMessage, prependMessages, updateMessage, deleteMessage, setTyping, setLoadingHistory, setHasMore, loadingHistory, hasMore } =
    useMessageStore();
  const [editingMessage, setEditingMessage] = useState<{ id: string; content: string } | null>(null);
  const initialLoadDone = useRef<Set<string>>(new Set());

  const displayName = dm.is_group
    ? dm.members.map((m) => m.display_name || m.username).join(', ')
    : (dm.members.find((m) => m.user_id !== currentUserId)?.display_name ||
       dm.members.find((m) => m.user_id !== currentUserId)?.username ||
       'Unknown');

  // Identify peer for encryption (the other user in 1:1 DMs)
  const peerId = dm.members.find((m) => m.user_id !== currentUserId)?.user_id || '';

  const tryEncryptDM = useCallback(
    async (plaintext: string): Promise<string> => {
      if (!derivedKey || !activeTeamId || !peerId) throw new Error('Encryption prerequisites not met');
      return await cryptoService.encryptDM(activeTeamId, peerId, plaintext, dm.id, derivedKey);
    },
    [derivedKey, activeTeamId, peerId, dm.id],
  );

  const tryDecryptDM = useCallback(
    async (messageId: string, content: string, senderId: string): Promise<string> => {
      // Check local cache first
      const cached = await getCachedMessage(messageId);
      if (cached !== null) return cached;

      if (!derivedKey || !activeTeamId)
        return '\u{1F512} *Encrypted message \u2014 unlock your identity to read*';
      try {
        const plaintext = await cryptoService.decryptDM(activeTeamId, senderId, content, dm.id, derivedKey);
        await cacheMessage(messageId, dm.id, plaintext);
        return plaintext;
      } catch {
        return content;
      }
    },
    [derivedKey, activeTeamId, dm.id],
  );

  // Load initial DM message history
  useEffect(() => {
    if (!activeTeamId || initialLoadDone.current.has(dm.id)) return;

    const loadHistory = async () => {
      setLoadingHistory(dm.id, true);
      try {
        let msgs: ServerMessage[];
        if (ws.isConnected(activeTeamId)) {
          msgs = await ws.request<ServerMessage[]>(activeTeamId, 'dms:messages', {
            dm_id: dm.id, limit: DM_PAGE_SIZE,
          });
        } else {
          msgs = await api.getDMMessages(activeTeamId, dm.id, undefined, DM_PAGE_SIZE) as ServerMessage[];
        }
        const converted = await Promise.all(
          msgs.map(async (msg) => {
            const content = await tryDecryptDM(msg.id, msg.content, msg.author_id);
            return { ...serverToMessage(msg, dm.id), content, encryptedContent: msg.content };
          }),
        );
        prependMessages(dm.id, converted);
        setHasMore(dm.id, converted.length >= DM_PAGE_SIZE);
        initialLoadDone.current.add(dm.id);
      } catch {
        // API might not be available
      } finally {
        setLoadingHistory(dm.id, false);
      }
    };

    loadHistory();
  }, [activeTeamId, dm.id, tryDecryptDM, prependMessages, setLoadingHistory, setHasMore]);

  // Subscribe to DM WebSocket events
  useEffect(() => {
    const unsubNew = ws.on('dm:message:new', async (payload: ServerMessage & { dm_id: string }) => {
      if (payload.dm_id !== dm.id) return;
      const content = await tryDecryptDM(payload.id, payload.content, payload.author_id);
      addMessage(dm.id, { ...serverToMessage(payload, dm.id), content, encryptedContent: payload.content });
    });

    const unsubEdit = ws.on('dm:message:updated', async (payload: { dm_id: string; message_id: string; content: string; author_id: string; username: string }) => {
      if (payload.dm_id !== dm.id) return;
      await deleteCachedMessage(payload.message_id);
      const content = await tryDecryptDM(payload.message_id, payload.content, payload.author_id);
      updateMessage(dm.id, payload.message_id, content);
    });

    const unsubDelete = ws.on('dm:message:deleted', (payload: { dm_id: string; message_id: string }) => {
      if (payload.dm_id !== dm.id) return;
      deleteMessage(dm.id, payload.message_id);
    });

    const unsubTyping = ws.on('dm:typing:indicator', (payload: { dm_id: string; user_id: string; username: string }) => {
      if (payload.dm_id !== dm.id) return;
      setTyping(dm.id, {
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
  }, [dm.id, tryDecryptDM, addMessage, updateMessage, deleteMessage, setTyping]);

  const handleLoadMore = useCallback(async () => {
    if (!activeTeamId) return;
    const isLoading = loadingHistory.get(dm.id) ?? false;
    const canLoadMore = hasMore.get(dm.id) ?? true;
    if (isLoading || !canLoadMore) return;

    const messages = useMessageStore.getState().messages.get(dm.id) ?? [];
    const oldestId = messages.length > 0 ? messages[0].id : undefined;

    setLoadingHistory(dm.id, true);
    try {
      let msgs: ServerMessage[];
      if (ws.isConnected(activeTeamId)) {
        msgs = await ws.request<ServerMessage[]>(activeTeamId, 'dms:messages', {
          dm_id: dm.id, before: oldestId, limit: DM_PAGE_SIZE,
        });
      } else {
        msgs = await api.getDMMessages(activeTeamId, dm.id, oldestId, DM_PAGE_SIZE) as ServerMessage[];
      }
      const converted = await Promise.all(
        msgs.map(async (msg) => {
          const content = await tryDecryptDM(msg.id, msg.content, msg.author_id);
          return { ...serverToMessage(msg, dm.id), content, encryptedContent: msg.content };
        }),
      );
      prependMessages(dm.id, converted);
      setHasMore(dm.id, converted.length >= DM_PAGE_SIZE);
    } catch {
      // ignore
    } finally {
      setLoadingHistory(dm.id, false);
    }
  }, [activeTeamId, dm.id, tryDecryptDM, loadingHistory, hasMore, prependMessages, setLoadingHistory, setHasMore]);

  const handleSend = useCallback(
    async (content: string) => {
      if (!activeTeamId) return;
      try {
        const encrypted = await tryEncryptDM(content);
        ws.sendDMMessage(activeTeamId, dm.id, encrypted);
      } catch (err) {
        console.warn('[DMView] encryption failed, message not sent', err);
      }
    },
    [activeTeamId, dm.id, tryEncryptDM],
  );

  const handleEdit = useCallback(
    async (messageId: string, content: string) => {
      if (!activeTeamId) return;
      try {
        const encrypted = await tryEncryptDM(content);
        ws.editDMMessage(activeTeamId, dm.id, messageId, encrypted);
        setEditingMessage(null);
      } catch (err) {
        console.warn('[DMView] encryption failed, edit not sent', err);
      }
    },
    [activeTeamId, dm.id, tryEncryptDM],
  );

  const handleDelete = useCallback(
    (message: Message) => {
      if (!activeTeamId) return;
      ws.deleteDMMessage(activeTeamId, dm.id, message.id);
    },
    [activeTeamId, dm.id],
  );

  const handleTyping = useCallback(() => {
    if (!activeTeamId) return;
    ws.startDMTyping(activeTeamId, dm.id);
  }, [activeTeamId, dm.id]);

  return (
      <div className="flex flex-1 min-h-0">
        <div className="flex flex-1 flex-col min-w-0">
          <MessageList
            channelId={dm.id}
            currentUserId={currentUserId}
            onLoadMore={handleLoadMore}
            onEdit={(msg) => setEditingMessage({ id: msg.id, content: msg.content })}
            onDelete={handleDelete}
          />

          <MessageInput
            channelId={dm.id}
            channelName={displayName}
            currentUserId={currentUserId}
            editingMessage={editingMessage}
            onSend={handleSend}
            onEdit={handleEdit}
            onCancelEdit={() => setEditingMessage(null)}
            onTyping={handleTyping}
          />
        </div>

        {showMembers && dm.is_group && (
          <div className="w-[240px] bg-surface-secondary border-l border-surface-tertiary overflow-y-auto shrink-0">
            <div className="py-3 px-lg text-foreground-secondary text-micro">
              {t('dm.members', '{{count}} members', { count: dm.members.length })}
            </div>
            {dm.members.map((member) => (
              <div key={member.user_id} className="flex flex-col py-1.5 px-lg gap-px hover:bg-surface-hover">
                <span className="text-base font-medium text-foreground-primary">
                  {member.display_name || member.username}
                </span>
                <span className="text-xs text-foreground-muted">@{member.username}</span>
              </div>
            ))}
          </div>
        )}
      </div>
  );
}
