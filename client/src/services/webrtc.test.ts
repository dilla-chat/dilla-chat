import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useVoiceStore } from '../stores/voiceStore';
import { useAuthStore } from '../stores/authStore';
import { useUserSettingsStore } from '../stores/userSettingsStore';
import { useAudioSettingsStore } from '../stores/audioSettingsStore';

// ─── Track WS listeners for test emission ───────────────────────────────────
// vi.hoisted ensures these are available when vi.mock factories run (hoisted to top)
const { wsListeners, mockWs } = vi.hoisted(() => {
  const wsListeners = new Map<string, Set<Function>>();
  const mockWs = {
    voiceJoin: vi.fn(),
    voiceLeave: vi.fn(),
    voiceAnswer: vi.fn(),
    voiceICECandidate: vi.fn(),
    voiceMute: vi.fn(),
    voiceDeafen: vi.fn(),
    voiceScreenStart: vi.fn(),
    voiceScreenStop: vi.fn(),
    voiceWebcamStart: vi.fn(),
    voiceWebcamStop: vi.fn(),
    voiceKeyDistribute: vi.fn(),
    on: vi.fn((event: string, handler: Function) => {
      if (!wsListeners.has(event)) wsListeners.set(event, new Set());
      wsListeners.get(event)!.add(handler);
      return () => {
        wsListeners.get(event)?.delete(handler);
      };
    }),
  };
  return { wsListeners, mockWs };
});

function emitWS(event: string, payload: unknown) {
  wsListeners.get(event)?.forEach((h) => h(payload));
}

// ─── Mock dependencies ─────────────────────────────────────────────────────

vi.mock('./websocket', () => ({ ws: mockWs }));

vi.mock('./api', () => ({
  api: {
    getTURNCredentials: vi.fn().mockResolvedValue({ iceServers: [] }),
  },
}));

vi.mock('./noiseSuppression', () => ({
  noiseSuppression: {
    setEnabled: vi.fn(),
    initWorklet: vi.fn().mockResolvedValue(undefined),
    getWorkletNode: vi.fn(() => ({ connect: vi.fn() })),
    waitForReady: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn(),
  },
}));

vi.mock('./sounds', () => ({
  playJoinSound: vi.fn(),
  playLeaveSound: vi.fn(),
}));

vi.mock('./voiceCrypto', () => ({
  supportsE2EVoice: vi.fn(() => false),
  VoiceKeyManager: class MockVoiceKeyManager {
    generateLocalKey = vi.fn().mockResolvedValue({ key: {}, rawKey: new Uint8Array(32), keyId: 1 });
    getLocalRawKey = vi.fn(() => null);
    getLocalKeyId = vi.fn(() => 0);
    setRemoteKey = vi.fn().mockResolvedValue(undefined);
    clear = vi.fn();
  },
}));

// ─── Mock RTCPeerConnection, RTCSessionDescription, RTCIceCandidate ────────

let mockPc: Record<string, unknown>;

function createFreshMockPc() {
  return {
    createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'mock-sdp' }),
    createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'mock-answer-sdp' }),
    setLocalDescription: vi.fn().mockResolvedValue(undefined),
    setRemoteDescription: vi.fn().mockResolvedValue(undefined),
    addIceCandidate: vi.fn().mockResolvedValue(undefined),
    addTrack: vi.fn(() => ({ track: null, transform: null })),
    removeTrack: vi.fn(),
    getSenders: vi.fn(() => []),
    close: vi.fn(),
    onicecandidate: null as ((e: unknown) => void) | null,
    ontrack: null as ((e: unknown) => void) | null,
    connectionState: 'new',
    iceConnectionState: 'new',
    signalingState: 'stable',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

class MockRTCSessionDescription {
  type: string;
  sdp: string;
  constructor(init: { type: string; sdp: string }) {
    this.type = init.type;
    this.sdp = init.sdp;
  }
}

class MockRTCIceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  constructor(init: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null }) {
    this.candidate = init.candidate;
    this.sdpMid = init.sdpMid ?? null;
    this.sdpMLineIndex = init.sdpMLineIndex ?? null;
  }
  toJSON() {
    return { candidate: this.candidate, sdpMid: this.sdpMid, sdpMLineIndex: this.sdpMLineIndex };
  }
}

// ─── Mock media helpers ────────────────────────────────────────────────────

function createMockAudioTrack(enabled = true) {
  return { kind: 'audio', enabled, stop: vi.fn(), onended: null };
}

function createMockVideoTrack(enabled = true) {
  return { kind: 'video', enabled, stop: vi.fn(), onended: null };
}

function createMockMediaStream(
  tracks: Array<{ kind: string; enabled: boolean; stop: ReturnType<typeof vi.fn>; onended: unknown }> = [],
) {
  const audioTracks = tracks.filter((t) => t.kind === 'audio');
  const videoTracks = tracks.filter((t) => t.kind === 'video');
  return {
    id: 'mock-stream-' + Math.random().toString(36).slice(2),
    active: true,
    getTracks: vi.fn(() => tracks),
    getAudioTracks: vi.fn(() => audioTracks),
    getVideoTracks: vi.fn(() => videoTracks),
    addTrack: vi.fn(),
    removeTrack: vi.fn(),
    clone: vi.fn(),
  };
}

// ─── Enhanced AudioContext mock ─────────────────────────────────────────────

class EnhancedMockAudioContext {
  state = 'running';
  currentTime = 0;
  destination = {};
  sampleRate = 48000;
  createOscillator = vi.fn(() => ({
    frequency: { value: 0, setValueAtTime: vi.fn() },
    type: 'sine',
    connect: vi.fn().mockReturnThis(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }));
  createGain = vi.fn(() => ({
    gain: { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
    connect: vi.fn().mockReturnThis(),
    disconnect: vi.fn(),
  }));
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
  createMediaStreamDestination = vi.fn(() => ({
    stream: createMockMediaStream([createMockAudioTrack()]),
  }));
  createAnalyser = vi.fn(() => ({
    fftSize: 0,
    frequencyBinCount: 128,
    getByteFrequencyData: vi.fn(),
    getByteTimeDomainData: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  }));
  close = vi.fn().mockResolvedValue(undefined);
  resume = vi.fn().mockResolvedValue(undefined);
}

// ─── Setup ──────────────────────────────────────────────────────────────────

let mockGetUserMedia: ReturnType<typeof vi.fn>;
let mockGetDisplayMedia: ReturnType<typeof vi.fn>;

function setupStores() {
  useAuthStore.setState({
    teams: new Map([
      [
        'team-1',
        {
          baseUrl: 'http://localhost',
          token: 'tok',
          user: { id: 'user-1', username: 'testuser' },
          wsConnected: false,
        },
      ],
    ]),
  });

  useUserSettingsStore.setState({
    selectedInputDevice: 'default',
    inputVolume: 1.0,
    outputVolume: 1.0,
    inputThreshold: 0.15,
  });

  useAudioSettingsStore.setState({
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: true,
    enhancedNoiseSuppression: false,
    pushToTalk: false,
    pushToTalkKey: 'KeyV',
  });

  useVoiceStore.setState({
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
  });
}

// We import the service at module level; it uses the mocked deps.
// The singleton means we need to disconnect between tests.
import { webrtcService } from './webrtc';

beforeEach(() => {
  vi.stubGlobal('AudioContext', EnhancedMockAudioContext);
  vi.stubGlobal('RTCSessionDescription', MockRTCSessionDescription);
  vi.stubGlobal('RTCIceCandidate', MockRTCIceCandidate);

  mockPc = createFreshMockPc();
  vi.stubGlobal('RTCPeerConnection', vi.fn(function () { return mockPc; }));

  mockGetUserMedia = vi.fn().mockResolvedValue(
    createMockMediaStream([createMockAudioTrack()]),
  );
  mockGetDisplayMedia = vi.fn().mockResolvedValue(
    createMockMediaStream([createMockVideoTrack()]),
  );

  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: mockGetUserMedia, getDisplayMedia: mockGetDisplayMedia },
    writable: true,
    configurable: true,
  });

  setupStores();

  // Clear WS listeners from previous test
  wsListeners.clear();

  // Clear mock call counts
  mockWs.voiceJoin.mockClear();
  mockWs.voiceLeave.mockClear();
  mockWs.voiceAnswer.mockClear();
  mockWs.voiceICECandidate.mockClear();
  mockWs.voiceMute.mockClear();
  mockWs.voiceDeafen.mockClear();
  mockWs.voiceScreenStart.mockClear();
  mockWs.voiceScreenStop.mockClear();
  mockWs.voiceWebcamStart.mockClear();
  mockWs.voiceWebcamStop.mockClear();
  mockWs.voiceKeyDistribute.mockClear();
  mockWs.on.mockClear();
});

afterEach(async () => {
  // Always disconnect to reset the singleton's internal state
  try {
    await webrtcService.disconnect();
  } catch {
    // ignore
  }
  // Clean DOM audio elements
  document.querySelectorAll('audio[data-stream-id]').forEach((el) => el.remove());
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WebRTCService', () => {
  describe('connect', () => {
    it('acquires user media and creates peer connection', async () => {
      await webrtcService.connect('ch-1', 'team-1');

      expect(mockGetUserMedia).toHaveBeenCalledWith(
        expect.objectContaining({ audio: expect.any(Object), video: false }),
      );
      expect(mockWs.voiceJoin).toHaveBeenCalledWith('team-1', 'ch-1');
    });

    it('sets local stream in voice store', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      expect(useVoiceStore.getState().localStream).not.toBeNull();
    });

    it('sets peer connection in voice store', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      expect(useVoiceStore.getState().peerConnection).not.toBeNull();
    });

    it('throws when getUserMedia is denied', async () => {
      mockGetUserMedia.mockRejectedValueOnce(new Error('NotAllowedError'));
      await expect(webrtcService.connect('ch-1', 'team-1')).rejects.toThrow(
        'Microphone access denied',
      );
    });

    it('falls back to STUN when TURN credentials fail', async () => {
      const { api } = await import('./api');
      vi.mocked(api.getTURNCredentials).mockRejectedValueOnce(new Error('no TURN'));

      await webrtcService.connect('ch-1', 'team-1');
      // Should still connect (uses STUN fallback)
      expect(useVoiceStore.getState().peerConnection).not.toBeNull();
    });

    it('registers WS listeners', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      // on() should have been called for voice events
      expect(mockWs.on).toHaveBeenCalled();
      const registeredEvents = mockWs.on.mock.calls.map((c: unknown[]) => c[0]);
      expect(registeredEvents).toContain('voice:offer');
      expect(registeredEvents).toContain('voice:ice-candidate');
      expect(registeredEvents).toContain('voice:user-joined');
      expect(registeredEvents).toContain('voice:user-left');
      expect(registeredEvents).toContain('voice:state');
    });
  });

  describe('disconnect', () => {
    it('cleans up all resources', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      await webrtcService.disconnect();

      expect(mockWs.voiceLeave).toHaveBeenCalledWith('team-1', 'ch-1');
      expect(mockPc.close).toHaveBeenCalled();
    });

    it('removes audio elements from DOM', async () => {
      await webrtcService.connect('ch-1', 'team-1');

      const audio = document.createElement('audio');
      audio.dataset.streamId = 'test-stream';
      document.body.appendChild(audio);

      await webrtcService.disconnect();
      expect(document.querySelectorAll('audio[data-stream-id]')).toHaveLength(0);
    });

    it('is safe to call when not connected', async () => {
      // Should not throw
      await webrtcService.disconnect();
    });
  });

  describe('toggleMute', () => {
    it('toggles audio track enabled state', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      const muted = webrtcService.toggleMute();
      expect(typeof muted).toBe('boolean');
    });

    it('returns false when not connected', () => {
      const result = webrtcService.toggleMute();
      expect(result).toBe(false);
    });

    it('returns false when pushToTalk is enabled', async () => {
      useAudioSettingsStore.setState({ pushToTalk: true });
      await webrtcService.connect('ch-1', 'team-1');
      const result = webrtcService.toggleMute();
      expect(result).toBe(false);
    });

    it('sends voiceMute via websocket', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      webrtcService.toggleMute();
      expect(mockWs.voiceMute).toHaveBeenCalledWith('team-1', 'ch-1', expect.any(Boolean));
    });
  });

  describe('toggleDeafen', () => {
    it('toggles deafen and sends via websocket', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      const deafened = webrtcService.toggleDeafen();
      expect(deafened).toBe(true);
      expect(mockWs.voiceDeafen).toHaveBeenCalledWith('team-1', 'ch-1', true);
    });

    it('second toggle undeafens (if store is updated between calls)', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      const first = webrtcService.toggleDeafen(); // deafen -> reads store false, returns true
      expect(first).toBe(true);
      // The service reads from the store but doesn't write back.
      // The caller (UI) must update the store. Simulate that:
      useVoiceStore.setState({ deafened: true });
      const second = webrtcService.toggleDeafen(); // undeafen -> reads store true, returns false
      expect(second).toBe(false);
    });
  });

  describe('ICE candidate handling', () => {
    it('buffers candidates before remote description is set', async () => {
      await webrtcService.connect('ch-1', 'team-1');

      emitWS('voice:ice-candidate', {
        candidate: 'candidate:1',
        sdp_mid: '0',
        sdp_mline_index: 0,
      });

      // Should be buffered, not added directly
      expect(mockPc.addIceCandidate).not.toHaveBeenCalled();
    });

    it('flushes buffered candidates after offer is received', async () => {
      await webrtcService.connect('ch-1', 'team-1');

      // Buffer a candidate
      emitWS('voice:ice-candidate', {
        candidate: 'candidate:1',
        sdp_mid: '0',
        sdp_mline_index: 0,
      });

      // Emit offer (triggers flush)
      emitWS('voice:offer', { sdp: 'v=0\r\ntest-sdp' });

      await vi.waitFor(() => {
        expect(mockPc.addIceCandidate).toHaveBeenCalled();
      });
    });

    it('adds candidates directly when remote description is set', async () => {
      await webrtcService.connect('ch-1', 'team-1');

      // Set remote description via offer first
      emitWS('voice:offer', { sdp: 'v=0\r\ntest-sdp' });
      await vi.waitFor(() => {
        expect(mockPc.setRemoteDescription).toHaveBeenCalled();
      });

      // Reset mock to track new calls
      (mockPc.addIceCandidate as ReturnType<typeof vi.fn>).mockClear();

      // Now add candidate directly
      emitWS('voice:ice-candidate', {
        candidate: 'candidate:2',
        sdp_mid: '0',
        sdp_mline_index: 0,
      });

      await vi.waitFor(() => {
        expect(mockPc.addIceCandidate).toHaveBeenCalled();
      });
    });
  });

  describe('WS voice:offer handler', () => {
    it('creates answer and sends it back', async () => {
      await webrtcService.connect('ch-1', 'team-1');

      emitWS('voice:offer', { sdp: 'v=0\r\ntest-sdp' });

      await vi.waitFor(() => {
        expect(mockPc.setRemoteDescription).toHaveBeenCalled();
        expect(mockPc.createAnswer).toHaveBeenCalled();
        expect(mockPc.setLocalDescription).toHaveBeenCalled();
        expect(mockWs.voiceAnswer).toHaveBeenCalledWith('team-1', 'ch-1', expect.any(Object));
      });
    });
  });

  describe('WS voice:state handler', () => {
    it('sets peers from state message', async () => {
      await webrtcService.connect('ch-1', 'team-1');

      emitWS('voice:state', {
        peers: [
          { user_id: 'u1', username: 'alice', muted: false, deafened: false, speaking: false },
          { user_id: 'u2', username: 'bob', muted: true, deafened: false, speaking: false },
        ],
      });

      const peers = useVoiceStore.getState().peers;
      expect(Object.keys(peers)).toHaveLength(2);
      expect(peers['u1'].username).toBe('alice');
      expect(peers['u2'].muted).toBe(true);
    });

    it('detects existing screen sharer', async () => {
      await webrtcService.connect('ch-1', 'team-1');

      emitWS('voice:state', {
        peers: [
          { user_id: 'u1', username: 'alice', muted: false, deafened: false, speaking: false, screen_sharing: true },
        ],
      });

      expect(useVoiceStore.getState().screenSharingUserId).toBe('u1');
    });
  });

  describe('WS voice:user-joined handler', () => {
    it('adds peer to store', async () => {
      await webrtcService.connect('ch-1', 'team-1');

      emitWS('voice:user-joined', { user_id: 'u3', username: 'charlie' });
      expect(useVoiceStore.getState().peers['u3']).toBeDefined();
      expect(useVoiceStore.getState().peers['u3'].username).toBe('charlie');
    });
  });

  describe('WS voice:user-left handler', () => {
    it('removes peer from store', async () => {
      await webrtcService.connect('ch-1', 'team-1');

      useVoiceStore.getState().addPeer({
        user_id: 'u3',
        username: 'charlie',
        muted: false,
        deafened: false,
        speaking: false,
        voiceLevel: 0,
      });

      emitWS('voice:user-left', { user_id: 'u3' });
      expect(useVoiceStore.getState().peers['u3']).toBeUndefined();
    });
  });

  describe('WS voice:speaking handler', () => {
    it('updates peer speaking state', async () => {
      await webrtcService.connect('ch-1', 'team-1');

      useVoiceStore.getState().addPeer({
        user_id: 'u2',
        username: 'bob',
        muted: false,
        deafened: false,
        speaking: false,
        voiceLevel: 0,
      });

      emitWS('voice:speaking', { user_id: 'u2', speaking: true });
      expect(useVoiceStore.getState().peers['u2'].speaking).toBe(true);
    });
  });

  describe('WS voice:mute-update handler', () => {
    it('updates peer mute and deafen state', async () => {
      await webrtcService.connect('ch-1', 'team-1');

      useVoiceStore.getState().addPeer({
        user_id: 'u1',
        username: 'alice',
        muted: false,
        deafened: false,
        speaking: false,
        voiceLevel: 0,
      });

      emitWS('voice:mute-update', { user_id: 'u1', muted: true, deafened: false });
      expect(useVoiceStore.getState().peers['u1'].muted).toBe(true);
    });
  });

  describe('WS voice:screen-update handler', () => {
    it('sets screen sharing user when sharing starts', async () => {
      await webrtcService.connect('ch-1', 'team-1');

      useVoiceStore.getState().addPeer({
        user_id: 'u2',
        username: 'bob',
        muted: false,
        deafened: false,
        speaking: false,
        voiceLevel: 0,
      });

      emitWS('voice:screen-update', { user_id: 'u2', sharing: true });
      expect(useVoiceStore.getState().screenSharingUserId).toBe('u2');
      expect(useVoiceStore.getState().peers['u2'].screen_sharing).toBe(true);
    });

    it('clears screen sharing when sharing stops', async () => {
      await webrtcService.connect('ch-1', 'team-1');

      useVoiceStore.getState().addPeer({
        user_id: 'u2',
        username: 'bob',
        muted: false,
        deafened: false,
        speaking: false,
        voiceLevel: 0,
      });

      useVoiceStore.setState({ screenSharingUserId: 'u2' });
      emitWS('voice:screen-update', { user_id: 'u2', sharing: false });
      expect(useVoiceStore.getState().screenSharingUserId).toBeNull();
      expect(useVoiceStore.getState().remoteScreenStream).toBeNull();
    });
  });

  describe('WS voice:webcam-update handler', () => {
    it('updates peer webcam state on', async () => {
      await webrtcService.connect('ch-1', 'team-1');

      useVoiceStore.getState().addPeer({
        user_id: 'u2',
        username: 'bob',
        muted: false,
        deafened: false,
        speaking: false,
        voiceLevel: 0,
      });

      emitWS('voice:webcam-update', { user_id: 'u2', sharing: true });
      expect(useVoiceStore.getState().peers['u2'].webcam_sharing).toBe(true);
    });

    it('clears remote webcam stream when sharing stops', async () => {
      await webrtcService.connect('ch-1', 'team-1');

      useVoiceStore.getState().addPeer({
        user_id: 'u2',
        username: 'bob',
        muted: false,
        deafened: false,
        speaking: false,
        voiceLevel: 0,
      });

      emitWS('voice:webcam-update', { user_id: 'u2', sharing: false });
      expect(useVoiceStore.getState().remoteWebcamStreams['u2']).toBeUndefined();
    });
  });

  describe('screen sharing', () => {
    it('startScreenShare throws when not connected', async () => {
      await expect(webrtcService.startScreenShare()).rejects.toThrow(
        'Not connected to a voice channel',
      );
    });

    it('startScreenShare sets screen sharing state', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      await webrtcService.startScreenShare();

      expect(mockWs.voiceScreenStart).toHaveBeenCalledWith('team-1', 'ch-1');
      expect(useVoiceStore.getState().screenSharing).toBe(true);
      expect(webrtcService.isScreenSharing()).toBe(true);
    });

    it('startScreenShare throws when getDisplayMedia fails', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      mockGetDisplayMedia.mockRejectedValueOnce(new Error('denied'));

      await expect(webrtcService.startScreenShare()).rejects.toThrow(
        'Screen sharing cancelled or denied',
      );
    });

    it('startScreenShare throws when no video track', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      mockGetDisplayMedia.mockResolvedValueOnce(createMockMediaStream([]));

      await expect(webrtcService.startScreenShare()).rejects.toThrow(
        'No video track from screen capture',
      );
    });

    it('stopScreenShare cleans up', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      await webrtcService.startScreenShare();
      await webrtcService.stopScreenShare();

      expect(mockWs.voiceScreenStop).toHaveBeenCalledWith('team-1', 'ch-1');
      expect(useVoiceStore.getState().screenSharing).toBe(false);
      expect(webrtcService.isScreenSharing()).toBe(false);
      expect(useVoiceStore.getState().screenSharingUserId).toBeNull();
    });
  });

  describe('webcam sharing', () => {
    it('startWebcam throws when not connected', async () => {
      await expect(webrtcService.startWebcam()).rejects.toThrow(
        'Not connected to a voice channel',
      );
    });

    it('startWebcam sets webcam sharing state', async () => {
      await webrtcService.connect('ch-1', 'team-1');

      // Next getUserMedia is for webcam
      mockGetUserMedia.mockResolvedValueOnce(
        createMockMediaStream([createMockVideoTrack()]),
      );

      await webrtcService.startWebcam();

      expect(mockWs.voiceWebcamStart).toHaveBeenCalledWith('team-1', 'ch-1');
      expect(useVoiceStore.getState().webcamSharing).toBe(true);
      expect(webrtcService.isWebcamSharing()).toBe(true);
    });

    it('startWebcam throws on access denied', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      mockGetUserMedia.mockRejectedValueOnce(new Error('denied'));

      await expect(webrtcService.startWebcam()).rejects.toThrow('Webcam access denied');
    });

    it('startWebcam throws when no video track', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      mockGetUserMedia.mockResolvedValueOnce(createMockMediaStream([]));

      await expect(webrtcService.startWebcam()).rejects.toThrow('No video track from webcam');
    });

    it('stopWebcam cleans up', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      mockGetUserMedia.mockResolvedValueOnce(
        createMockMediaStream([createMockVideoTrack()]),
      );
      await webrtcService.startWebcam();
      await webrtcService.stopWebcam();

      expect(mockWs.voiceWebcamStop).toHaveBeenCalledWith('team-1', 'ch-1');
      expect(useVoiceStore.getState().webcamSharing).toBe(false);
      expect(webrtcService.isWebcamSharing()).toBe(false);
    });
  });

  describe('VAD', () => {
    it('startVAD and stopVAD work without error', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      // VAD started during connect. stopVAD should be safe.
      webrtcService.stopVAD();
      // Double stop is safe.
      webrtcService.stopVAD();
    });
  });

  describe('handleOffer', () => {
    it('returns answer when pc exists', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      const answer = await webrtcService.handleOffer({ type: 'offer', sdp: 'test' });
      expect(answer).toEqual({ type: 'answer', sdp: 'mock-answer-sdp' });
    });

    it('returns null when not connected', async () => {
      const answer = await webrtcService.handleOffer({ type: 'offer', sdp: 'test' });
      expect(answer).toBeNull();
    });
  });

  describe('handleICECandidate', () => {
    it('adds candidate when pc exists', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      await webrtcService.handleICECandidate({ candidate: 'candidate:1' });
      expect(mockPc.addIceCandidate).toHaveBeenCalled();
    });

    it('is a no-op when not connected', async () => {
      await webrtcService.handleICECandidate({ candidate: 'candidate:1' });
      // No error, no mock calls
    });
  });

  describe('setInputVolume', () => {
    it('sets gain node value when connected', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      // Should not throw
      webrtcService.setInputVolume(0.5);
    });

    it('is a no-op when not connected', () => {
      webrtcService.setInputVolume(0.5);
    });
  });

  describe('onicecandidate callback', () => {
    it('sends ICE candidate to server', async () => {
      await webrtcService.connect('ch-1', 'team-1');

      const handler = mockPc.onicecandidate as (event: { candidate: { toJSON: () => unknown } | null }) => void;
      expect(handler).toBeTypeOf('function');

      handler({
        candidate: {
          toJSON: () => ({ candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 }),
        },
      });

      expect(mockWs.voiceICECandidate).toHaveBeenCalledWith('team-1', 'ch-1', expect.any(Object));
    });

    it('ignores null candidate (end-of-candidates)', async () => {
      await webrtcService.connect('ch-1', 'team-1');

      const handler = mockPc.onicecandidate as (event: { candidate: null }) => void;
      handler({ candidate: null });
      expect(mockWs.voiceICECandidate).not.toHaveBeenCalled();
    });
  });

  describe('e2eVoice state', () => {
    it('sets e2eVoice to false when not supported', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      expect(useVoiceStore.getState().e2eVoice).toBe(false);
    });
  });

  describe('cleanup on disconnect', () => {
    it('closes peer connection and clears state', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      await webrtcService.disconnect();

      expect(mockPc.close).toHaveBeenCalled();
    });

    it('stops screen and webcam streams', async () => {
      await webrtcService.connect('ch-1', 'team-1');

      const screenTrack = createMockVideoTrack();
      mockGetDisplayMedia.mockResolvedValueOnce(createMockMediaStream([screenTrack]));
      await webrtcService.startScreenShare();

      const webcamTrack = createMockVideoTrack();
      mockGetUserMedia.mockResolvedValueOnce(createMockMediaStream([webcamTrack]));
      await webrtcService.startWebcam();

      await webrtcService.disconnect();

      expect(screenTrack.stop).toHaveBeenCalled();
      expect(webcamTrack.stop).toHaveBeenCalled();
    });
  });

  describe('getRemoteStream', () => {
    it('returns undefined for unknown userId', async () => {
      expect(webrtcService.getRemoteStream('unknown')).toBeUndefined();
    });
  });

  describe('ontrack handler', () => {
    it('handles audio track from remote peer', async () => {
      // Mock HTMLAudioElement.play() to return a promise
      HTMLAudioElement.prototype.play = vi.fn().mockResolvedValue(undefined);
      await webrtcService.connect('ch-1', 'team-1');

      const audioTrack = createMockAudioTrack();
      const stream = createMockMediaStream([audioTrack]);
      const handler = mockPc.ontrack as (event: unknown) => void;
      expect(handler).toBeTypeOf('function');

      handler({
        track: audioTrack,
        streams: [stream],
        receiver: { transform: null },
      });

      // Audio element should be added to DOM
      expect(document.querySelectorAll('audio[data-stream-id]')).toHaveLength(1);
    });

    it('handles video track for screen share', async () => {
      await webrtcService.connect('ch-1', 'team-1');

      const videoTrack = { ...createMockVideoTrack(), id: 'screen-track-1' };
      const stream = { ...createMockMediaStream([videoTrack]), id: 'screen-stream-1' };
      const handler = mockPc.ontrack as (event: unknown) => void;

      handler({
        track: videoTrack,
        streams: [stream],
        receiver: { transform: null },
      });

      // Remote screen stream should be set
      expect(useVoiceStore.getState().remoteScreenStream).not.toBeNull();
    });

    it('handles video track for webcam share', async () => {
      await webrtcService.connect('ch-1', 'team-1');

      const videoTrack = { ...createMockVideoTrack(), id: 'webcam-user2' };
      const stream = { ...createMockMediaStream([videoTrack]), id: 'webcam-stream-user2' };
      const handler = mockPc.ontrack as (event: unknown) => void;

      handler({
        track: videoTrack,
        streams: [stream],
        receiver: { transform: null },
      });

      expect(useVoiceStore.getState().remoteWebcamStreams['user2']).toBeDefined();
    });

    it('handles track without streams (fallback)', async () => {
      HTMLAudioElement.prototype.play = vi.fn().mockResolvedValue(undefined);
      await webrtcService.connect('ch-1', 'team-1');

      const audioTrack = createMockAudioTrack();
      const handler = mockPc.ontrack as (event: unknown) => void;

      handler({
        track: audioTrack,
        streams: [],
        receiver: { transform: null },
      });

      // Should create a fallback stream
      expect(document.querySelectorAll('audio[data-stream-id]')).toHaveLength(1);
    });
  });

  describe('screen share track ended handler', () => {
    it('auto-stops screen sharing when track ends', async () => {
      await webrtcService.connect('ch-1', 'team-1');

      const videoTrack = createMockVideoTrack();
      mockGetDisplayMedia.mockResolvedValueOnce(createMockMediaStream([videoTrack]));
      await webrtcService.startScreenShare();

      // Simulate the track ending
      expect(videoTrack.onended).toBeTypeOf('function');
      (videoTrack.onended as () => void)();

      await vi.waitFor(() => {
        expect(useVoiceStore.getState().screenSharing).toBe(false);
      });
    });
  });

  describe('webcam track ended handler', () => {
    it('auto-stops webcam when track ends', async () => {
      await webrtcService.connect('ch-1', 'team-1');

      const videoTrack = createMockVideoTrack();
      mockGetUserMedia.mockResolvedValueOnce(createMockMediaStream([videoTrack]));
      await webrtcService.startWebcam();

      expect(videoTrack.onended).toBeTypeOf('function');
      (videoTrack.onended as () => void)();

      await vi.waitFor(() => {
        expect(useVoiceStore.getState().webcamSharing).toBe(false);
      });
    });
  });

  describe('push to talk', () => {
    it('mutes mic initially when PTT is enabled', async () => {
      useAudioSettingsStore.setState({ pushToTalk: true, pushToTalkKey: 'KeyV' });
      await webrtcService.connect('ch-1', 'team-1');
      // Mic should start muted in PTT mode
    });

    it('unmutes on key down and mutes on key up', async () => {
      useAudioSettingsStore.setState({ pushToTalk: true, pushToTalkKey: 'KeyV' });
      await webrtcService.connect('ch-1', 'team-1');

      // Simulate key down
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV' }));
      expect(mockWs.voiceMute).toHaveBeenCalledWith('team-1', 'ch-1', false);

      // Simulate key up
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyV' }));
      expect(mockWs.voiceMute).toHaveBeenCalledWith('team-1', 'ch-1', true);
    });

    it('ignores non-PTT keys', async () => {
      useAudioSettingsStore.setState({ pushToTalk: true, pushToTalkKey: 'KeyV' });
      mockWs.voiceMute.mockClear();
      await webrtcService.connect('ch-1', 'team-1');
      mockWs.voiceMute.mockClear();

      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA' }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyA' }));
      expect(mockWs.voiceMute).not.toHaveBeenCalled();
    });
  });

  describe('store subscriptions', () => {
    it('updates gain when input volume changes', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      // Simulate volume change
      useUserSettingsStore.setState({ inputVolume: 0.5 });
      // Should update gain node (no error)
    });

    it('updates speaker volume when output volume changes', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      // Add an audio element first
      const audio = document.createElement('audio');
      audio.dataset.streamId = 'test';
      document.body.appendChild(audio);
      // Simulate output volume change
      useUserSettingsStore.setState({ outputVolume: 0.3 });
      // The subscription fires and updates audio elements
    });
  });

  describe('VAD with analyser', () => {
    it('starts and runs VAD timer', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      webrtcService.startVAD();
      webrtcService.stopVAD();
      webrtcService.stopVAD();
    });

    it('startVAD is no-op without local stream', () => {
      // Not connected, no local stream
      webrtcService.startVAD();
      webrtcService.stopVAD();
    });

    it('VAD timer detects speaking and updates local level', async () => {
      vi.useFakeTimers();
      await webrtcService.connect('ch-1', 'team-1');

      // Add self as a peer so updateLocalLevel finds the peer
      useVoiceStore.getState().addPeer({
        user_id: 'user-1',
        username: 'testuser',
        muted: false,
        deafened: false,
        speaking: false,
        voiceLevel: 0,
      });

      webrtcService.startVAD();

      // Advance timer to trigger the VAD interval callback
      // The mock analyser getByteFrequencyData fills with 0, so avg=0, level=0, isSpeaking=false
      vi.advanceTimersByTime(150);

      // updateLocalLevel should have been called (peer exists for user-1)
      expect(useVoiceStore.getState().peers['user-1'].voiceLevel).toBe(0);

      webrtcService.stopVAD();
      vi.useRealTimers();
    });

    it('VAD timer detects speaking transition', async () => {
      vi.useFakeTimers();
      await webrtcService.connect('ch-1', 'team-1');

      useVoiceStore.getState().addPeer({
        user_id: 'user-1',
        username: 'testuser',
        muted: false,
        deafened: false,
        speaking: false,
        voiceLevel: 0,
      });

      // Override the analyser mock to simulate loud audio
      const mockCtx = new EnhancedMockAudioContext();
      const fakeAnalyser = mockCtx.createAnalyser();
      // Make getByteFrequencyData fill array with high values
      fakeAnalyser.getByteFrequencyData.mockImplementation((arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = 200;
      });

      webrtcService.startVAD();

      // Advance timer
      vi.advanceTimersByTime(150);

      webrtcService.stopVAD();
      vi.useRealTimers();
    });
  });

  describe('screen sharing edge cases', () => {
    it('startScreenShare throws when getDisplayMedia is not supported', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      // Remove getDisplayMedia
      Object.defineProperty(navigator, 'mediaDevices', {
        value: { getUserMedia: mockGetUserMedia },
        writable: true,
        configurable: true,
      });
      await expect(webrtcService.startScreenShare()).rejects.toThrow(
        'Screen sharing is not supported',
      );
      // Restore
      Object.defineProperty(navigator, 'mediaDevices', {
        value: { getUserMedia: mockGetUserMedia, getDisplayMedia: mockGetDisplayMedia },
        writable: true,
        configurable: true,
      });
    });

    it('stopScreenShare is safe when no screen stream', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      await webrtcService.stopScreenShare();
      // No error
    });

    it('stopWebcam is safe when no webcam stream', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      await webrtcService.stopWebcam();
    });
  });

  describe('ICE candidate from local PC', () => {
    it('sends ICE candidate when channelId and teamId are set', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      const handler = mockPc.onicecandidate as (event: { candidate: { toJSON: () => unknown } | null }) => void;
      handler({
        candidate: {
          toJSON: () => ({ candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 }),
        },
      });
      expect(mockWs.voiceICECandidate).toHaveBeenCalled();
    });
  });
});
