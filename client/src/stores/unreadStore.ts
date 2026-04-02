import { create } from 'zustand';

interface UnreadState {
  /** channelId -> unread message count */
  counts: Record<string, number>;

  /** Set unread counts from sync:init response */
  setCounts: (counts: Record<string, number>) => void;

  /** Increment unread for a channel (when new message arrives in inactive channel) */
  increment: (channelId: string) => void;

  /** Mark a channel as read (set count to 0) */
  markRead: (channelId: string) => void;
}

export const useUnreadStore = create<UnreadState>((set) => ({
  counts: {},
  setCounts: (counts) => set({ counts }),
  increment: (channelId) =>
    set((s) => ({
      counts: { ...s.counts, [channelId]: (s.counts[channelId] || 0) + 1 },
    })),
  markRead: (channelId) =>
    set((s) => ({
      counts: { ...s.counts, [channelId]: 0 },
    })),
}));
