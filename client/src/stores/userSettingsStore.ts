import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UserSettingsStore {
  selectedInputDevice: string;
  selectedOutputDevice: string;
  inputThreshold: number;
  inputVolume: number;
  outputVolume: number;
  desktopNotifications: boolean;
  soundNotifications: boolean;
  theme: 'dark' | 'light' | 'minimal' | 'mesh';
  density: 'compact' | 'regular' | 'cozy';

  setSelectedInputDevice: (v: string) => void;
  setSelectedOutputDevice: (v: string) => void;
  setInputThreshold: (v: number) => void;
  setInputVolume: (v: number) => void;
  setOutputVolume: (v: number) => void;
  setDesktopNotifications: (v: boolean) => void;
  setSoundNotifications: (v: boolean) => void;
  setTheme: (v: 'dark' | 'light' | 'minimal' | 'mesh') => void;
  setDensity: (v: 'compact' | 'regular' | 'cozy') => void;
}

export const useUserSettingsStore = create<UserSettingsStore>()(
  persist(
    (set) => ({
      selectedInputDevice: 'default',
      selectedOutputDevice: 'default',
      inputThreshold: 0.15,
      inputVolume: 1,
      outputVolume: 1,
      desktopNotifications: true,
      soundNotifications: true,
      theme: 'mesh',
      density: 'regular',

      setSelectedInputDevice: (v) => set({ selectedInputDevice: v }),
      setSelectedOutputDevice: (v) => set({ selectedOutputDevice: v }),
      setInputThreshold: (v) => set({ inputThreshold: v }),
      setInputVolume: (v) => set({ inputVolume: v }),
      setOutputVolume: (v) => set({ outputVolume: v }),
      setDesktopNotifications: (v) => set({ desktopNotifications: v }),
      setSoundNotifications: (v) => set({ soundNotifications: v }),
      setTheme: (v) => set({ theme: v }),
      setDensity: (v) => set({ density: v }),
    }),
    {
      name: 'dilla-user-settings',
      version: 2,
      migrate: (persistedState, version) => {
        let state = (persistedState ?? {}) as Partial<UserSettingsStore>;
        if (version < 1) {
          state = { ...state, density: 'regular' as const };
        }
        if (version < 2) {
          // Mesh is the new default; users on the previous default ('dark')
          // get flipped to mesh. Anyone who explicitly chose light/minimal
          // keeps their pick.
          state = {
            ...state,
            theme: state.theme === 'dark' ? 'mesh' : (state.theme ?? 'mesh'),
          };
        }
        return state;
      },
    },
  ),
);
