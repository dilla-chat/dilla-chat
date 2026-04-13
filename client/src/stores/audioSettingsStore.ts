import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type InputProfile = 'voice-isolation' | 'studio' | 'custom';
export type NoiseSuppressionMode = 'none' | 'browser' | 'dfn3';

interface AudioSettingsStore {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  inputProfile: InputProfile;
  noiseSuppressionMode: NoiseSuppressionMode;
  pushToTalk: boolean;
  pushToTalkKey: string;
  vadThreshold: number;
  vadGracePeriodMs: number;
  retroactiveGraceMs: number;

  setEchoCancellation: (v: boolean) => void;
  setNoiseSuppression: (v: boolean) => void;
  setAutoGainControl: (v: boolean) => void;
  setInputProfile: (v: InputProfile) => void;
  setNoiseSuppressionMode: (v: NoiseSuppressionMode) => void;
  setPushToTalk: (v: boolean) => void;
  setPushToTalkKey: (v: string) => void;
  setVadThreshold: (v: number) => void;
  setVadGracePeriodMs: (v: number) => void;
  setRetroactiveGraceMs: (v: number) => void;

  /** Build MediaTrackConstraints for getUserMedia audio */
  getAudioConstraints: (deviceId?: string) => MediaTrackConstraints | boolean;
}

export const useAudioSettingsStore = create<AudioSettingsStore>()(
  persist(
    (set, get) => ({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      inputProfile: 'voice-isolation',
      noiseSuppressionMode: 'browser',
      pushToTalk: false,
      pushToTalkKey: 'KeyV',
      vadThreshold: 0.5,
      vadGracePeriodMs: 200,
      retroactiveGraceMs: 20,

      setEchoCancellation: (v) => set({ echoCancellation: v }),
      setNoiseSuppression: (v) => set({ noiseSuppression: v }),
      setAutoGainControl: (v) => set({ autoGainControl: v }),

      setInputProfile: (v) => {
        const updates: Partial<AudioSettingsStore> = { inputProfile: v };
        if (v === 'voice-isolation') {
          updates.noiseSuppressionMode = 'dfn3';
          updates.noiseSuppression = true;
          updates.echoCancellation = true;
          updates.autoGainControl = true;
        } else if (v === 'studio') {
          updates.noiseSuppressionMode = 'none';
          updates.noiseSuppression = false;
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
        } else if (v === 'dfn3') {
          // Keep browser NS on — it helps the VAD see a clean signal.
          // DFN3 adds deeper suppression on top in the WebRTC pipeline.
          updates.noiseSuppression = true;
        } else if (v === 'browser') {
          updates.noiseSuppression = true;
        }
        set(updates);
      },

      setPushToTalk: (v) => set({ pushToTalk: v }),
      setPushToTalkKey: (v) => set({ pushToTalkKey: v }),
      setVadThreshold: (v) => set({ vadThreshold: v }),
      setVadGracePeriodMs: (v) => set({ vadGracePeriodMs: v }),
      setRetroactiveGraceMs: (v) => set({ retroactiveGraceMs: v }),

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
