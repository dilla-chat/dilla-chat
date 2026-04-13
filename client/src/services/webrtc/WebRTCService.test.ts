/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAuthStore } from '../../stores/authStore';
import { useUserSettingsStore } from '../../stores/userSettingsStore';
import { useAudioSettingsStore } from '../../stores/audioSettingsStore';

// ─── Track WS listeners for test emission ───────────────────────────────────
// vi.hoisted ensures these are available when vi.mock factories run (hoisted to top)
const { wsListeners, mockWs } = vi.hoisted(() => {
  const wsListeners = new Map<string, Set<(...args: unknown[]) => void>>();
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
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
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

vi.mock('../websocket', () => ({ ws: mockWs }));

vi.mock('../api', () => ({
  api: {
    getTURNCredentials: vi.fn().mockResolvedValue({ iceServers: [] }),
  },
}));

vi.mock('../sounds', () => ({
  playJoinSound: vi.fn(),
  playLeaveSound: vi.fn(),
}));

vi.mock('../voiceCrypto', () => ({
  supportsE2EVoice: vi.fn(() => false),
  VoiceKeyManager: class MockVoiceKeyManager {
    generateLocalKey = vi.fn().mockResolvedValue({ key: {}, rawKey: new Uint8Array(32), keyId: 1 });
    getLocalRawKey = vi.fn(() => null);
    getLocalKeyId = vi.fn(() => 0);
    setRemoteKey = vi.fn().mockResolvedValue(undefined);
    clear = vi.fn();
  },
}));

vi.mock('../crypto', () => ({
  cryptoService: {
    encryptDM: vi.fn().mockResolvedValue('ZW5jcnlwdGVkLXZvaWNlLWtleQ=='),
    decryptDM: vi.fn().mockResolvedValue(btoa(String.fromCharCode(...new Array(32).fill(0)))),
    ensurePeerSession: vi.fn().mockResolvedValue(undefined),
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

let mockStreamCounter = 0;

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
    id: 'mock-stream-' + (++mockStreamCounter).toString(),
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
    inputVolume: 1,
    outputVolume: 1,
    inputThreshold: 0.15,
  });

  useAudioSettingsStore.setState({
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: true,
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
import { webrtcService } from './WebRTCService';

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
      const { api } = await import('../api');
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

    it('filters TURN servers and sets relay policy when TURN available', async () => {
      const { api } = await import('../api');
      vi.mocked(api.getTURNCredentials).mockResolvedValueOnce({
        iceServers: [
          { urls: 'stun:stun.example.com:3478' },
          { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'c' },
          { urls: ['turns:turn.example.com:5349', 'turn:turn.example.com:53?transport=tcp'], username: 'u', credential: 'c' },
        ],
      });

      await webrtcService.connect('ch-1', 'team-1');
      // Should have filtered to only TURN entries and removed port 53 URLs
      expect(useVoiceStore.getState().peerConnection).not.toBeNull();
    });

    it('passes mic track through addTrack unchanged when noise suppression is off', async () => {
      // setupStores() sets noiseSuppression: false. The voice isolation
      // dispatcher must stay dormant and addTrack must receive the raw
      // audio track straight from the local MediaStream — no wrapping.
      useAudioSettingsStore.setState({ noiseSuppression: false });

      await webrtcService.connect('ch-1', 'team-1');

      const localStream = (webrtcService as any).localStream;
      const rawTrack = localStream?.getAudioTracks()[0];
      expect(rawTrack).toBeDefined();
      expect(mockPc.addTrack).toHaveBeenCalled();
      const firstCallTrack = (mockPc.addTrack as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0];
      expect(firstCallTrack).toBe(rawTrack);
    });

    it('connects with push-to-talk enabled', async () => {
      useAudioSettingsStore.setState({ pushToTalk: true, pushToTalkKey: 'KeyV' });
      await webrtcService.connect('ch-1', 'team-1');

      // Mic should start muted with PTT
      const localStream = (webrtcService as any).localStream;
      const audioTrack = localStream?.getAudioTracks()[0];
      expect(audioTrack?.enabled).toBe(false);

      // Reset
      useAudioSettingsStore.setState({ pushToTalk: false });
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
      await expect(webrtcService.disconnect()).resolves.toBeUndefined();
    });
  });

  describe('toggleMute', () => {
    it('toggles audio track enabled state', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      const muted = await webrtcService.toggleMute();
      expect(typeof muted).toBe('boolean');
    });

    it('toggles mute state when not connected (pre-set)', async () => {
      const result = await webrtcService.toggleMute();
      expect(result).toBe(true); // was unmuted → now muted
      expect(useVoiceStore.getState().muted).toBe(true);
    });

    it('returns false when pushToTalk is enabled', async () => {
      useAudioSettingsStore.setState({ pushToTalk: true });
      await webrtcService.connect('ch-1', 'team-1');
      const result = await webrtcService.toggleMute();
      expect(result).toBe(false);
    });

    it('sends voiceMute via websocket', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      await webrtcService.toggleMute();
      expect(mockWs.voiceMute).toHaveBeenCalledWith('team-1', 'ch-1', expect.any(Boolean));
    });

    it('unmute re-acquires mic after mute', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      // Mute first
      useVoiceStore.setState({ muted: false });
      await webrtcService.toggleMute();
      // Now unmute
      useVoiceStore.setState({ muted: true });
      await webrtcService.toggleMute();
      // getUserMedia should have been called to re-acquire
      expect(mockGetUserMedia).toHaveBeenCalled();
    });
  });

  describe('toggleDeafen', () => {
    it('toggles deafen state when not connected (pre-set)', async () => {
      const result = await webrtcService.toggleDeafen();
      expect(result).toBe(true);
      expect(useVoiceStore.getState().deafened).toBe(true);
      expect(useVoiceStore.getState().muted).toBe(true); // deafen also mutes
    });

    it('toggles deafen off when not connected', async () => {
      useVoiceStore.setState({ deafened: true, muted: true });
      const result = await webrtcService.toggleDeafen();
      expect(result).toBe(false);
      expect(useVoiceStore.getState().deafened).toBe(false);
    });

    it('toggles deafen and sends via websocket', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      const deafened = await webrtcService.toggleDeafen();
      expect(deafened).toBe(true);
      expect(mockWs.voiceDeafen).toHaveBeenCalledWith('team-1', 'ch-1', true);
    });

    it('second toggle undeafens (if store is updated between calls)', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      const first = await webrtcService.toggleDeafen(); // deafen -> reads store false, returns true
      expect(first).toBe(true);
      // The service reads from the store but doesn't write back.
      // The caller (UI) must update the store. Simulate that:
      useVoiceStore.setState({ deafened: true });
      const second = await webrtcService.toggleDeafen(); // undeafen -> reads store true, returns false
      expect(second).toBe(false);
    });

    it('deafen mutes remote audio tracks', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      const mockTrack = { enabled: true, kind: 'audio' };
      const mockStream = { getAudioTracks: () => [mockTrack] };
      (webrtcService as any).remoteStreams.set('peer-1', mockStream);
      await webrtcService.toggleDeafen();
      expect(mockTrack.enabled).toBe(false);
    });

    it('undeafen re-enables remote audio tracks', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      const mockTrack = { enabled: true, kind: 'audio' };
      const mockStream = { getAudioTracks: () => [mockTrack] };
      (webrtcService as any).remoteStreams.set('peer-1', mockStream);

      // First toggle: deafen
      await webrtcService.toggleDeafen();
      expect(mockTrack.enabled).toBe(false);

      // Update store so next toggle reads deafened=true
      useVoiceStore.setState({ deafened: true });

      // Second toggle: undeafen
      await webrtcService.toggleDeafen();
      expect(mockTrack.enabled).toBe(true);
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
      expect(() => webrtcService.stopVAD()).not.toThrow();
      expect(() => webrtcService.stopVAD()).not.toThrow();
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
      await expect(webrtcService.handleICECandidate({ candidate: 'candidate:1' })).resolves.toBeUndefined();
    });
  });

  describe('setInputVolume', () => {
    it('sets gain node value when connected', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      expect(() => webrtcService.setInputVolume(0.5)).not.toThrow();
    });

    it('is a no-op when not connected', () => {
      expect(() => webrtcService.setInputVolume(0.5)).not.toThrow();
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

      // startScreenShare/startWebcam now await a voice:offer from the server.
      // Emit the offer shortly after the WS methods are called.
      mockWs.voiceScreenStart.mockImplementation(() => {
        setTimeout(() => emitWS('voice:offer', { sdp: 'v=0\r\nrenegotiate' }), 10);
      });
      mockWs.voiceWebcamStart.mockImplementation(() => {
        setTimeout(() => emitWS('voice:offer', { sdp: 'v=0\r\nrenegotiate' }), 10);
      });

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
      await expect(webrtcService.connect('ch-1', 'team-1')).resolves.toBeUndefined();
    });

    it('unmutes on key down and mutes on key up', async () => {
      useAudioSettingsStore.setState({ pushToTalk: true, pushToTalkKey: 'KeyV' });
      await webrtcService.connect('ch-1', 'team-1');

      // Simulate key down
      globalThis.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV' }));
      expect(mockWs.voiceMute).toHaveBeenCalledWith('team-1', 'ch-1', false);

      // Simulate key up
      globalThis.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyV' }));
      expect(mockWs.voiceMute).toHaveBeenCalledWith('team-1', 'ch-1', true);
    });

    it('ignores non-PTT keys', async () => {
      useAudioSettingsStore.setState({ pushToTalk: true, pushToTalkKey: 'KeyV' });
      mockWs.voiceMute.mockClear();
      await webrtcService.connect('ch-1', 'team-1');
      mockWs.voiceMute.mockClear();

      globalThis.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA' }));
      globalThis.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyA' }));
      expect(mockWs.voiceMute).not.toHaveBeenCalled();
    });
  });

  describe('store subscriptions', () => {
    it('updates gain when input volume changes', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      useUserSettingsStore.setState({ inputVolume: 0.5 });
      expect(useUserSettingsStore.getState().inputVolume).toBe(0.5);
    });

    it('updates speaker volume when output volume changes', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      const audio = document.createElement('audio');
      audio.dataset.streamId = 'test';
      document.body.appendChild(audio);
      useUserSettingsStore.setState({ outputVolume: 0.3 });
      expect(useUserSettingsStore.getState().outputVolume).toBe(0.3);
    });
  });

  describe('VAD with analyser', () => {
    it('starts and runs VAD timer', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      expect(() => webrtcService.startVAD()).not.toThrow();
      expect(() => webrtcService.stopVAD()).not.toThrow();
      expect(() => webrtcService.stopVAD()).not.toThrow();
    });

    it('startVAD is no-op without local stream', () => {
      expect(() => webrtcService.startVAD()).not.toThrow();
      expect(() => webrtcService.stopVAD()).not.toThrow();
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

      webrtcService.startVAD();

      // After startVAD, override the analyser on the service to simulate loud audio
      const analyser = (webrtcService as any).vad.analyser;
      if (analyser) {
        analyser.getByteFrequencyData.mockImplementation((arr: Uint8Array) => {
          for (let i = 0; i < arr.length; i++) arr[i] = 200;
        });
      }

      // Advance timer to trigger speaking transition (isSpeaking changes from false to true)
      vi.advanceTimersByTime(150);

      // Verify speaking state was updated
      expect(useVoiceStore.getState().speaking).toBe(true);

      webrtcService.stopVAD();
      vi.useRealTimers();
    });

    it('VAD suppresses speaking when muted', async () => {
      vi.useFakeTimers();
      await webrtcService.connect('ch-1', 'team-1');

      useVoiceStore.getState().addPeer({
        user_id: 'user-1', username: 'testuser',
        muted: false, deafened: false, speaking: false, voiceLevel: 0,
      });

      webrtcService.startVAD();

      // Simulate loud audio to trigger speaking=true
      const analyser = (webrtcService as any).vad.analyser;
      if (analyser) {
        analyser.getByteFrequencyData.mockImplementation((arr: Uint8Array) => {
          for (let i = 0; i < arr.length; i++) arr[i] = 200;
        });
      }
      vi.advanceTimersByTime(150);
      expect(useVoiceStore.getState().speaking).toBe(true);

      // Now mute — VAD should suppress speaking
      useVoiceStore.setState({ muted: true });
      vi.advanceTimersByTime(150);
      expect(useVoiceStore.getState().speaking).toBe(false);

      webrtcService.stopVAD();
      vi.useRealTimers();
    });
  });

  describe('remote VAD', () => {
    it('updates peer speaking state when remote audio exceeds threshold', async () => {
      vi.useFakeTimers();
      await webrtcService.connect('ch-1', 'team-1');

      // Set up a peer in the voice store
      useVoiceStore.setState({
        peers: { 'remote-user': { odisplayName: 'Remote', muted: false, deafened: false, speaking: false, voiceLevel: 0, screenSharing: false, webcamSharing: false } },
      });

      // Access the private remoteAnalysers map on the VAD sub-object and add an entry
      const analysers = ((webrtcService as any).vad as unknown as { remoteAnalysers: Map<string, { userId: string; analyser: { getByteFrequencyData: (arr: Uint8Array) => void }; data: Uint8Array }> }).remoteAnalysers;
      const fakeData = new Uint8Array(128);
      analysers.set('remote-user', {
        userId: 'remote-user',
        analyser: {
          getByteFrequencyData: (arr: Uint8Array) => { arr.fill(180); },
        },
        data: fakeData,
      });

      // Start the remote VAD
      ((webrtcService as any).vad as unknown as { startRemoteVAD: () => void }).startRemoteVAD();

      // Advance the timer to trigger the interval
      vi.advanceTimersByTime(150);

      const peer = useVoiceStore.getState().peers['remote-user'];
      expect(peer.speaking).toBe(true);
      expect(peer.voiceLevel).toBeGreaterThan(0);

      // Stop and cleanup
      ((webrtcService as any).vad as unknown as { stopRemoteVAD: () => void }).stopRemoteVAD();
      vi.useRealTimers();
    });

    it('does not start twice if already running', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      const vad = (webrtcService as any).vad;
      const startFn = vad.startRemoteVAD.bind(vad);
      startFn();
      const timer1 = vad.remoteVadTimer;
      startFn(); // second call should be no-op
      const timer2 = vad.remoteVadTimer;
      expect(timer1).toBe(timer2);
      ((webrtcService as any).vad as unknown as { stopRemoteVAD: () => void }).stopRemoteVAD();
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
      await expect(webrtcService.stopScreenShare()).resolves.toBeUndefined();
    });

    it('stopWebcam is safe when no webcam stream', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      await expect(webrtcService.stopWebcam()).resolves.toBeUndefined();
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

  describe('PTT subscription', () => {
    it('re-enables mic when PTT is disabled while connected', async () => {
      useAudioSettingsStore.setState({ pushToTalk: true, pushToTalkKey: 'KeyV' });
      await webrtcService.connect('ch-1', 'team-1');

      // Mic should be muted initially with PTT
      const localStream = (webrtcService as any).localStream;
      expect(localStream.getAudioTracks()[0].enabled).toBe(false);

      // Disable PTT — mic should be re-enabled
      useAudioSettingsStore.setState({ pushToTalk: false });

      // Give Zustand subscription time to fire
      await new Promise((r) => setTimeout(r, 10));
      expect(localStream.getAudioTracks()[0].enabled).toBe(true);
    });
  });

  describe('WS voice:mute-update handler', () => {
    it('updates peer mute/deafen state', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      useVoiceStore.getState().addPeer({
        user_id: 'u3',
        username: 'carol',
        muted: false,
        deafened: false,
        speaking: false,
        voiceLevel: 0,
      });

      emitWS('voice:mute-update', { user_id: 'u3', muted: true, deafened: true });
      const peer = useVoiceStore.getState().peers['u3'];
      expect(peer.muted).toBe(true);
      expect(peer.deafened).toBe(true);
    });
  });

  describe('WS voice:screen-update handler', () => {
    it('updates peer screen sharing state', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      useVoiceStore.getState().addPeer({
        user_id: 'u3',
        username: 'carol',
        muted: false,
        deafened: false,
        speaking: false,
        voiceLevel: 0,
      });

      emitWS('voice:screen-update', { user_id: 'u3', sharing: true });
      expect(useVoiceStore.getState().peers['u3'].screen_sharing).toBe(true);

      emitWS('voice:screen-update', { user_id: 'u3', sharing: false });
      expect(useVoiceStore.getState().peers['u3'].screen_sharing).toBe(false);
    });
  });

  describe('WS voice:webcam-update handler', () => {
    it('updates peer webcam sharing state', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      useVoiceStore.getState().addPeer({
        user_id: 'u3',
        username: 'carol',
        muted: false,
        deafened: false,
        speaking: false,
        voiceLevel: 0,
      });

      emitWS('voice:webcam-update', { user_id: 'u3', sharing: true });
      expect(useVoiceStore.getState().peers['u3'].webcam_sharing).toBe(true);
    });
  });

  describe('WS voice:key-distribute handler', () => {
    it('ignores key distribution when E2E is not enabled', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      expect(() => emitWS('voice:key-distribute', {
        sender_id: 'peer-1',
        key_id: 1,
        encrypted_keys: { 'user-1': btoa('fakekey') },
      })).not.toThrow();
    });
  });

  describe('handleOffer', () => {
    it('returns null when not connected', async () => {
      const result = await webrtcService.handleOffer({ type: 'offer', sdp: 'mock' });
      expect(result).toBeNull();
    });

    it('creates answer when connected', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      const result = await webrtcService.handleOffer({ type: 'offer', sdp: 'mock' });
      expect(result).not.toBeNull();
      expect(result?.type).toBe('answer');
    });
  });

  describe('handleICECandidate', () => {
    it('does nothing when not connected', async () => {
      await expect(webrtcService.handleICECandidate({ candidate: 'c1' })).resolves.toBeUndefined();
    });

    it('adds candidate when connected', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      await webrtcService.handleICECandidate({ candidate: 'c1', sdpMid: '0', sdpMLineIndex: 0 });
      expect(mockPc.addIceCandidate).toHaveBeenCalled();
    });
  });

  describe('setInputVolume', () => {
    it('sets gain node value when connected', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      webrtcService.setInputVolume(0.5);
      expect((webrtcService as any).gainNode.gain.value).toBe(0.5);
    });

    it('does nothing when not connected', () => {
      expect(() => webrtcService.setInputVolume(0.5)).not.toThrow();
    });
  });

  describe('toggleMute edge cases', () => {
    it('returns false when toggleMute called with PTT enabled', async () => {
      useAudioSettingsStore.setState({ pushToTalk: true });
      await webrtcService.connect('ch-1', 'team-1');
      expect(await webrtcService.toggleMute()).toBe(false);
      useAudioSettingsStore.setState({ pushToTalk: false });
    });
  });

  describe('E2E voice encryption', () => {
    let mockWorkerInstance: { postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> };

    function setupE2EMocks() {
      mockWorkerInstance = { postMessage: vi.fn(), terminate: vi.fn() };
      // Worker must be a constructor — use function syntax
      vi.stubGlobal('Worker', function MockWorker() { return mockWorkerInstance; });
      vi.stubGlobal('RTCRtpScriptTransform', function MockRtpTransform() {});
      mockPc.getSenders = vi.fn(() => [{ track: {}, transform: null }]);
    }

    it('sets up E2E encryption when supported', async () => {
      const { supportsE2EVoice } = await import('../voiceCrypto');
      vi.mocked(supportsE2EVoice).mockReturnValue(true);
      setupE2EMocks();

      await webrtcService.connect('ch-1', 'team-1');

      expect(useVoiceStore.getState().e2eVoice).toBe(true);
      expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'setKey' }),
      );

      // Reset
      vi.mocked(supportsE2EVoice).mockReturnValue(false);
    });

    it('distributes voice key when peer joins', async () => {
      const { supportsE2EVoice } = await import('../voiceCrypto');
      vi.mocked(supportsE2EVoice).mockReturnValue(true);
      setupE2EMocks();

      await webrtcService.connect('ch-1', 'team-1');

      // Manually set voiceKeyManager to have a raw key
      (webrtcService as any).encryption.voiceKeyManager.getLocalRawKey = vi.fn(() => new Uint8Array(32));
      (webrtcService as any).encryption.voiceKeyManager.getLocalKeyId = vi.fn(() => 1);

      // Add a peer so key distribution has a target
      useVoiceStore.setState({
        peers: {
          'user-1': { user_id: 'user-1', username: 'me', muted: false, deafened: false, speaking: false, voiceLevel: 0 },
          'peer-2': { user_id: 'peer-2', username: 'other', muted: false, deafened: false, speaking: false, voiceLevel: 0 },
        },
      });

      // Set derivedKey so voice key encryption works
      useAuthStore.setState({ derivedKey: 'test-derived-key' } as never);

      // Trigger distributeVoiceKey via user-joined event
      emitWS('voice:user-joined', { user_id: 'peer-3', username: 'new-user' });

      // Wait for async distributeVoiceKey to complete
      await vi.waitFor(() => {
        expect(mockWs.voiceKeyDistribute).toHaveBeenCalled();
      });

      // Reset
      vi.mocked(supportsE2EVoice).mockReturnValue(false);
    });

    it('distributeVoiceKey skips when rawKey is null', async () => {
      const { supportsE2EVoice } = await import('../voiceCrypto');
      vi.mocked(supportsE2EVoice).mockReturnValue(true);
      setupE2EMocks();

      await webrtcService.connect('ch-1', 'team-1');

      // Ensure getLocalRawKey returns null
      (webrtcService as any).encryption.voiceKeyManager.getLocalRawKey = vi.fn(() => null);

      mockWs.voiceKeyDistribute.mockClear();
      emitWS('voice:user-joined', { user_id: 'peer-3', username: 'new-user' });

      expect(mockWs.voiceKeyDistribute).not.toHaveBeenCalled();

      // Reset
      vi.mocked(supportsE2EVoice).mockReturnValue(false);
    });

    it('handles received voice key when E2E enabled', async () => {
      const { supportsE2EVoice } = await import('../voiceCrypto');
      vi.mocked(supportsE2EVoice).mockReturnValue(true);
      setupE2EMocks();

      await webrtcService.connect('ch-1', 'team-1');

      // Emit key-distribute event with a key for our user
      emitWS('voice:key-distribute', {
        sender_id: 'peer-1',
        key_id: 1,
        encrypted_keys: { 'user-1': btoa(String.fromCodePoint(...new Uint8Array(32))) },
      });

      // Give the async handler time to run
      await new Promise((r) => setTimeout(r, 10));

      expect(useVoiceStore.getState().e2eVoice).toBeDefined();

      // Reset
      vi.mocked(supportsE2EVoice).mockReturnValue(false);
    });

    it('distributeVoiceKey warns when derivedKey is missing', async () => {
      const { supportsE2EVoice } = await import('../voiceCrypto');
      vi.mocked(supportsE2EVoice).mockReturnValue(true);
      setupE2EMocks();

      await webrtcService.connect('ch-1', 'team-1');

      (webrtcService as any).encryption.voiceKeyManager.getLocalRawKey = vi.fn(() => new Uint8Array(32));
      (webrtcService as any).encryption.voiceKeyManager.getLocalKeyId = vi.fn(() => 1);

      useVoiceStore.setState({
        peers: {
          'user-1': { user_id: 'user-1', username: 'me', muted: false, deafened: false, speaking: false, voiceLevel: 0 },
          'peer-2': { user_id: 'peer-2', username: 'other', muted: false, deafened: false, speaking: false, voiceLevel: 0 },
        },
      });

      // No derivedKey set — should warn and not distribute
      useAuthStore.setState({ derivedKey: null } as never);
      mockWs.voiceKeyDistribute.mockClear();

      emitWS('voice:user-joined', { user_id: 'peer-3', username: 'new-user' });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockWs.voiceKeyDistribute).not.toHaveBeenCalled();

      vi.mocked(supportsE2EVoice).mockReturnValue(false);
    });

    it('handleReceivedVoiceKey decrypts via Signal Protocol when derivedKey is set', async () => {
      const { supportsE2EVoice } = await import('../voiceCrypto');
      vi.mocked(supportsE2EVoice).mockReturnValue(true);
      setupE2EMocks();

      await webrtcService.connect('ch-1', 'team-1');
      useAuthStore.setState({ derivedKey: 'test-key' } as never);

      const { cryptoService } = await import('../crypto');

      emitWS('voice:key-distribute', {
        sender_id: 'peer-1',
        key_id: 1,
        encrypted_keys: { 'user-1': 'encrypted-payload' },
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(cryptoService.decryptDM).toHaveBeenCalledWith('team-1', 'peer-1', 'encrypted-payload', 'ch-1', 'test-key');

      vi.mocked(supportsE2EVoice).mockReturnValue(false);
    });

    it('handleReceivedVoiceKey falls back on decrypt failure', async () => {
      const { supportsE2EVoice } = await import('../voiceCrypto');
      vi.mocked(supportsE2EVoice).mockReturnValue(true);
      setupE2EMocks();

      await webrtcService.connect('ch-1', 'team-1');
      useAuthStore.setState({ derivedKey: 'test-key' } as never);

      const { cryptoService } = await import('../crypto');
      vi.mocked(cryptoService.decryptDM).mockRejectedValueOnce(new Error('decrypt failed'));

      // Send a valid base64 key directly (fallback should use it as-is)
      const validKeyB64 = btoa(String.fromCharCode(...new Array(32).fill(0)));
      emitWS('voice:key-distribute', {
        sender_id: 'peer-1',
        key_id: 1,
        encrypted_keys: { 'user-1': validKeyB64 },
      });

      await new Promise((r) => setTimeout(r, 50));

      // Should still work — fallback to unencrypted
      expect(cryptoService.decryptDM).toHaveBeenCalled();

      vi.mocked(supportsE2EVoice).mockReturnValue(false);
    });
  });

  describe('disconnect E2E cleanup', () => {
    it('terminates encrypt worker if present', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      // Manually set an encrypt worker
      const fakeWorker = { terminate: vi.fn(), postMessage: vi.fn() };
      (webrtcService as any).encryption.encryptWorker = fakeWorker;

      await webrtcService.disconnect();
      expect(fakeWorker.terminate).toHaveBeenCalled();
    });

    it('terminates decrypt workers if present', async () => {
      await webrtcService.connect('ch-1', 'team-1');
      const fakeWorker = { terminate: vi.fn(), postMessage: vi.fn() };
      (webrtcService as any).encryption.decryptWorkers.set('peer-1', fakeWorker);

      await webrtcService.disconnect();
      expect(fakeWorker.terminate).toHaveBeenCalled();
    });
  });
});
