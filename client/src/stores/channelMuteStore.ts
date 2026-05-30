import { create } from 'zustand';

interface MuteState {
  /** Map of channelId -> mutedUntil ISO string (or null = indefinite). */
  muted: Map<string, string | null>;
  setAll: (entries: Array<{ channel_id: string; muted_until: string | null }>) => void;
  setMuted: (channelId: string, mutedUntil: string | null) => void;
  clear: (channelId: string) => void;
  isMuted: (channelId: string) => boolean;
}

export const useChannelMuteStore = create<MuteState>((set, get) => ({
  muted: new Map(),
  setAll: (entries) =>
    set({ muted: new Map(entries.map((e) => [e.channel_id, e.muted_until ?? null])) }),
  setMuted: (channelId, mutedUntil) =>
    set((state) => {
      const next = new Map(state.muted);
      next.set(channelId, mutedUntil);
      return { muted: next };
    }),
  clear: (channelId) =>
    set((state) => {
      const next = new Map(state.muted);
      next.delete(channelId);
      return { muted: next };
    }),
  isMuted: (channelId) => {
    const v = get().muted.get(channelId);
    if (v === undefined) return false;
    if (v === null) return true;
    return new Date(v).getTime() > Date.now();
  },
}));
