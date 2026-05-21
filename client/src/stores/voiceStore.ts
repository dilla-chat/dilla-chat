import { create } from 'zustand';
import { useAuthStore } from './authStore';
import type { VoicePeer } from '../services/api';

interface VoiceStore {
  currentChannelId: string | null;
  currentTeamId: string | null;
  connected: boolean;
  connecting: boolean;

  muted: boolean;
  deafened: boolean;
  speaking: boolean;
  screenSharing: boolean;
  /** The "primary" remote sharer for auto-focus purposes. With
   *  multiple simultaneous sharers, this holds the latest one. UI
   *  that lists all sharers should walk `peers` instead. */
  screenSharingUserId: string | null;
  /** Per-user screen-share streams keyed by user_id — symmetric to
   *  remoteWebcamStreams. Was previously a single MediaStream slot
   *  which conflated peers and made "A stops sharing"
   *  accidentally wipe B's stream on A's UI. */
  remoteScreenStreams: Record<string, MediaStream>;
  localScreenStream: MediaStream | null;
  webcamSharing: boolean;
  localWebcamStream: MediaStream | null;
  remoteWebcamStreams: Record<string, MediaStream>;

  peers: Record<string, VoicePeer>;

  // Voice occupants for ALL channels (not just the connected one)
  voiceOccupants: Record<string, VoicePeer[]>;

  e2eVoice: boolean;
  peerConnection: RTCPeerConnection | null;
  localStream: MediaStream | null;

  /** Rolling window of recent round-trip latencies (ms) to the SFU,
   *  sampled by WebRTCService.startStatsPoller() every ~600ms. Cap
   *  matches the sparkline bar count so the UI can render the
   *  whole window directly. */
  latencySamples: number[];
  /** Rolling window of recent outbound audio bitrate (kbps), same
   *  cadence and cap as latencySamples — drives the matching
   *  voice-dock sparkline. */
  bitrateSamples: number[];
  /** Per-peer most-recent RTT in ms. Each peer publishes its own
   *  measurement via the voice:latency WS event; this map is the
   *  fan-out cache so any card can read latency for any user. */
  peerLatencies: Record<string, number>;

  setE2eVoice(enabled: boolean): void;
  joinChannel(teamId: string, channelId: string): Promise<void>;
  leaveChannel(): void;
  toggleMute(): void;
  setMuted(muted: boolean): void;
  toggleDeafen(): void;
  setDeafened(deafened: boolean): void;
  setSpeaking(speaking: boolean): void;
  setScreenSharing(sharing: boolean): void;
  setScreenSharingUserId(userId: string | null): void;
  setRemoteScreenStream(userId: string, stream: MediaStream | null): void;
  setLocalScreenStream(stream: MediaStream | null): void;
  setWebcamSharing(sharing: boolean): void;
  setLocalWebcamStream(stream: MediaStream | null): void;
  setRemoteWebcamStream(userId: string, stream: MediaStream | null): void;
  setPeers(peers: VoicePeer[]): void;
  addPeer(peer: VoicePeer): void;
  removePeer(userId: string): void;
  updatePeer(userId: string, updates: Partial<VoicePeer>): void;
  setConnecting(connecting: boolean): void;
  setConnected(connected: boolean, channelId?: string, teamId?: string): void;
  setPeerConnection(pc: RTCPeerConnection | null): void;
  setLocalStream(stream: MediaStream | null): void;
  setVoiceOccupants(occupants: Record<string, VoicePeer[]>): void;
  addVoiceOccupant(channelId: string, peer: VoicePeer): void;
  removeVoiceOccupant(channelId: string, userId: string): void;
  updateVoiceOccupant(channelId: string, userId: string, patch: Partial<VoicePeer>): void;
  pushLatencySample(ms: number): void;
  pushBitrateSample(kbps: number): void;
  setPeerLatency(userId: string, ms: number): void;
  resetStatsWindow(): void;
  cleanup(): void;
}

const LATENCY_WINDOW_SIZE = 28;

export const useVoiceStore = create<VoiceStore>((set, get) => ({
  currentChannelId: null,
  currentTeamId: null,
  connected: false,
  connecting: false,
  muted: false,
  deafened: false,
  speaking: false,
  screenSharing: false,
  screenSharingUserId: null,
  remoteScreenStreams: {},
  localScreenStream: null,
  webcamSharing: false,
  localWebcamStream: null,
  remoteWebcamStreams: {},
  peers: {},
  voiceOccupants: {},
  e2eVoice: false,
  peerConnection: null,
  localStream: null,
  latencySamples: [],
  bitrateSamples: [],
  peerLatencies: {},

  setE2eVoice: (enabled: boolean) => set({ e2eVoice: enabled }),

  joinChannel: async (teamId: string, channelId: string) => {
    const state = get();
    if (state.connecting) return;
    // Already connected to this channel
    if (state.connected && state.currentChannelId === channelId) return;

    // Leave current channel first if connected elsewhere — AWAIT to avoid race
    if (state.connected || state.currentChannelId) {
      set({ connecting: true });
      try {
        const { webrtcService } = await import('../services/webrtc');
        await webrtcService.disconnect();
      } catch {
        // ignore disconnect errors
      }
      // Pull self out of voiceOccupants[oldChannel] locally so the
      // sidebar's 'Active voice' group hides immediately on switch.
      // The server's voice:user-left broadcast may or may not echo
      // back to the sender depending on hub.broadcast_to_all — this
      // mirrors what leaveChannel does for the explicit leave path.
      const prevChannelId = state.currentChannelId;
      const myId = state.currentTeamId
        ? useAuthStore.getState().teams.get(state.currentTeamId)?.user?.id
        : null;
      let cleanedOccupants = state.voiceOccupants;
      if (prevChannelId && myId) {
        cleanedOccupants = { ...state.voiceOccupants };
        const filtered = (cleanedOccupants[prevChannelId] ?? []).filter((p) => p.user_id !== myId);
        if (filtered.length === 0) delete cleanedOccupants[prevChannelId];
        else cleanedOccupants[prevChannelId] = filtered;
      }
      set({
        currentChannelId: null,
        currentTeamId: null,
        connected: false,
        muted: false,
        deafened: false,
        speaking: false,
        screenSharing: false,
        screenSharingUserId: null,
        remoteScreenStreams: {},
        localScreenStream: null,
        voiceOccupants: cleanedOccupants,
        webcamSharing: false,
        localWebcamStream: null,
        remoteWebcamStreams: {},
        peers: {},
        peerConnection: null,
        localStream: null,
      });
    }

    set({ connecting: true, currentTeamId: teamId, currentChannelId: channelId });

    try {
      const { webrtcService } = await import('../services/webrtc');
      const { playJoinSound } = await import('../services/sounds');
      await webrtcService.connect(channelId, teamId);
      playJoinSound();

      // Optimistic UI: render self in the participants list immediately
      // so the sidebar reacts to the click. We deliberately stay in
      // `connecting: true` here — the actual `connected: true` flip
      // happens only when the server's voice:state arrives confirming
      // we're in the room (see WebRTCService voice:state handler).
      // voice:join-denied or a handshake timeout tears it down.
      const authEntry = useAuthStore.getState().teams.get(teamId);
      const user = authEntry?.user ?? null;
      if (user?.id) {
        const selfPeer: VoicePeer = {
          user_id: user.id,
          username: user.username ?? 'You',
          muted: false,
          deafened: false,
          speaking: false,
          voiceLevel: 0,
        };
        set((s) => ({
          peers: { [user.id]: selfPeer, ...s.peers },
          voiceOccupants: {
            ...s.voiceOccupants,
            [channelId]: [
              selfPeer,
              ...(s.voiceOccupants[channelId] ?? []).filter((p) => p.user_id !== user.id),
            ],
          },
        }));
      } else {
        console.warn('[Voice] joinChannel: NO user.id, falling back');
      }

      // Safety net: if the server never confirms our join (voice:state
      // never arrives with us in the peer list, no voice:join-denied
      // either), tear down so the UI doesn't sit forever in
      // `connecting`.
      setTimeout(() => {
        const s = get();
        if (s.connecting && s.currentChannelId === channelId) {
          console.warn('[Voice] join handshake timed out — tearing down');
          window.dispatchEvent(new CustomEvent('dilla:notify', { detail: {
            channel: '', author: 'system', text: 'Voice join timed out — try again.', duration: 4000,
          }}));
          s.leaveChannel();
        }
      }, 8000);
    } catch (err) {
      console.error('[Voice] Join failed:', err);
      set({ connecting: false, currentChannelId: null, currentTeamId: null });
    }
  },

  leaveChannel: () => {
    const state = get();
    if (!state.connected && !state.connecting) return;
    // Leave voice channel and clean up WebRTC resources.

    import('../services/sounds').then(({ playLeaveSound }) => playLeaveSound());

    // Pull self out of voiceOccupants for the channel we just left so the
    // sidebar's 'Active voice' group hides immediately, even when the
    // server's voice:user-left broadcast doesn't (SFU may be off).
    const myId = state.currentTeamId
      ? useAuthStore.getState().teams.get(state.currentTeamId)?.user?.id
      : null;
    const leftChannelId = state.currentChannelId;
    const nextOccupants = { ...state.voiceOccupants };
    if (leftChannelId && myId) {
      const filtered = (nextOccupants[leftChannelId] ?? []).filter((p) => p.user_id !== myId);
      if (filtered.length === 0) delete nextOccupants[leftChannelId];
      else nextOccupants[leftChannelId] = filtered;
    }

    // Set state immediately so UI updates, then disconnect in background.
    set({
      currentChannelId: null,
      currentTeamId: null,
      connected: false,
      connecting: false,
      muted: false,
      deafened: false,
      speaking: false,
      screenSharing: false,
      screenSharingUserId: null,
      remoteScreenStreams: {},
      localScreenStream: null,
      webcamSharing: false,
      localWebcamStream: null,
      remoteWebcamStreams: {},
      peers: {},
      peerConnection: null,
      localStream: null,
      voiceOccupants: nextOccupants,
    });

    // Disconnect WebRTC in background
    import('../services/webrtc').then(({ webrtcService }) => {
      webrtcService.disconnect();
    });
  },

  toggleMute: () => {
    set((state) => ({ muted: !state.muted }));
  },

  setMuted: (muted: boolean) => set({ muted }),

  toggleDeafen: () => {
    set((state) => {
      const newDeafened = !state.deafened;
      // Deafen also mutes mic
      return { deafened: newDeafened, muted: newDeafened || state.muted };
    });
  },

  setDeafened: (deafened: boolean) => set({ deafened, muted: deafened || get().muted }),

  setSpeaking: (speaking: boolean) => set({ speaking }),
  setScreenSharing: (sharing: boolean) => set({ screenSharing: sharing }),
  setScreenSharingUserId: (userId: string | null) => set({ screenSharingUserId: userId }),
  setRemoteScreenStream: (userId: string, stream: MediaStream | null) => {
    if (stream === null) {
      console.log('[Voice/diag] setRemoteScreenStream(null) for', userId, 'stack:', new Error().stack);
    } else {
      console.log('[Voice/diag] setRemoteScreenStream(', stream.id, ') for', userId);
    }
    set((state) => {
      const streams = { ...state.remoteScreenStreams };
      if (stream === null) delete streams[userId];
      else streams[userId] = stream;
      return { remoteScreenStreams: streams };
    });
  },
  setLocalScreenStream: (stream: MediaStream | null) => set({ localScreenStream: stream }),
  setWebcamSharing: (sharing: boolean) => set({ webcamSharing: sharing }),
  setLocalWebcamStream: (stream: MediaStream | null) => set({ localWebcamStream: stream }),
  setRemoteWebcamStream: (userId: string, stream: MediaStream | null) => {
    if (stream === null) {
      console.log('[Voice/diag] setRemoteWebcamStream(null) for', userId, 'stack:', new Error().stack);
    } else {
      console.log('[Voice/diag] setRemoteWebcamStream(', stream.id, ') for', userId);
    }
    set((state) => {
      const streams = { ...state.remoteWebcamStreams };
      if (stream) {
        streams[userId] = stream;
      } else {
        delete streams[userId];
      }
      return { remoteWebcamStreams: streams };
    });
  },

  setPeers: (peers: VoicePeer[]) => {
    const map: Record<string, VoicePeer> = {};
    for (const p of peers) {
      map[p.user_id] = { ...p, voiceLevel: p.voiceLevel ?? 0 };
    }
    set({ peers: map });
  },

  addPeer: (peer: VoicePeer) => {
    set((state) => ({
      peers: { ...state.peers, [peer.user_id]: peer },
    }));
  },

  removePeer: (userId: string) => {
    set((state) => {
      const peers = { ...state.peers };
      delete peers[userId];
      return { peers };
    });
  },

  updatePeer: (userId: string, updates: Partial<VoicePeer>) => {
    if ('screen_sharing' in updates || 'webcam_sharing' in updates) {
      console.log('[Voice/diag] updatePeer', userId, updates, 'stack:', new Error().stack);
    }
    set((state) => {
      const existing = state.peers[userId];
      if (!existing) return state;
      return {
        peers: { ...state.peers, [userId]: { ...existing, ...updates } },
      };
    });
  },

  setConnecting: (connecting: boolean) => set({ connecting }),
  setConnected: (connected: boolean, channelId?: string, teamId?: string) =>
    set({
      connected,
      connecting: false,
      ...(channelId === undefined ? {} : { currentChannelId: channelId }),
      ...(teamId === undefined ? {} : { currentTeamId: teamId }),
    }),

  setPeerConnection: (pc: RTCPeerConnection | null) => set({ peerConnection: pc }),
  setLocalStream: (stream: MediaStream | null) => set({ localStream: stream }),

  setVoiceOccupants: (occupants: Record<string, VoicePeer[]>) => {
    set({ voiceOccupants: occupants });
  },

  addVoiceOccupant: (channelId: string, peer: VoicePeer) => {
    set((s) => {
      const existing = s.voiceOccupants[channelId] ?? [];
      // Avoid duplicates
      if (existing.some((p) => p.user_id === peer.user_id)) return s;
      return { voiceOccupants: { ...s.voiceOccupants, [channelId]: [...existing, peer] } };
    });
  },

  removeVoiceOccupant: (channelId: string, userId: string) => {
    set((s) => {
      const existing = s.voiceOccupants[channelId];
      if (!existing) return s;
      const filtered = existing.filter((p) => p.user_id !== userId);
      if (filtered.length === 0) {
        const rest = Object.fromEntries(
          Object.entries(s.voiceOccupants).filter(([key]) => key !== channelId),
        );
        return { voiceOccupants: rest };
      }
      return { voiceOccupants: { ...s.voiceOccupants, [channelId]: filtered } };
    });
  },

  updateVoiceOccupant: (channelId: string, userId: string, patch: Partial<VoicePeer>) => {
    set((s) => {
      const existing = s.voiceOccupants[channelId];
      if (!existing) return s;
      const updated = existing.map((p) =>
        p.user_id === userId ? { ...p, ...patch } : p,
      );
      return { voiceOccupants: { ...s.voiceOccupants, [channelId]: updated } };
    });
  },

  pushLatencySample: (ms: number) => {
    set((s) => {
      const next = s.latencySamples.length >= LATENCY_WINDOW_SIZE
        ? [...s.latencySamples.slice(s.latencySamples.length - LATENCY_WINDOW_SIZE + 1), ms]
        : [...s.latencySamples, ms];
      return { latencySamples: next };
    });
  },

  pushBitrateSample: (kbps: number) => {
    set((s) => {
      const next = s.bitrateSamples.length >= LATENCY_WINDOW_SIZE
        ? [...s.bitrateSamples.slice(s.bitrateSamples.length - LATENCY_WINDOW_SIZE + 1), kbps]
        : [...s.bitrateSamples, kbps];
      return { bitrateSamples: next };
    });
  },

  setPeerLatency: (userId: string, ms: number) => {
    set((s) => ({ peerLatencies: { ...s.peerLatencies, [userId]: ms } }));
  },

  resetStatsWindow: () => set({ latencySamples: [], bitrateSamples: [], peerLatencies: {} }),

  cleanup: () => {
    const state = get();
    if (state.localStream) {
      state.localStream.getTracks().forEach((t) => t.stop());
    }
    if (state.peerConnection) {
      state.peerConnection.close();
    }
    set({
      currentChannelId: null,
      currentTeamId: null,
      connected: false,
      connecting: false,
      muted: false,
      deafened: false,
      speaking: false,
      screenSharing: false,
      screenSharingUserId: null,
      remoteScreenStreams: {},
      localScreenStream: null,
      webcamSharing: false,
      localWebcamStream: null,
      remoteWebcamStreams: {},
      peers: {},
      peerConnection: null,
      localStream: null,
      latencySamples: [],
      bitrateSamples: [],
      peerLatencies: {},
    });
  },
}));
