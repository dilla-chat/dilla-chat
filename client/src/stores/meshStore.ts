import { create } from 'zustand';

export type MeshStatus = 'ok' | 'degraded' | 'ready';

export interface ConnectionBanner {
  kind: 'reconnecting' | 'offline' | 'restored' | 'error';
  message: string;
}

interface MeshState {
  /** Human-friendly node id, e.g. "gbg-1.dilla.local" */
  nodeName: string;
  /** Number of peers currently connected (federation mesh) */
  peersConnected: number;
  /** Total number of peers configured */
  peersTotal: number;
  /** Lamport clock value */
  lamport: number;
  /** Latency p50 in ms */
  latencyMs: number;
  /** Mesh status: ok = all peers connected; degraded = some peers down; ready = solo */
  status: MeshStatus;
  /** Transient banner (reconnect / offline / restored). Null when hidden. */
  connectionBanner: ConnectionBanner | null;

  setNodeName: (v: string) => void;
  setPeers: (connected: number, total: number) => void;
  setLamport: (v: number) => void;
  tickLamport: () => void;
  setLatency: (ms: number) => void;
  setStatus: (s: MeshStatus) => void;
  showConnectionBanner: (b: ConnectionBanner) => void;
  hideConnectionBanner: () => void;
}

export const useMeshStore = create<MeshState>((set, get) => ({
  nodeName: '',
  peersConnected: 0,
  peersTotal: 0,
  lamport: 0,
  latencyMs: 0,
  status: 'ready',
  connectionBanner: null,

  setNodeName: (v) => set({ nodeName: v }),
  setPeers: (connected, total) =>
    set({
      peersConnected: Math.max(0, connected),
      peersTotal: Math.max(0, total),
    }),
  setLamport: (v) => set({ lamport: Math.max(0, v) }),
  tickLamport: () => set({ lamport: get().lamport + 1 }),
  setLatency: (ms) => set({ latencyMs: Math.max(0, ms) }),
  setStatus: (s) => set({ status: s }),
  showConnectionBanner: (b) => set({ connectionBanner: b }),
  hideConnectionBanner: () => set({ connectionBanner: null }),
}));
