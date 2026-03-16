import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AudioSettingsStore {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;

  setEchoCancellation: (v: boolean) => void;
  setNoiseSuppression: (v: boolean) => void;
  setAutoGainControl: (v: boolean) => void;

  /** Build MediaTrackConstraints for getUserMedia audio */
  getAudioConstraints: (deviceId?: string) => MediaTrackConstraints | boolean;
}

export const useAudioSettingsStore = create<AudioSettingsStore>()(
  persist(
    (set, get) => ({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,

      setEchoCancellation: (v) => set({ echoCancellation: v }),
      setNoiseSuppression: (v) => set({ noiseSuppression: v }),
      setAutoGainControl: (v) => set({ autoGainControl: v }),

      getAudioConstraints: (deviceId?: string) => {
        const { echoCancellation, noiseSuppression, autoGainControl } = get();
        const constraints: MediaTrackConstraints = {
          echoCancellation,
          noiseSuppression,
          autoGainControl,
        };
        if (deviceId && deviceId !== 'default') {
          constraints.deviceId = { exact: deviceId };
        }
        return constraints;
      },
    }),
    { name: 'dilla-audio-settings' },
  ),
);
