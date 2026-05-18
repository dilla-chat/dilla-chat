// Global subscription for thread-level WS events. ChannelView and
// ThreadPanel split these handlers between them (ChannelView scoped to
// channel.id, ThreadPanel scoped to thread.id), so the shell — which has
// no per-channel mount and opens threads via a panel — never wired the
// flow. This hook is the single global handler set, dispatched into
// useThreadStore by looking up the thread's parent channel from the
// payload (thread:created carries channel_id; thread:message:* events
// reference the thread by id, which we resolve via the store).

import { useEffect } from 'react';
import { ws } from '../services/websocket';
import { useAuthStore } from '../stores/authStore';
import { useTeamStore } from '../stores/teamStore';
import { useThreadStore, type Thread } from '../stores/threadStore';
import { tryDecrypt, serverToMessage, type ServerMessage } from './useMessageDecryption';
import { deleteCachedMessage } from '../services/messageCache';

function findThread(threadId: string): Thread | undefined {
  const byChannel = useThreadStore.getState().threads;
  for (const channelId in byChannel) {
    const t = byChannel[channelId]?.find((th) => th.id === threadId);
    if (t) return t;
  }
  return undefined;
}

export function useThreadEvents(activeTeamId: string | null): void {
  useEffect(() => {
    if (!activeTeamId) return;

    const unsubCreated = ws.on('thread:created', (payload: Thread) => {
      useThreadStore.getState().addThread(payload.channel_id, payload);
    });

    const unsubUpdated = ws.on('thread:updated', (payload: Thread) => {
      useThreadStore.getState().updateThread(payload);
    });

    const unsubMsgNew = ws.on('thread:message:new', async (payload: ServerMessage) => {
      if (!payload.thread_id) return;
      const thread = findThread(payload.thread_id);
      // Channel id needed for channel-keyed sender key. Fallback to the
      // payload's channel_id if the thread isn't in store yet (a brand
      // new thread whose :created event hasn't been processed).
      const channelId = thread?.channel_id ?? payload.channel_id;
      const derivedKey = useAuthStore.getState().derivedKey;
      const members = useTeamStore.getState().members.get(activeTeamId) ?? [];
      const content = await tryDecrypt(
        payload.id,
        payload.content,
        payload.author_id,
        channelId,
        derivedKey,
      );
      useThreadStore.getState().addThreadMessage(
        payload.thread_id,
        serverToMessage(payload, content, members),
      );
      // Bump the parent thread's reply count + last_message_at so the
      // shell's thread previews stay current.
      if (thread) {
        useThreadStore.getState().updateThread({
          ...thread,
          message_count: thread.message_count + 1,
          last_message_at: payload.created_at,
        });
      }
    });

    const unsubMsgEdit = ws.on('thread:message:updated', async (payload: ServerMessage) => {
      if (!payload.thread_id) return;
      const thread = findThread(payload.thread_id);
      const channelId = thread?.channel_id ?? payload.channel_id;
      const derivedKey = useAuthStore.getState().derivedKey;
      const members = useTeamStore.getState().members.get(activeTeamId) ?? [];
      await deleteCachedMessage(payload.id);
      const content = await tryDecrypt(
        payload.id,
        payload.content,
        payload.author_id,
        channelId,
        derivedKey,
      );
      useThreadStore.getState().updateThreadMessage(
        payload.thread_id,
        serverToMessage(payload, content, members),
      );
    });

    const unsubMsgDel = ws.on(
      'thread:message:deleted',
      (payload: { message_id: string; thread_id: string }) => {
        useThreadStore.getState().removeThreadMessage(payload.thread_id, payload.message_id);
      },
    );

    return () => {
      unsubCreated();
      unsubUpdated();
      unsubMsgNew();
      unsubMsgEdit();
      unsubMsgDel();
    };
  }, [activeTeamId]);
}
