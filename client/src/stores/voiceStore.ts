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
  screenSharingUserId: string | null;
  remoteScreenStream: MediaStream | null;
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

  setE2eVoice(enabled: boolean): void;
  joinChannel(teamId: string, channelId: string): Promise<void>;
  leaveChannel(): void;
  toggleMute(): void;
  toggleDeafen(): void;
  setSpeaking(speaking: boolean): void;
  setScreenSharing(sharing: boolean): void;
  setScreenSharingUserId(userId: string | null): void;
  setRemoteScreenStream(stream: MediaStream | null): void;
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
  cleanup(): void;
}

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
  remoteScreenStream: null,
  localScreenStream: null,
  webcamSharing: false,
  localWebcamStream: null,
  remoteWebcamStreams: {},
  peers: {},
  voiceOccupants: {},
  e2eVoice: false,
  peerConnection: null,
  localStream: null,

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
      set({
        currentChannelId: null,
        currentTeamId: null,
        connected: false,
        muted: false,
        deafened: false,
        speaking: false,
        screenSharing: false,
        screenSharingUserId: null,
        remoteScreenStream: null,
        localScreenStream: null,
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

      // Immediately add self as a peer so the user sees themselves right away.
      const authEntry = useAuthStore.getState().teams.get(teamId);
      const user = authEntry?.user as { id?: string; username?: string } | null;
      console.log('[Voice] joinChannel: authEntry user =', JSON.stringify(user), 'teamId =', teamId);
      console.log('[Voice] joinChannel: current peers =', JSON.stringify(get().peers));
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
          connected: true,
          connecting: false,
          peers: { [user.id!]: selfPeer, ...s.peers },
        }));
        console.log('[Voice] joinChannel: peers after set =', JSON.stringify(get().peers));
      } else {
        console.warn('[Voice] joinChannel: NO user.id, falling back');
        set({ connected: true, connecting: false });
      }
    } catch (err) {
      console.error('[Voice] Join failed:', err);
      set({ connecting: false, currentChannelId: null, currentTeamId: null });
    }
  },

  leaveChannel: () => {
    const state = get();
    if (!state.connected && !state.connecting) return;
    console.log('[Voice] leaveChannel() called');

    import('../services/sounds').then(({ playLeaveSound }) => playLeaveSound());

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
      remoteScreenStream: null,
      localScreenStream: null,
      webcamSharing: false,
      localWebcamStream: null,
      remoteWebcamStreams: {},
      peers: {},
      peerConnection: null,
      localStream: null,
    });

    // Disconnect WebRTC in background
    import('../services/webrtc').then(({ webrtcService }) => {
      webrtcService.disconnect();
    });
  },

  toggleMute: () => {
    set((state) => ({ muted: !state.muted }));
  },

  toggleDeafen: () => {
    set((state) => {
      const newDeafened = !state.deafened;
      // Deafen also mutes mic
      return { deafened: newDeafened, muted: newDeafened ? true : state.muted };
    });
  },

  setSpeaking: (speaking: boolean) => set({ speaking }),
  setScreenSharing: (sharing: boolean) => set({ screenSharing: sharing }),
  setScreenSharingUserId: (userId: string | null) => set({ screenSharingUserId: userId }),
  setRemoteScreenStream: (stream: MediaStream | null) => set({ remoteScreenStream: stream }),
  setLocalScreenStream: (stream: MediaStream | null) => set({ localScreenStream: stream }),
  setWebcamSharing: (sharing: boolean) => set({ webcamSharing: sharing }),
  setLocalWebcamStream: (stream: MediaStream | null) => set({ localWebcamStream: stream }),
  setRemoteWebcamStream: (userId: string, stream: MediaStream | null) => set((state) => {
    const streams = { ...state.remoteWebcamStreams };
    if (stream) {
      streams[userId] = stream;
    } else {
      delete streams[userId];
    }
    return { remoteWebcamStreams: streams };
  }),

  setPeers: (peers: VoicePeer[]) => {
    console.log('[Voice] setPeers called with', peers?.length ?? 0, 'peers');
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
      ...(channelId !== undefined ? { currentChannelId: channelId } : {}),
      ...(teamId !== undefined ? { currentTeamId: teamId } : {}),
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
        const { [channelId]: _, ...rest } = s.voiceOccupants;
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
      remoteScreenStream: null,
        localScreenStream: null,
      webcamSharing: false,
      localWebcamStream: null,
      remoteWebcamStreams: {},
      peers: {},
      peerConnection: null,
      localStream: null,
    });
  },
}));
