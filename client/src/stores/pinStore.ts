import { create } from 'zustand';

// Per-channel pinned-message ids. The hardcoded PINNED_BY_CHANNEL map in
// ChatApp got replaced by this — sync:init seeds the map, the
// message:pin-update WS event patches in-place, and the pin pop reads
// the channel-scoped Set so .has() / .size are O(1) on hot paths.

interface PinState {
  /** channelId -> Set<messageId> */
  pinned: Map<string, Set<string>>;
  /** Seed from sync:init: array of {channel_id, message_id}. Replaces any
   *  prior state for the channels mentioned; leaves untouched channels alone. */
  setAll: (entries: Array<{ channel_id: string; message_id: string }>) => void;
  /** Mark a single message pinned (idempotent). */
  pin: (channelId: string, messageId: string) => void;
  /** Drop a single message from the pinned set. */
  unpin: (channelId: string, messageId: string) => void;
  /** Read-only lookup for the renderer. */
  isPinned: (channelId: string, messageId: string) => boolean;
  /** All pinned ids for a channel, ordered by insertion (callers can sort
   *  by message createdAt themselves if they care). */
  forChannel: (channelId: string) => string[];
  clear: () => void;
}

export const usePinStore = create<PinState>((set, get) => ({
  pinned: new Map(),
  setAll: (entries) =>
    set((state) => {
      const next = new Map(state.pinned);
      // Group incoming entries by channel so we replace per channel.
      const byChan = new Map<string, Set<string>>();
      for (const e of entries) {
        if (!e?.channel_id || !e?.message_id) continue;
        if (!byChan.has(e.channel_id)) byChan.set(e.channel_id, new Set());
        byChan.get(e.channel_id)!.add(e.message_id);
      }
      for (const [cid, ids] of byChan) next.set(cid, ids);
      return { pinned: next };
    }),
  pin: (channelId, messageId) =>
    set((state) => {
      const next = new Map(state.pinned);
      const existing = next.get(channelId) ?? new Set<string>();
      if (existing.has(messageId)) return state;
      const updated = new Set(existing);
      updated.add(messageId);
      next.set(channelId, updated);
      return { pinned: next };
    }),
  unpin: (channelId, messageId) =>
    set((state) => {
      const existing = state.pinned.get(channelId);
      if (!existing || !existing.has(messageId)) return state;
      const next = new Map(state.pinned);
      const updated = new Set(existing);
      updated.delete(messageId);
      next.set(channelId, updated);
      return { pinned: next };
    }),
  isPinned: (channelId, messageId) => {
    return get().pinned.get(channelId)?.has(messageId) ?? false;
  },
  forChannel: (channelId) => [...(get().pinned.get(channelId) ?? [])],
  clear: () => set({ pinned: new Map() }),
}));
