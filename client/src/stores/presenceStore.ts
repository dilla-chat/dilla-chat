import { create } from 'zustand';

export interface UserPresence {
  user_id: string;
  status: 'online' | 'idle' | 'dnd' | 'offline';
  custom_status: string;
  last_active: string;
}

interface PresenceState {
  presences: Record<string, Record<string, UserPresence>>; // teamId -> userId -> presence
  myStatus: 'online' | 'idle' | 'dnd' | 'offline';
  myCustomStatus: string;

  setPresences: (teamId: string, presences: Record<string, UserPresence>) => void;
  updatePresence: (teamId: string, presence: UserPresence) => void;
  setMyStatus: (status: 'online' | 'idle' | 'dnd' | 'offline') => void;
  setMyCustomStatus: (text: string) => void;
  getPresence: (teamId: string, userId: string) => UserPresence | undefined;
}

export const usePresenceStore = create<PresenceState>((set, get) => ({
  presences: {},
  myStatus: 'online',
  myCustomStatus: '',

  setPresences: (teamId, presences) =>
    set((state) => ({
      presences: { ...state.presences, [teamId]: presences },
    })),

  updatePresence: (teamId, presence) =>
    set((state) => ({
      presences: {
        ...state.presences,
        [teamId]: {
          ...(state.presences[teamId] ?? {}),
          [presence.user_id]: presence,
        },
      },
    })),

  setMyStatus: (status) => set({ myStatus: status }),

  setMyCustomStatus: (text) => set({ myCustomStatus: text }),

  getPresence: (teamId, userId) => {
    return get().presences[teamId]?.[userId];
  },
}));
