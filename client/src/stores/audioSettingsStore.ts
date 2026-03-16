import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type InputProfile = 'voice-isolation' | 'studio' | 'custom';
export type NoiseSuppressionMode = 'none' | 'browser' | 'rnnoise';

interface AudioSettingsStore {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  enhancedNoiseSuppression: boolean;
  inputProfile: InputProfile;
  noiseSuppressionMode: NoiseSuppressionMode;
  pushToTalk: boolean;
  pushToTalkKey: string;

  setEchoCancellation: (v: boolean) => void;
  setNoiseSuppression: (v: boolean) => void;
  setAutoGainControl: (v: boolean) => void;
  setEnhancedNoiseSuppression: (v: boolean) => void;
  setInputProfile: (v: InputProfile) => void;
  setNoiseSuppressionMode: (v: NoiseSuppressionMode) => void;
  setPushToTalk: (v: boolean) => void;
  setPushToTalkKey: (v: string) => void;

  /** Build MediaTrackConstraints for getUserMedia audio */
  getAudioConstraints: (deviceId?: string) => MediaTrackConstraints | boolean;
}

export const useAudioSettingsStore = create<AudioSettingsStore>()(
  persist(
    (set, get) => ({
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: true,
      enhancedNoiseSuppression: true,
      inputProfile: 'voice-isolation',
      noiseSuppressionMode: 'rnnoise',
      pushToTalk: false,
      pushToTalkKey: 'KeyV',

      setEchoCancellation: (v) => set({ echoCancellation: v }),
      setNoiseSuppression: (v) => set({ noiseSuppression: v }),
      setAutoGainControl: (v) => set({ autoGainControl: v }),
      setEnhancedNoiseSuppression: (v) => set({ enhancedNoiseSuppression: v }),

      setInputProfile: (v) => {
        const updates: Partial<AudioSettingsStore> = { inputProfile: v };
        if (v === 'voice-isolation') {
          updates.noiseSuppressionMode = 'rnnoise';
          updates.noiseSuppression = false;
          updates.enhancedNoiseSuppression = true;
          updates.echoCancellation = true;
          updates.autoGainControl = true;
        } else if (v === 'studio') {
          updates.noiseSuppressionMode = 'none';
          updates.noiseSuppression = false;
          updates.enhancedNoiseSuppression = false;
          updates.echoCancellation = false;
          updates.autoGainControl = false;
        }
        // 'custom' — no derived changes
        set(updates);
      },

      setNoiseSuppressionMode: (v) => {
        const updates: Partial<AudioSettingsStore> = { noiseSuppressionMode: v };
        if (v === 'none') {
          updates.noiseSuppression = false;
          updates.enhancedNoiseSuppression = false;
        } else if (v === 'browser') {
          updates.noiseSuppression = true;
          updates.enhancedNoiseSuppression = false;
        } else if (v === 'rnnoise') {
          updates.noiseSuppression = false;
          updates.enhancedNoiseSuppression = true;
        }
        set(updates);
      },

      setPushToTalk: (v) => set({ pushToTalk: v }),
      setPushToTalkKey: (v) => set({ pushToTalkKey: v }),

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
