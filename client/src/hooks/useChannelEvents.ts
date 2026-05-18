// Global subscription for channel-level WS events. The legacy ChannelView
// scoped its handlers to a single channel.id, so the shell (which displays
// many channels at once and switches via cmd-N without remounting) never
// saw events for channels the user wasn't actively viewing. This hook
// mirrors that subscription set but dispatches into useMessageStore using
// the payload's channel_id, so every channel in the active team stays
// current.
//
// Mounted by the authenticated App page / MockShell. Idempotent against
// teamId changes — cleanup tears down the previous subscription before the
// next one is registered.

import { useEffect } from 'react';
import { ws } from '../services/websocket';
import { useAuthStore } from '../stores/authStore';
import { useTeamStore } from '../stores/teamStore';
import { useMessageStore } from '../stores/messageStore';
import { tryDecrypt, serverToMessage, type ServerMessage } from './useMessageDecryption';
import { deleteCachedMessage } from '../services/messageCache';
import { cryptoService } from '../services/crypto';

export function useChannelEvents(activeTeamId: string | null): void {
  useEffect(() => {
    if (!activeTeamId) return;

    const unsubNew = ws.on('message:new', async (payload: ServerMessage) => {
      const derivedKey = useAuthStore.getState().derivedKey;
      const members = useTeamStore.getState().members.get(activeTeamId) ?? [];
      const content = await tryDecrypt(
        payload.id,
        payload.content,
        payload.author_id,
        payload.channel_id,
        derivedKey,
      );
      useMessageStore.getState().addMessage(
        payload.channel_id,
        serverToMessage(payload, content, members),
      );
    });

    const unsubEdit = ws.on(
      'message:updated',
      async (payload: { message_id: string; channel_id: string; content: string; author_id: string }) => {
        const derivedKey = useAuthStore.getState().derivedKey;
        await deleteCachedMessage(payload.message_id);
        const content = await tryDecrypt(
          payload.message_id,
          payload.content,
          payload.author_id,
          payload.channel_id,
          derivedKey,
        );
        useMessageStore.getState().updateMessage(payload.channel_id, payload.message_id, content);
      },
    );

    const unsubDelete = ws.on('message:deleted', (payload: { message_id: string; channel_id: string }) => {
      useMessageStore.getState().deleteMessage(payload.channel_id, payload.message_id);
    });

    const unsubTyping = ws.on(
      'typing:indicator',
      (payload: { channel_id: string; user_id: string; username: string }) => {
        useMessageStore.getState().setTyping(payload.channel_id, {
          userId: payload.user_id,
          username: payload.username,
          timestamp: Date.now(),
        });
      },
    );

    const unsubKeyDist = ws.on(
      'channel:key-distribute',
      async (payload: { channel_id: string; sender_id: string; distribution: string }) => {
        const derivedKey = useAuthStore.getState().derivedKey;
        if (!derivedKey) return;
        try {
          await cryptoService.processSenderKey(payload.channel_id, payload.distribution, derivedKey);
        } catch (err) {
          console.warn('[useChannelEvents] sender-key processing failed', err);
        }
      },
    );

    const unsubReactAdd = ws.on(
      'reaction:added',
      (payload: { message_id: string; channel_id: string; user_id: string; emoji: string }) => {
        const list = useMessageStore.getState().messages.get(payload.channel_id) ?? [];
        const msg = list.find((m) => m.id === payload.message_id);
        if (!msg) return;
        const reactions = msg.reactions ? msg.reactions.map((r) => ({ ...r })) : [];
        const existing = reactions.find((r) => r.emoji === payload.emoji);
        if (existing) {
          if (!existing.users.includes(payload.user_id)) {
            existing.users = [...existing.users, payload.user_id];
            existing.count = existing.users.length;
          }
        } else {
          reactions.push({ emoji: payload.emoji, users: [payload.user_id], count: 1 });
        }
        useMessageStore.getState().updateReactions(payload.channel_id, payload.message_id, reactions);
      },
    );

    const unsubReactRem = ws.on(
      'reaction:removed',
      (payload: { message_id: string; channel_id: string; user_id: string; emoji: string }) => {
        const list = useMessageStore.getState().messages.get(payload.channel_id) ?? [];
        const msg = list.find((m) => m.id === payload.message_id);
        if (!msg?.reactions) return;
        const reactions = msg.reactions
          .map((r) =>
            r.emoji === payload.emoji
              ? { ...r, users: r.users.filter((u) => u !== payload.user_id), count: Math.max(0, r.count - 1) }
              : r,
          )
          .filter((r) => r.count > 0);
        useMessageStore.getState().updateReactions(payload.channel_id, payload.message_id, reactions);
      },
    );

    return () => {
      unsubNew();
      unsubEdit();
      unsubDelete();
      unsubTyping();
      unsubKeyDist();
      unsubReactAdd();
      unsubReactRem();
    };
  }, [activeTeamId]);
}
