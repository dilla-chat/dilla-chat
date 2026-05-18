// Eager loader for the shell. ChatApp captures the full MOCK_DATA snapshot
// on first render — it doesn't lazy-load per-channel like the legacy
// ChannelView does. So once useTeamSync has populated channels via
// sync:init, walk every channel and prefetch messages, threads, thread
// replies, and DMs. Each fetch goes through the real api singleton (which
// the mock has swapped in on /mesh), so the load flow is identical to
// prod — just kicked off eagerly instead of on-click.
//
// Returns `ready` so MockShell / App can gate ChatApp's first render until
// all fixtures have landed (otherwise ChatApp's useState captures empty
// maps).

import { useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { useTeamStore } from '../stores/teamStore';
import { useMessageStore } from '../stores/messageStore';
import { useDMStore, type DMChannel } from '../stores/dmStore';
import { useThreadStore, type Thread } from '../stores/threadStore';
import { serverToMessage, type ServerMessage } from '../hooks/useMessageDecryption';

export function useEagerLoad(activeTeamId: string | null): { ready: boolean } {
  const loaded = useRef<Set<string>>(new Set());
  const [ready, setReady] = useState(false);
  // Subscribe to channels/members so the effect re-runs once sync:init lands.
  const channels = useTeamStore((s) => (activeTeamId ? s.channels.get(activeTeamId) : undefined));
  const members = useTeamStore((s) => (activeTeamId ? s.members.get(activeTeamId) : undefined));

  useEffect(() => {
    if (!activeTeamId) return;
    if (!channels || channels.length === 0 || !members) return;
    if (loaded.current.has(activeTeamId)) return;
    loaded.current.add(activeTeamId);

    void (async () => {
      const msgStore = useMessageStore.getState();
      const dmStore = useDMStore.getState();
      const threadStore = useThreadStore.getState();
      const textChannels = channels.filter((c) => c.type === 'text');

      // Fetch every text channel's history in parallel.
      const messageLoads = textChannels.map(async (ch) => {
        try {
          const raw = (await api.getMessages(activeTeamId, ch.id, 50)) as ServerMessage[];
          const msgs = raw.map((m) => serverToMessage(m, m.content, members));
          msgStore.prependMessages(ch.id, msgs);
          msgStore.setHasMore(ch.id, false);
        } catch { /* mock won't reject; ignore */ }
      });

      // DM channels + per-DM message history.
      const dmLoad = (async () => {
        try {
          const dms = (await api.getDMChannels(activeTeamId)) as DMChannel[];
          dmStore.setDMChannels(activeTeamId, dms);
          await Promise.all(
            dms.map(async (dm) => {
              const raw = (await api.getDMMessages(activeTeamId, dm.id, undefined, 50)) as ServerMessage[];
              const msgs = raw.map((m) => serverToMessage(m, m.content, members));
              dmStore.setDMMessages(dm.id, msgs);
            }),
          );
        } catch { /* ignore */ }
      })();

      // Threads + replies per text channel.
      const threadLoads = textChannels.map(async (ch) => {
        try {
          const threads = (await api.getChannelThreads(activeTeamId, ch.id)) as Thread[];
          threadStore.setThreads(ch.id, threads);
          await Promise.all(
            threads.map(async (t) => {
              const raw = (await api.getThreadMessages(activeTeamId, t.id)) as ServerMessage[];
              const msgs = raw.map((m) => serverToMessage(m, m.content, members));
              threadStore.setThreadMessages(t.id, msgs);
            }),
          );
        } catch { /* ignore */ }
      });

      await Promise.all([...messageLoads, dmLoad, ...threadLoads]);
      setReady(true);
    })();
  }, [activeTeamId, channels, members]);

  return { ready };
}
