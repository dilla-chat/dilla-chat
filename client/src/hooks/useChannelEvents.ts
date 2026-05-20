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

import { useEffect, useRef } from 'react';
import { ws } from '../services/websocket';
import { useAuthStore } from '../stores/authStore';
import { useTeamStore } from '../stores/teamStore';
import { useMessageStore } from '../stores/messageStore';
import { tryDecrypt, forgetDecryptFailure, serverToMessage, type ServerMessage } from './useMessageDecryption';
import { deleteCachedMessage } from '../services/messageCache';
import { useChannelMuteStore } from '../stores/channelMuteStore';
import { cryptoService, getIdentityKeys } from '../services/crypto';
import { toBase64 } from '../services/crypto/helpers';

export function useChannelEvents(activeTeamId: string | null, cryptoReady: boolean = true): void {
  // Loop prevention: remember the exact payload of each incoming distribute
  // we've already processed and echoed back. Keyed as
  // `${channelId}:${peerId}:${distributionJson}` — if the SAME payload
  // arrives again (which happens when our re-distribute makes the peer
  // re-distribute too), skip both processing and the echo. A peer with a
  // genuinely new chain state will have a different payload, so they're
  // re-processed and re-echoed.
  const seenDistributes = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!activeTeamId) return;
    // Don't subscribe until crypto is initialized — channel:key-distribute
    // events arriving during the restore window would otherwise be dropped
    // silently (we'd ignore them because cryptoService isn't ready). Once
    // ready flips true, the effect re-runs and we attach listeners; any
    // distributes that follow will be processed correctly.
    if (!cryptoReady) return;

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

      // Mention notifier: if the decrypted content contains @<myUsername>
      // or @everyone / @here, fire a toast (skip when *I'm* the author).
      const me = (window as { SHELL_DATA?: { currentUserId?: string; byId?: Record<string, { name?: string; username?: string }> } }).SHELL_DATA;
      const myId = me?.currentUserId;
      const myRecord = myId ? me?.byId?.[myId] : null;
      const myHandles: string[] = [];
      if (myRecord?.name) myHandles.push(myRecord.name);
      if (myRecord?.username) myHandles.push(myRecord.username);
      const handlePattern = myHandles.length ? new RegExp('@(' + myHandles.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'i') : null;
      const isBroadcast = /@(everyone|here)\b/i.test(content);
      const isDirect = handlePattern ? handlePattern.test(content) : false;
      if ((isDirect || isBroadcast) && payload.author_id !== myId) {
        // Honour channel mutes — but only suppress broadcast pings.
        // Direct @me always notifies even on a muted channel (Discord
        // pattern); broadcast @everyone/@here is suppressed.
        const muted = useChannelMuteStore.getState().isMuted(payload.channel_id);
        const shouldNotify = isDirect || !muted;
        if (shouldNotify) {
          const author = members.find((m) => m.userId === payload.author_id);
          const channelName = (useTeamStore.getState().channels.get(activeTeamId) ?? [])
            .find((c) => c.id === payload.channel_id)?.name || '';
          window.dispatchEvent(new CustomEvent('dilla:notify', {
            detail: {
              channel: channelName,
              channelId: payload.channel_id,
              author: author?.username || 'someone',
              text: content.slice(0, 240),
              duration: 5000,
              kind: 'mention',
              mention: true,
            },
          }));
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
            try {
              const n = new Notification('Mentioned by ' + (author?.username || 'someone') + (channelName ? ' in #' + channelName : ''), { body: content.slice(0, 240) });
              n.onclick = () => { window.focus(); n.close(); };
            } catch { /* ignore */ }
          }
        }
      }
    });

    const unsubRejected = ws.on(
      'message:rejected',
      (payload: { channel_id?: string; reason?: string; retry_in?: number }) => {
        const reason = payload?.reason ?? 'rejected';
        let text = 'Your message was rejected.';
        if (reason === 'slow_mode') {
          const wait = payload.retry_in ?? 0;
          text = wait > 0
            ? `Slow mode is on — wait ${wait}s before posting again.`
            : 'Slow mode is on.';
        }
        const channelName = payload.channel_id
          ? (useTeamStore.getState().channels.get(activeTeamId) ?? []).find((c) => c.id === payload.channel_id)?.name
          : '';
        window.dispatchEvent(new CustomEvent('dilla:notify', {
          detail: { channel: channelName || '', channelId: payload.channel_id, author: 'system', text, duration: 4000 },
        }));
      },
    );

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
        // Probe identity availability before processing. If crypto isn't
        // initialized yet (e.g., the local CryptoRestore is still in flight
        // or the user's identity unlock failed), drop the distribute on the
        // floor instead of crashing the handler. The peer will re-emit when
        // they next interact, and once crypto is ready we'll pick it up
        // from the next echo.
        let ownId = '';
        try {
          ownId = toBase64(getIdentityKeys().publicKeyBytes);
        } catch {
          console.warn('[useChannelEvents] skipping distribute — crypto not ready');
          return;
        }

        // Skip exact-duplicate distributes: same channel + sender + payload
        // means we've already absorbed this state once. Without this, our
        // own echo would bounce back from every peer and we'd echo again
        // ad infinitum. A genuinely new chain position from the peer has
        // a different `distribution` JSON, so it's processed fresh.
        const fp = `${payload.channel_id}:${payload.sender_id}:${payload.distribution}`;
        if (seenDistributes.current.has(fp)) return;
        seenDistributes.current.add(fp);

        try {
          await cryptoService.processSenderKey(payload.channel_id, payload.distribution, derivedKey);
        } catch (err) {
          console.warn('[useChannelEvents] sender-key processing failed', err);
          return;
        }

        // A fresh sender key for this channel may unlock messages that
        // failed decryption earlier in this session. Clear the per-msg
        // failure set so the next render attempt can take another shot.
        forgetDecryptFailure(payload.channel_id);

        // Echo back our own sender key to the channel when we see another
        // peer's distribute. This closes the join-order race: if we
        // distributed before this peer subscribed to the channel, our
        // earlier broadcast never reached them. We skip echoes of our own
        // distribute (sender_id === ownId) to avoid the immediate
        // self-bounce.
        if (!payload.sender_id || payload.sender_id === ownId) return;
        try {
          const dist = await cryptoService.getSenderKeyDistribution(payload.channel_id, derivedKey);
          ws.distributeChannelKey(activeTeamId, payload.channel_id, dist);
        } catch (err) {
          console.warn('[useChannelEvents] sender-key redistribute failed', err);
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
      unsubRejected();
      unsubDelete();
      unsubTyping();
      unsubKeyDist();
      unsubReactAdd();
      unsubReactRem();
    };
  }, [activeTeamId, cryptoReady]);
}
