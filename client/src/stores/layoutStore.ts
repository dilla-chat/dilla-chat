import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 360;
const MEMBERS_MIN = 180;
const MEMBERS_MAX = 340;

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(Math.max(n, lo), hi);

interface LayoutStore {
  sidebarWidth: number;
  membersWidth: number;
  topBarEnabled: boolean;
  bottomBarEnabled: boolean;

  setSidebarWidth: (v: number) => void;
  setMembersWidth: (v: number) => void;
  nudgeSidebarWidth: (delta: number) => void;
  nudgeMembersWidth: (delta: number) => void;
  toggleTopBar: () => void;
  toggleBottomBar: () => void;
}

export const useLayoutStore = create<LayoutStore>()(
  persist(
    (set, get) => ({
      sidebarWidth: 240,
      membersWidth: 232,
      topBarEnabled: false,
      bottomBarEnabled: false,

      setSidebarWidth: (v) =>
        set({ sidebarWidth: clamp(v, SIDEBAR_MIN, SIDEBAR_MAX) }),
      setMembersWidth: (v) =>
        set({ membersWidth: clamp(v, MEMBERS_MIN, MEMBERS_MAX) }),
      nudgeSidebarWidth: (delta) =>
        set({
          sidebarWidth: clamp(
            get().sidebarWidth + delta,
            SIDEBAR_MIN,
            SIDEBAR_MAX,
          ),
        }),
      nudgeMembersWidth: (delta) =>
        set({
          membersWidth: clamp(
            get().membersWidth + delta,
            MEMBERS_MIN,
            MEMBERS_MAX,
          ),
        }),
      toggleTopBar: () => set({ topBarEnabled: !get().topBarEnabled }),
      toggleBottomBar: () => set({ bottomBarEnabled: !get().bottomBarEnabled }),
    }),
    { name: 'dilla-layout' },
  ),
);
