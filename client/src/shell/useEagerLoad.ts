// Eager loader for the shell. ChatApp reads the full shell-data
// snapshot on first render — it doesn't lazy-load per-channel like the
// legacy ChannelView did. So once useTeamSync has populated channels
// via sync:init, walk every channel and prefetch messages, threads,
// thread replies, and DMs. Each fetch goes through the real api
// singleton (which the mock has swapped in on /mesh), so the load
// flow is identical to prod — just kicked off eagerly instead of
// on-click.
//
// Returns `ready` so MockShell / App can gate ChatApp's first render until
// all fixtures have landed (otherwise ChatApp's useState captures empty
// maps).

import { useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { useTeamStore } from '../stores/teamStore';
import { useMessageStore } from '../stores/messageStore';
import { useDMStore, type DMChannel } from '../stores/dmStore';
import { useThreadStore, type Thread } from '../stores/threadStore';
import { tryDecrypt, serverToMessage, type ServerMessage } from '../hooks/useMessageDecryption';
import { cryptoService, isCryptoInitialized } from '../services/crypto';
import { isMockSession } from '../services/mockSession';
import { getCachedMessage, cacheMessage } from '../services/messageCache';
import { ws } from '../services/websocket';
import { usePollStore, normalizePoll } from '../stores/pollStore';

type DecryptFn = (id: string, content: string, authorId: string, channelId: string) => Promise<string>;

function makeChannelDecrypter(decryptChannel: DecryptFn, members: Parameters<typeof serverToMessage>[2], channelId: string) {
  return async (m: ServerMessage) => {
    const content = await decryptChannel(m.id, m.content, m.author_id, channelId);
    return serverToMessage(m, content, members);
  };
}

function makeDmDecrypter(
  decryptDMContent: (msg: ServerMessage, dmId: string) => Promise<string>,
  members: Parameters<typeof serverToMessage>[2],
  dmId: string,
) {
  return async (m: ServerMessage) => {
    const content = await decryptDMContent(m, dmId);
    return { ...serverToMessage(m, content, members), channelId: dmId };
  };
}

function makeThreadLoader(loadOneThread: (t: Thread, channelId: string) => Promise<void>, channelId: string) {
  return (t: Thread) => loadOneThread(t, channelId);
}

export function useEagerLoad(activeTeamId: string | null, cryptoReady: boolean = true): { ready: boolean } {
  const loaded = useRef<Set<string>>(new Set());
  const [ready, setReady] = useState(false);
  // Bump on ws:connected so the effect re-runs and re-fetches messages,
  // which is how we pick up edits that landed while we were offline.
  const [reloadTick, setReloadTick] = useState(0);
  // Subscribe to channels/members so the effect re-runs once sync:init lands.
  const channels = useTeamStore((s) => (activeTeamId ? s.channels.get(activeTeamId) : undefined));
  const members = useTeamStore((s) => (activeTeamId ? s.members.get(activeTeamId) : undefined));

  useEffect(() => {
    if (!activeTeamId) return;
    const unsub = ws.on('ws:connected', (payload: { teamId?: string }) => {
      if (payload?.teamId === activeTeamId) {
        loaded.current.delete(activeTeamId);
        setReloadTick((n) => n + 1);
      }
    });
    return () => { unsub(); };
  }, [activeTeamId]);

  useEffect(() => {
    if (!activeTeamId) return;
    if (!channels || channels.length === 0 || !members) return;
    // Crypto must be initialized before we distribute or decrypt — without
    // this gate, an early sync:init would call cryptoService methods against
    // a null manager and spam "Crypto not initialized" warnings. Re-running
    // once cryptoReady flips true picks up the work cleanly. Mock sessions
    // (/mesh) skip the gate entirely — there's no real crypto manager but
    // the load flow is otherwise identical to prod.
    if (!isMockSession() && (!cryptoReady || !isCryptoInitialized())) return;
    if (loaded.current.has(activeTeamId)) return;
    loaded.current.add(activeTeamId);

    void (async () => {
      const msgStore = useMessageStore.getState();
      const dmStore = useDMStore.getState();
      const threadStore = useThreadStore.getState();
      const derivedKey = useAuthStore.getState().derivedKey;
      const textChannels = channels.filter((c) => c.type === 'text');
      // Mock sessions ship plaintext fixtures and never call initCrypto.
      // Routing each message through tryDecrypt would then throw "Crypto
      // not initialized" 15× per channel load — noise that masked real
      // warnings. Short-circuit to a passthrough in that mode.
      const mock = isMockSession();
      const decryptChannel = mock
        ? async (_id: string, content: string) => content
        : (id: string, content: string, authorId: string, channelId: string) =>
            tryDecrypt(id, content, authorId, channelId, derivedKey);

      // Distribute our sender key for every text channel so other team
      // members can decrypt our messages. The legacy ChannelView did this
      // on per-channel mount; the shell shows all channels at once, so
      // we batch it here right after sync:init. Each call is independent
      // and best-effort — if one channel's key fetch fails the others
      // still get distributed.
      if (derivedKey && activeTeamId && !isMockSession()) {
        for (const ch of textChannels) {
          (async () => {
            try {
              ws.joinChannel(activeTeamId, ch.id);
              const dist = await cryptoService.getSenderKeyDistribution(ch.id, derivedKey);
              ws.distributeChannelKey(activeTeamId, ch.id, dist);
            } catch (err) {
              console.warn('[useEagerLoad] sender-key distribute failed for', ch.id, err);
            }
          })();
        }
      } else if (isMockSession() && activeTeamId) {
        // Still subscribe to channel rooms in the mock so WS broadcasts
        // (poll:new, message:new) land — just skip the crypto distribute.
        for (const ch of textChannels) ws.joinChannel(activeTeamId, ch.id);
      }

      // DM messages use a separate Signal session per-peer, not channel
      // sender keys — so they need their own decryption path that
      // mirrors the legacy DMView.tsx flow.
      const decryptDMContent = async (
        msg: ServerMessage,
        dmId: string,
      ): Promise<string> => {
        if (mock) return msg.content;
        const cached = await getCachedMessage(msg.id);
        if (cached !== null) return cached;
        if (!derivedKey) return msg.content;
        try {
          const plaintext = await cryptoService.decryptDM(
            activeTeamId,
            msg.author_id,
            msg.content,
            dmId,
            derivedKey,
          );
          await cacheMessage(msg.id, dmId, plaintext);
          return plaintext;
        } catch {
          return msg.content;
        }
      };

      // Fetch every text channel's history in parallel. Decrypt each message
      // via tryDecrypt before stashing in the store so the UI doesn't render
      // raw ciphertext after a reload.
      const messageLoads = textChannels.map(async (ch) => {
        try {
          const raw = (await api.getMessages(activeTeamId, ch.id, 50)) as ServerMessage[];
          const msgs = await Promise.all(raw.map(makeChannelDecrypter(decryptChannel, members, ch.id)));
          msgStore.prependMessages(ch.id, msgs);
          msgStore.setHasMore(ch.id, raw.length >= 50);
        } catch { /* mock won't reject; ignore */ }
      });

      // Fetch polls per text channel. Stash them in pollStore so the
      // shell-side merge picks them up regardless of mount timing. Polls
      // are clear-text so no decryption pass needed.
      const pollLoads = textChannels.map(async (ch) => {
        try {
          const polls = (await api.getPolls(activeTeamId, ch.id)) as any[];
          const upsert = usePollStore.getState().upsert;
          for (const p of polls) upsert(normalizePoll(p));
        } catch { /* mock won't reject; ignore */ }
      });

      // DM channels + per-DM message history (uses decryptDM, not the
      // channel sender-key path).
      const loadOneDm = async (dm: DMChannel) => {
        const raw = (await api.getDMMessages(activeTeamId, dm.id, undefined, 50)) as ServerMessage[];
        const msgs = await Promise.all(raw.map(makeDmDecrypter(decryptDMContent, members, dm.id)));
        dmStore.setDMMessages(dm.id, msgs);
      };
      const dmLoad = (async () => {
        try {
          const dms = (await api.getDMChannels(activeTeamId)) as DMChannel[];
          dmStore.setDMChannels(activeTeamId, dms);
          await Promise.all(dms.map(loadOneDm));
        } catch { /* ignore */ }
      })();

      // Threads + replies per text channel. Thread messages use the same
      // sender-key path as the parent channel (decrypt with channel id).
      const loadOneThread = async (t: Thread, channelId: string) => {
        const raw = (await api.getThreadMessages(activeTeamId, t.id)) as ServerMessage[];
        const msgs = await Promise.all(raw.map(makeChannelDecrypter(decryptChannel, members, channelId)));
        threadStore.setThreadMessages(t.id, msgs);
      };
      const threadLoads = textChannels.map(async (ch) => {
        try {
          const threads = (await api.getChannelThreads(activeTeamId, ch.id)) as Thread[];
          threadStore.setThreads(ch.id, threads);
          await Promise.all(threads.map(makeThreadLoader(loadOneThread, ch.id)));
        } catch { /* ignore */ }
      });

      await Promise.all([...messageLoads, ...pollLoads, dmLoad, ...threadLoads]);
      setReady(true);
    })();
  }, [activeTeamId, channels, members, cryptoReady, reloadTick]);

  return { ready };
}
