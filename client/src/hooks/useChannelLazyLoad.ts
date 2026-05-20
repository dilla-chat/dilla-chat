import { useEffect, useRef } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { useTeamStore } from '../stores/teamStore';
import { useMessageStore, type Message } from '../stores/messageStore';
import { isMockSession } from '../services/mockSession';
import { tryDecrypt, serverToMessage, type ServerMessage } from './useMessageDecryption';

const PAGE_SIZE = 50;
const TOP_THRESHOLD_PX = 200;

/**
 * Wire the channel feed's scroll container to fetch older messages when
 * the user scrolls near the top. Matches the page-size convention used
 * by ChannelView/DMView/ThreadPanel (50). Lift this into a shared hook
 * if a third surface needs the same plumbing.
 *
 * Scroll-anchoring: when older messages prepend the DOM the scrollHeight
 * grows; we capture the offset-from-bottom *before* the fetch and
 * restore it after the store updates so the user keeps reading the
 * messages they were looking at instead of being yanked.
 */
export function useChannelLazyLoad(
  channelId: string | null,
  scrollRef: React.RefObject<HTMLElement | null>,
): void {
  const inflight = useRef(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !channelId) return;
    if (isMockSession()) return; // /mesh seeds messages directly, no REST.

    async function maybeLoad() {
      if (inflight.current) return;
      if (!el) return;
      if (el.scrollTop > TOP_THRESHOLD_PX) return;

      const teamId = useTeamStore.getState().activeTeamId;
      if (!teamId) return;

      const state = useMessageStore.getState();
      if (state.loadingHistory.get(channelId!) ?? false) return;
      if (state.hasMore.get(channelId!) === false) return;

      const existing = state.messages.get(channelId!) ?? [];
      if (existing.length === 0) return; // initial fetch hasn't landed yet
      const oldest = existing[0];

      inflight.current = true;
      state.setLoadingHistory(channelId!, true);

      // Capture viewport anchor: distance from the current scroll
      // position to the bottom of the scrollable content. After
      // prepending older history we restore that offset so the user
      // stays parked on the same messages instead of being yanked
      // upward by the freshly mounted prepend.
      const anchorOffsetFromBottom = el.scrollHeight - el.scrollTop;

      try {
        const raw = (await api.getMessages(
          teamId,
          channelId!,
          PAGE_SIZE,
          oldest.createdAt,
        )) as ServerMessage[];

        const derivedKey = useAuthStore.getState().derivedKey;
        const members = useTeamStore.getState().members.get(teamId) ?? [];

        const decrypted: Message[] = [];
        for (const sm of raw) {
          const content = await tryDecrypt(
            sm.id,
            sm.content,
            sm.author_id,
            sm.channel_id,
            derivedKey,
          );
          decrypted.push(serverToMessage(sm, content, members));
        }

        useMessageStore.getState().prependMessages(channelId!, decrypted);
        useMessageStore.getState().setHasMore(channelId!, decrypted.length >= PAGE_SIZE);

        // Wait a frame for the new DOM to mount, then restore scroll
        // so the user keeps reading the messages they were looking at.
        requestAnimationFrame(() => {
          if (!el) return;
          el.scrollTop = el.scrollHeight - anchorOffsetFromBottom;
        });
      } catch (err) {
        console.warn('[useChannelLazyLoad] fetch failed', err);
      } finally {
        useMessageStore.getState().setLoadingHistory(channelId!, false);
        inflight.current = false;
      }
    }

    el.addEventListener('scroll', maybeLoad, { passive: true });
    // Trigger an initial check in case the channel has so few messages
    // that we're already at the top of the viewport on mount.
    maybeLoad();

    return () => {
      el.removeEventListener('scroll', maybeLoad);
    };
  }, [channelId, scrollRef]);
}
