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
  /** Quiet hours are server-backed (PATCH /users/me) so they follow the
   *  identity across devices. We mirror them here so reads are sync. */
  quietHoursEnabled: boolean;
  quietHoursFrom: string;
  quietHoursTo: string;

  setSelectedInputDevice: (v: string) => void;
  setSelectedOutputDevice: (v: string) => void;
  setInputThreshold: (v: number) => void;
  setInputVolume: (v: number) => void;
  setOutputVolume: (v: number) => void;
  setDesktopNotifications: (v: boolean) => void;
  setSoundNotifications: (v: boolean) => void;
  setTheme: (v: 'dark' | 'light' | 'minimal' | 'mesh') => void;
  setDensity: (v: 'compact' | 'regular' | 'cozy') => void;
  setQuietHours: (next: { enabled?: boolean; from?: string; to?: string }) => void;
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
      quietHoursEnabled: false,
      quietHoursFrom: '22:00',
      quietHoursTo: '07:30',

      setSelectedInputDevice: (v) => set({ selectedInputDevice: v }),
      setSelectedOutputDevice: (v) => set({ selectedOutputDevice: v }),
      setInputThreshold: (v) => set({ inputThreshold: v }),
      setInputVolume: (v) => set({ inputVolume: v }),
      setOutputVolume: (v) => set({ outputVolume: v }),
      setDesktopNotifications: (v) => set({ desktopNotifications: v }),
      setSoundNotifications: (v) => set({ soundNotifications: v }),
      setTheme: (v) => set({ theme: v }),
      setDensity: (v) => set({ density: v }),
      setQuietHours: (next) =>
        set((state) => ({
          quietHoursEnabled: next.enabled ?? state.quietHoursEnabled,
          quietHoursFrom: next.from ?? state.quietHoursFrom,
          quietHoursTo: next.to ?? state.quietHoursTo,
        })),
    }),
    {
      name: 'dilla-user-settings',
      version: 3,
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
        if (version < 3) {
          // Quiet hours moved server-side. Local persist starts at the same
          // defaults the server uses; useUserMeSync overwrites them with
          // whatever the user actually saved on first auth.
          state = {
            ...state,
            quietHoursEnabled: state.quietHoursEnabled ?? false,
            quietHoursFrom: state.quietHoursFrom ?? '22:00',
            quietHoursTo: state.quietHoursTo ?? '07:30',
          };
        }
        return state;
      },
    },
  ),
);
