import { create } from 'zustand';

// Local mirror of the caller's `/users/me/blocks` list. The server is
// the authority — it filters message:new broadcasts before they reach
// us — but the client also reads this set to hide cached messages and
// gray out blocked authors in member lists.

interface BlockState {
  blocked: Set<string>;
  setAll: (ids: string[]) => void;
  block: (userId: string) => void;
  unblock: (userId: string) => void;
  isBlocked: (userId: string) => boolean;
  clear: () => void;
}

export const useBlockStore = create<BlockState>((set, get) => ({
  blocked: new Set(),
  setAll: (ids) => set({ blocked: new Set(ids) }),
  block: (userId) =>
    set((state) => {
      if (state.blocked.has(userId)) return state;
      const next = new Set(state.blocked);
      next.add(userId);
      return { blocked: next };
    }),
  unblock: (userId) =>
    set((state) => {
      if (!state.blocked.has(userId)) return state;
      const next = new Set(state.blocked);
      next.delete(userId);
      return { blocked: next };
    }),
  isBlocked: (userId) => get().blocked.has(userId),
  clear: () => set({ blocked: new Set() }),
}));
