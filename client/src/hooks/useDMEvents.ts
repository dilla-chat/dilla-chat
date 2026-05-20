// Global subscription for DM-level WS events. The legacy DMView scoped its
// handlers to a single dm.id and pushed into useMessageStore, but the shell
// reads DMs from useDMStore (per useShellData). This hook subscribes
// globally and dispatches into useDMStore using the payload's dm_id so DM
// conversations stay live regardless of which one the user is viewing.
//
// DM decryption uses cryptoService.decryptDM (a separate Signal-protocol
// session keyed per-DM-peer, distinct from channel sender keys).

import { useEffect } from 'react';
import { ws } from '../services/websocket';
import { api } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { useDMStore, type DMChannel } from '../stores/dmStore';
import { useUnreadStore } from '../stores/unreadStore';
import { cryptoService } from '../services/crypto';
import { deleteCachedMessage, getCachedMessage, cacheMessage } from '../services/messageCache';
import { serverToMessage, type ServerMessage } from './useMessageDecryption';
import type { Message } from '../stores/messageStore';

async function decryptDMContent(
  teamId: string | null,
  derivedKey: string | null,
  messageId: string,
  ciphertext: string,
  senderId: string,
  dmId: string,
): Promise<string> {
  const cached = await getCachedMessage(messageId);
  if (cached !== null) return cached;
  if (!derivedKey || !teamId) {
    return '\u{1F512} Encrypted message — unlock your identity to read';
  }
  try {
    const plaintext = await cryptoService.decryptDM(teamId, senderId, ciphertext, dmId, derivedKey);
    await cacheMessage(messageId, dmId, plaintext);
    return plaintext;
  } catch {
    return ciphertext;
  }
}

function withDmChannelId(msg: Message, dmId: string): Message {
  return { ...msg, channelId: dmId };
}

export function useDMEvents(activeTeamId: string | null, cryptoReady: boolean = true): void {
  useEffect(() => {
    if (!activeTeamId) return;
    // Same gate as useChannelEvents: wait for crypto to be initialized
    // before listening, so a DM message arriving during the restore
    // window doesn't try to decryptDM against a null manager.
    if (!cryptoReady) return;

    // dm:created — server emits this when a new DM channel is created. The
    // initiator gets it back from their own POST, but the *recipient* only
    // learns about a new conversation via this broadcast, so without it the
    // PMs sidebar stays empty on the other side until a full refresh.
    const unsubCreated = ws.on('dm:created', (payload: DMChannel) => {
      if (!payload?.id) return;
      useDMStore.getState().addDMChannel(activeTeamId, payload);
    });

    const unsubNew = ws.on(
      'dm:message:new',
      async (payload: ServerMessage & { dm_id?: string; dm_channel_id?: string }) => {
        // The server uses `dm_channel_id` on the Message struct and earlier
        // code referenced `dm_id`; accept either so we don't lose events to
        // a field-name mismatch.
        const dmId = payload.dm_id ?? payload.dm_channel_id ?? '';
        if (!dmId) return;

        const derivedKey = useAuthStore.getState().derivedKey;
        const content = await decryptDMContent(
          activeTeamId,
          derivedKey,
          payload.id,
          payload.content,
          payload.author_id,
          dmId,
        );
        const base = serverToMessage(payload, content);
        useDMStore.getState().addDMMessage(dmId, withDmChannelId(base, dmId));

        // Defensive: if dm:created arrived out-of-order or was dropped, the
        // recipient may not yet have this DM in their sidebar. Refetch the
        // full list so the conversation shows up without a manual reload.
        const known = useDMStore.getState().dmChannels[activeTeamId] ?? [];
        if (!known.some((c) => c.id === dmId)) {
          try {
            const fresh = (await api.getDMChannels(activeTeamId)) as DMChannel[];
            useDMStore.getState().setDMChannels(activeTeamId, fresh);
          } catch (err) {
            console.warn('[useDMEvents] getDMChannels fallback failed', err);
          }
        }

        // Unread pill: for messages that aren't our own echo, bump if the
        // DM isn't active. If the DM IS active, roll the read watermark
        // forward instead — otherwise the pill from a *previous* unread
        // message would linger even though the user is staring at the
        // new one, requiring a manual click to clear.
        const myId = useAuthStore.getState().teams.get(activeTeamId)?.user?.id;
        const activeDMId = useDMStore.getState().activeDMId;
        if (payload.author_id !== myId) {
          if (dmId !== activeDMId) {
            useUnreadStore.getState().increment(dmId);
          } else {
            useUnreadStore.getState().markRead(dmId);
            if (payload.id) {
              try { ws.markChannelRead(activeTeamId, dmId, payload.id); } catch { /* ignore */ }
            }
          }
        }
      },
    );

    const unsubEdit = ws.on(
      'dm:message:updated',
      async (payload: {
        dm_id?: string;
        dm_channel_id?: string;
        id?: string;
        message_id?: string;
        content: string;
        author_id: string;
        username: string;
      }) => {
        const dmId = payload.dm_id ?? payload.dm_channel_id ?? '';
        const messageId = payload.message_id ?? payload.id ?? '';
        if (!dmId || !messageId) return;
        const derivedKey = useAuthStore.getState().derivedKey;
        await deleteCachedMessage(messageId);
        const content = await decryptDMContent(
          activeTeamId,
          derivedKey,
          messageId,
          payload.content,
          payload.author_id,
          dmId,
        );
        const existing = useDMStore.getState().dmMessages[dmId] ?? [];
        const target = existing.find((m) => m.id === messageId);
        if (!target) return;
        useDMStore.getState().updateDMMessage(dmId, {
          ...target,
          content,
          encryptedContent: payload.content,
          editedAt: new Date().toISOString(),
        });
      },
    );

    const unsubDelete = ws.on('dm:message:deleted', (payload: {
      dm_id?: string;
      dm_channel_id?: string;
      message_id: string;
    }) => {
      const dmId = payload.dm_id ?? payload.dm_channel_id ?? '';
      if (!dmId) return;
      useDMStore.getState().removeDMMessage(dmId, payload.message_id);
    });

    const unsubTyping = ws.on(
      'dm:typing:indicator',
      (payload: { dm_id: string; user_id: string; username: string }) => {
        // useDMStore.dmTyping is keyed by dmId → string[] of userIds. Push
        // this user in (deduped); a real implementation would expire entries
        // after a few seconds, but that's a separate concern.
        const state = useDMStore.getState();
        const current = state.dmTyping[payload.dm_id] ?? [];
        if (!current.includes(payload.user_id)) {
          state.setDMTyping(payload.dm_id, [...current, payload.user_id]);
        }
      },
    );

    return () => {
      unsubCreated();
      unsubNew();
      unsubEdit();
      unsubDelete();
      unsubTyping();
    };
  }, [activeTeamId, cryptoReady]);
}
