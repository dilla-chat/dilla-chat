import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useVoiceStore } from './voiceStore';
import type { VoicePeer } from '../services/api';

// Mock webrtc and sounds (used by joinChannel/leaveChannel)
vi.mock('../services/webrtc', () => ({
  webrtcService: {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../services/sounds', () => ({
  playJoinSound: vi.fn(),
  playLeaveSound: vi.fn(),
}));

function getState() {
  return useVoiceStore.getState();
}

beforeEach(() => {
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
});

const mockPeer: VoicePeer = {
  user_id: 'u1',
  username: 'alice',
  muted: false,
  deafened: false,
  speaking: false,
  voiceLevel: 0,
};

describe('toggleMute / toggleDeafen', () => {
  it('toggleMute flips muted state', () => {
    expect(getState().muted).toBe(false);
    getState().toggleMute();
    expect(getState().muted).toBe(true);
    getState().toggleMute();
    expect(getState().muted).toBe(false);
  });

  it('toggleDeafen enables deafen and auto-mutes', () => {
    getState().toggleDeafen();
    expect(getState().deafened).toBe(true);
    expect(getState().muted).toBe(true);
  });

  it('toggleDeafen off keeps existing mute state', () => {
    // Mute first, then deafen, then undeafen — mute should stay
    getState().toggleMute(); // muted = true
    getState().toggleDeafen(); // deafened = true, muted = true
    getState().toggleDeafen(); // deafened = false, muted stays true
    expect(getState().deafened).toBe(false);
    expect(getState().muted).toBe(true);
  });

  it('toggleMute while disconnected works (UI-only state)', () => {
    getState().toggleMute();
    expect(getState().muted).toBe(true);
  });

  it('toggleDeafen while disconnected works (UI-only state)', () => {
    getState().toggleDeafen();
    expect(getState().deafened).toBe(true);
    expect(getState().muted).toBe(true);
  });

  it('toggleDeafen off when not previously muted keeps muted as-is', () => {
    // Not muted, deafen then undeafen
    getState().toggleDeafen(); // deafened=true, muted=true
    getState().toggleDeafen(); // deafened=false, muted stays true (per implementation)
    expect(getState().deafened).toBe(false);
    expect(getState().muted).toBe(true);
  });
});

describe('peer CRUD', () => {
  it('setPeers converts array to record', () => {
    getState().setPeers([mockPeer, { ...mockPeer, user_id: 'u2', username: 'bob' }]);
    expect(Object.keys(getState().peers)).toHaveLength(2);
    expect(getState().peers['u1'].username).toBe('alice');
  });

  it('setPeers defaults voiceLevel to 0', () => {
    getState().setPeers([
      { user_id: 'u1', username: 'alice', muted: false, deafened: false, speaking: false } as VoicePeer,
    ]);
    expect(getState().peers['u1'].voiceLevel).toBe(0);
  });

  it('setPeers with empty array clears peers', () => {
    getState().addPeer(mockPeer);
    getState().setPeers([]);
    expect(Object.keys(getState().peers)).toHaveLength(0);
  });

  it('addPeer adds a peer', () => {
    getState().addPeer(mockPeer);
    expect(getState().peers['u1']).toEqual(mockPeer);
  });

  it('addPeer overwrites existing peer with same id', () => {
    getState().addPeer(mockPeer);
    getState().addPeer({ ...mockPeer, muted: true });
    expect(getState().peers['u1'].muted).toBe(true);
  });

  it('removePeer removes a peer', () => {
    getState().addPeer(mockPeer);
    getState().removePeer('u1');
    expect(getState().peers['u1']).toBeUndefined();
  });

  it('removePeer on non-existent peer is safe', () => {
    getState().removePeer('nonexistent');
    expect(Object.keys(getState().peers)).toHaveLength(0);
  });

  it('updatePeer merges updates', () => {
    getState().addPeer(mockPeer);
    getState().updatePeer('u1', { speaking: true, voiceLevel: 0.8 });
    expect(getState().peers['u1'].speaking).toBe(true);
    expect(getState().peers['u1'].voiceLevel).toBe(0.8);
  });

  it('updatePeer ignores non-existent peer', () => {
    getState().updatePeer('nonexistent', { speaking: true });
    expect(getState().peers['nonexistent']).toBeUndefined();
  });

  it('updatePeer preserves other fields', () => {
    getState().addPeer(mockPeer);
    getState().updatePeer('u1', { muted: true });
    expect(getState().peers['u1'].username).toBe('alice');
    expect(getState().peers['u1'].speaking).toBe(false);
    expect(getState().peers['u1'].muted).toBe(true);
  });
});

describe('voice occupants', () => {
  it('setVoiceOccupants sets all occupants', () => {
    getState().setVoiceOccupants({ 'ch-1': [mockPeer] });
    expect(getState().voiceOccupants['ch-1']).toHaveLength(1);
  });

  it('setVoiceOccupants for multiple channels', () => {
    const peer2: VoicePeer = { ...mockPeer, user_id: 'u2', username: 'bob' };
    getState().setVoiceOccupants({
      'ch-1': [mockPeer],
      'ch-2': [peer2],
    });
    expect(getState().voiceOccupants['ch-1']).toHaveLength(1);
    expect(getState().voiceOccupants['ch-2']).toHaveLength(1);
    expect(getState().voiceOccupants['ch-2'][0].username).toBe('bob');
  });

  it('setVoiceOccupants replaces existing occupants', () => {
    getState().setVoiceOccupants({ 'ch-1': [mockPeer] });
    getState().setVoiceOccupants({ 'ch-2': [mockPeer] });
    expect(getState().voiceOccupants['ch-1']).toBeUndefined();
    expect(getState().voiceOccupants['ch-2']).toHaveLength(1);
  });

  it('addVoiceOccupant appends with dedup', () => {
    getState().addVoiceOccupant('ch-1', mockPeer);
    getState().addVoiceOccupant('ch-1', mockPeer);
    expect(getState().voiceOccupants['ch-1']).toHaveLength(1);
  });

  it('addVoiceOccupant to new channel', () => {
    getState().addVoiceOccupant('ch-new', mockPeer);
    expect(getState().voiceOccupants['ch-new']).toHaveLength(1);
  });

  it('addVoiceOccupant different users to same channel', () => {
    const peer2: VoicePeer = { ...mockPeer, user_id: 'u2', username: 'bob' };
    getState().addVoiceOccupant('ch-1', mockPeer);
    getState().addVoiceOccupant('ch-1', peer2);
    expect(getState().voiceOccupants['ch-1']).toHaveLength(2);
  });

  it('removeVoiceOccupant removes and cleans up empty channel', () => {
    getState().addVoiceOccupant('ch-1', mockPeer);
    getState().removeVoiceOccupant('ch-1', 'u1');
    expect(getState().voiceOccupants['ch-1']).toBeUndefined();
  });

  it('removeVoiceOccupant keeps other occupants', () => {
    const peer2: VoicePeer = { ...mockPeer, user_id: 'u2', username: 'bob' };
    getState().addVoiceOccupant('ch-1', mockPeer);
    getState().addVoiceOccupant('ch-1', peer2);
    getState().removeVoiceOccupant('ch-1', 'u1');
    expect(getState().voiceOccupants['ch-1']).toHaveLength(1);
    expect(getState().voiceOccupants['ch-1'][0].user_id).toBe('u2');
  });

  it('removeVoiceOccupant from non-existent channel is safe', () => {
    getState().removeVoiceOccupant('nonexistent', 'u1');
    expect(getState().voiceOccupants['nonexistent']).toBeUndefined();
  });

  it('updateVoiceOccupant patches a specific occupant', () => {
    getState().addVoiceOccupant('ch-1', mockPeer);
    getState().updateVoiceOccupant('ch-1', 'u1', { muted: true });
    expect(getState().voiceOccupants['ch-1'][0].muted).toBe(true);
  });

  it('updateVoiceOccupant on non-existent channel is safe', () => {
    getState().updateVoiceOccupant('nonexistent', 'u1', { muted: true });
    expect(getState().voiceOccupants['nonexistent']).toBeUndefined();
  });

  it('updateVoiceOccupant does not affect other occupants', () => {
    const peer2: VoicePeer = { ...mockPeer, user_id: 'u2', username: 'bob' };
    getState().addVoiceOccupant('ch-1', mockPeer);
    getState().addVoiceOccupant('ch-1', peer2);
    getState().updateVoiceOccupant('ch-1', 'u1', { speaking: true });
    expect(getState().voiceOccupants['ch-1'][0].speaking).toBe(true);
    expect(getState().voiceOccupants['ch-1'][1].speaking).toBe(false);
  });
});

describe('simple setters', () => {
  it('setSpeaking', () => {
    getState().setSpeaking(true);
    expect(getState().speaking).toBe(true);
    getState().setSpeaking(false);
    expect(getState().speaking).toBe(false);
  });

  it('setScreenSharing', () => {
    getState().setScreenSharing(true);
    expect(getState().screenSharing).toBe(true);
  });

  it('setScreenSharingUserId', () => {
    getState().setScreenSharingUserId('user-1');
    expect(getState().screenSharingUserId).toBe('user-1');
    getState().setScreenSharingUserId(null);
    expect(getState().screenSharingUserId).toBeNull();
  });

  it('setRemoteScreenStream', () => {
    const stream = new MediaStream();
    getState().setRemoteScreenStream(stream);
    expect(getState().remoteScreenStream).toBe(stream);
    getState().setRemoteScreenStream(null);
    expect(getState().remoteScreenStream).toBeNull();
  });

  it('setLocalScreenStream', () => {
    const stream = new MediaStream();
    getState().setLocalScreenStream(stream);
    expect(getState().localScreenStream).toBe(stream);
  });

  it('setWebcamSharing', () => {
    getState().setWebcamSharing(true);
    expect(getState().webcamSharing).toBe(true);
  });

  it('setLocalWebcamStream', () => {
    const stream = new MediaStream();
    getState().setLocalWebcamStream(stream);
    expect(getState().localWebcamStream).toBe(stream);
    getState().setLocalWebcamStream(null);
    expect(getState().localWebcamStream).toBeNull();
  });

  it('setRemoteWebcamStream adds and removes', () => {
    const stream = new MediaStream();
    getState().setRemoteWebcamStream('user-1', stream);
    expect(getState().remoteWebcamStreams['user-1']).toBe(stream);

    getState().setRemoteWebcamStream('user-1', null);
    expect(getState().remoteWebcamStreams['user-1']).toBeUndefined();
  });

  it('setRemoteWebcamStream handles multiple users', () => {
    const stream1 = new MediaStream();
    const stream2 = new MediaStream();
    getState().setRemoteWebcamStream('user-1', stream1);
    getState().setRemoteWebcamStream('user-2', stream2);
    expect(Object.keys(getState().remoteWebcamStreams)).toHaveLength(2);
  });

  it('setE2eVoice', () => {
    getState().setE2eVoice(true);
    expect(getState().e2eVoice).toBe(true);
    getState().setE2eVoice(false);
    expect(getState().e2eVoice).toBe(false);
  });

  it('setConnecting', () => {
    getState().setConnecting(true);
    expect(getState().connecting).toBe(true);
  });

  it('setConnected with channel and team', () => {
    getState().setConnected(true, 'ch-1', 'team-1');
    expect(getState().connected).toBe(true);
    expect(getState().connecting).toBe(false);
    expect(getState().currentChannelId).toBe('ch-1');
    expect(getState().currentTeamId).toBe('team-1');
  });

  it('setConnected without channel and team', () => {
    useVoiceStore.setState({ currentChannelId: 'ch-1', currentTeamId: 'team-1' });
    getState().setConnected(false);
    expect(getState().connected).toBe(false);
    // Channel/team should remain unchanged
    expect(getState().currentChannelId).toBe('ch-1');
  });

  it('setPeerConnection', () => {
    const pc = { close: vi.fn() } as unknown as RTCPeerConnection;
    getState().setPeerConnection(pc);
    expect(getState().peerConnection).toBe(pc);
    getState().setPeerConnection(null);
    expect(getState().peerConnection).toBeNull();
  });

  it('setLocalStream', () => {
    const stream = new MediaStream();
    getState().setLocalStream(stream);
    expect(getState().localStream).toBe(stream);
    getState().setLocalStream(null);
    expect(getState().localStream).toBeNull();
  });
});

describe('leaveChannel', () => {
  it('resets all state when connected', () => {
    useVoiceStore.setState({
      connected: true,
      currentChannelId: 'ch-1',
      currentTeamId: 'team-1',
      muted: true,
      deafened: true,
      screenSharing: true,
    });

    getState().leaveChannel();

    expect(getState().connected).toBe(false);
    expect(getState().currentChannelId).toBeNull();
    expect(getState().muted).toBe(false);
    expect(getState().deafened).toBe(false);
    expect(getState().screenSharing).toBe(false);
  });

  it('is a no-op when not connected and not connecting', () => {
    const before = { ...getState() };
    getState().leaveChannel();
    expect(getState().connected).toBe(before.connected);
  });

  it('works when connecting but not yet connected', () => {
    useVoiceStore.setState({ connecting: true });
    getState().leaveChannel();
    expect(getState().connecting).toBe(false);
  });
});

describe('cleanup', () => {
  it('resets all state', () => {
    getState().addPeer(mockPeer);
    useVoiceStore.setState({ connected: true, currentChannelId: 'ch-1' });
    getState().cleanup();

    expect(getState().connected).toBe(false);
    expect(getState().currentChannelId).toBeNull();
    expect(Object.keys(getState().peers)).toHaveLength(0);
  });

  it('stops local stream tracks', () => {
    const track = { stop: vi.fn(), kind: 'audio', enabled: true };
    const stream = new MediaStream();
    vi.mocked(stream.getTracks).mockReturnValue([track as unknown as MediaStreamTrack]);
    useVoiceStore.setState({ localStream: stream });

    getState().cleanup();
    expect(track.stop).toHaveBeenCalled();
  });

  it('closes peer connection', () => {
    const pc = { close: vi.fn() } as unknown as RTCPeerConnection;
    useVoiceStore.setState({ peerConnection: pc });

    getState().cleanup();
    expect(pc.close).toHaveBeenCalled();
  });

  it('resets screen sharing state', () => {
    useVoiceStore.setState({
      screenSharing: true,
      screenSharingUserId: 'u1',
      webcamSharing: true,
    });
    getState().cleanup();
    expect(getState().screenSharing).toBe(false);
    expect(getState().screenSharingUserId).toBeNull();
    expect(getState().webcamSharing).toBe(false);
  });

  it('resets e2eVoice is not affected by cleanup (not in reset set)', () => {
    useVoiceStore.setState({ e2eVoice: true });
    getState().cleanup();
    // e2eVoice is not reset by cleanup (check implementation)
    // The cleanup doesn't explicitly reset e2eVoice
    expect(getState().e2eVoice).toBe(true);
  });
});

describe('joinChannel', () => {
  it('does nothing when already connecting', async () => {
    useVoiceStore.setState({ connecting: true });
    await getState().joinChannel('team-1', 'ch-1');
    expect(getState().connected).toBe(false);
  });

  it('does nothing when already connected to same channel', async () => {
    useVoiceStore.setState({ connected: true, currentChannelId: 'ch-1' });
    const { webrtcService } = await import('../services/webrtc');
    vi.mocked(webrtcService.connect).mockClear();
    await getState().joinChannel('team-1', 'ch-1');
    expect(webrtcService.connect).not.toHaveBeenCalled();
  });

  it('connects to a new channel', async () => {
    const { webrtcService } = await import('../services/webrtc');
    vi.mocked(webrtcService.connect).mockClear();
    await getState().joinChannel('team-1', 'ch-1');
    expect(webrtcService.connect).toHaveBeenCalledWith('ch-1', 'team-1');
    expect(getState().connected).toBe(true);
    expect(getState().currentChannelId).toBe('ch-1');
    expect(getState().currentTeamId).toBe('team-1');
  });

  it('disconnects from current channel before joining new one', async () => {
    const { webrtcService } = await import('../services/webrtc');
    vi.mocked(webrtcService.disconnect).mockClear();
    vi.mocked(webrtcService.connect).mockClear();
    useVoiceStore.setState({ connected: true, currentChannelId: 'ch-old', currentTeamId: 'team-1' });
    await getState().joinChannel('team-1', 'ch-new');
    expect(webrtcService.disconnect).toHaveBeenCalled();
    expect(webrtcService.connect).toHaveBeenCalledWith('ch-new', 'team-1');
  });

  it('handles connect failure gracefully', async () => {
    const { webrtcService } = await import('../services/webrtc');
    vi.mocked(webrtcService.connect).mockRejectedValueOnce(new Error('Mic denied'));
    await getState().joinChannel('team-1', 'ch-1');
    expect(getState().connected).toBe(false);
    expect(getState().connecting).toBe(false);
  });

  it('adds self as peer when auth entry has user.id', async () => {
    const { useAuthStore } = await import('./authStore');
    useAuthStore.setState({
      teams: new Map([
        ['team-1', { token: 'tok', user: { id: 'self-user', username: 'MySelf' }, teamInfo: {}, baseUrl: 'http://localhost' }],
      ]),
    });

    const { webrtcService } = await import('../services/webrtc');
    vi.mocked(webrtcService.connect).mockClear();
    await getState().joinChannel('team-1', 'ch-1');

    expect(getState().connected).toBe(true);
    expect(getState().peers['self-user']).toBeDefined();
    expect(getState().peers['self-user'].username).toBe('MySelf');
  });

  it('falls back when auth entry has no user.id', async () => {
    const { useAuthStore } = await import('./authStore');
    useAuthStore.setState({
      teams: new Map([
        ['team-1', { token: 'tok', user: {}, teamInfo: {}, baseUrl: 'http://localhost' }],
      ]),
    });

    const { webrtcService } = await import('../services/webrtc');
    vi.mocked(webrtcService.connect).mockClear();
    await getState().joinChannel('team-1', 'ch-1');

    expect(getState().connected).toBe(true);
    // No self peer added since user.id is missing
    expect(Object.keys(getState().peers)).toHaveLength(0);
  });
});

describe('setRemoteWebcamStream', () => {
  it('does not affect other users when removing', () => {
    const stream1 = new MediaStream();
    const stream2 = new MediaStream();
    getState().setRemoteWebcamStream('u1', stream1);
    getState().setRemoteWebcamStream('u2', stream2);
    getState().setRemoteWebcamStream('u1', null);
    expect(getState().remoteWebcamStreams['u1']).toBeUndefined();
    expect(getState().remoteWebcamStreams['u2']).toBe(stream2);
  });
});
