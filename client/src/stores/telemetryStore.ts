import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface TelemetryStore {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
}

export const useTelemetryStore = create<TelemetryStore>()(
  persist(
    (set) => ({
      enabled: false,
      setEnabled: (v) => set({ enabled: v }),
    }),
    { name: 'dilla-telemetry' },
  ),
);
