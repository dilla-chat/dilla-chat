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
import { useAuthStore } from '../stores/authStore';
import { useDMStore } from '../stores/dmStore';
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

export function useDMEvents(activeTeamId: string | null): void {
  useEffect(() => {
    if (!activeTeamId) return;

    const unsubNew = ws.on(
      'dm:message:new',
      async (payload: ServerMessage & { dm_id: string }) => {
        const derivedKey = useAuthStore.getState().derivedKey;
        const content = await decryptDMContent(
          activeTeamId,
          derivedKey,
          payload.id,
          payload.content,
          payload.author_id,
          payload.dm_id,
        );
        const base = serverToMessage(payload, content);
        useDMStore.getState().addDMMessage(payload.dm_id, withDmChannelId(base, payload.dm_id));
      },
    );

    const unsubEdit = ws.on(
      'dm:message:updated',
      async (payload: {
        dm_id: string;
        message_id: string;
        content: string;
        author_id: string;
        username: string;
      }) => {
        const derivedKey = useAuthStore.getState().derivedKey;
        await deleteCachedMessage(payload.message_id);
        const content = await decryptDMContent(
          activeTeamId,
          derivedKey,
          payload.message_id,
          payload.content,
          payload.author_id,
          payload.dm_id,
        );
        const existing = useDMStore.getState().dmMessages[payload.dm_id] ?? [];
        const target = existing.find((m) => m.id === payload.message_id);
        if (!target) return;
        useDMStore.getState().updateDMMessage(payload.dm_id, {
          ...target,
          content,
          encryptedContent: payload.content,
          editedAt: new Date().toISOString(),
        });
      },
    );

    const unsubDelete = ws.on('dm:message:deleted', (payload: { dm_id: string; message_id: string }) => {
      useDMStore.getState().removeDMMessage(payload.dm_id, payload.message_id);
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
      unsubNew();
      unsubEdit();
      unsubDelete();
      unsubTyping();
    };
  }, [activeTeamId]);
}
