import { describe, it, expect, beforeEach } from 'vitest';
import { useVoiceStore } from './voiceStore';
import type { VoicePeer } from '../services/api';

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
});

describe('peer CRUD', () => {
  it('setPeers converts array to record', () => {
    getState().setPeers([mockPeer, { ...mockPeer, user_id: 'u2', username: 'bob' }]);
    expect(Object.keys(getState().peers)).toHaveLength(2);
    expect(getState().peers['u1'].username).toBe('alice');
  });

  it('addPeer adds a peer', () => {
    getState().addPeer(mockPeer);
    expect(getState().peers['u1']).toEqual(mockPeer);
  });

  it('removePeer removes a peer', () => {
    getState().addPeer(mockPeer);
    getState().removePeer('u1');
    expect(getState().peers['u1']).toBeUndefined();
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
});

describe('voice occupants', () => {
  it('setVoiceOccupants sets all occupants', () => {
    getState().setVoiceOccupants({ 'ch-1': [mockPeer] });
    expect(getState().voiceOccupants['ch-1']).toHaveLength(1);
  });

  it('addVoiceOccupant appends with dedup', () => {
    getState().addVoiceOccupant('ch-1', mockPeer);
    getState().addVoiceOccupant('ch-1', mockPeer);
    expect(getState().voiceOccupants['ch-1']).toHaveLength(1);
  });

  it('removeVoiceOccupant removes and cleans up empty channel', () => {
    getState().addVoiceOccupant('ch-1', mockPeer);
    getState().removeVoiceOccupant('ch-1', 'u1');
    expect(getState().voiceOccupants['ch-1']).toBeUndefined();
  });

  it('updateVoiceOccupant patches a specific occupant', () => {
    getState().addVoiceOccupant('ch-1', mockPeer);
    getState().updateVoiceOccupant('ch-1', 'u1', { muted: true });
    expect(getState().voiceOccupants['ch-1'][0].muted).toBe(true);
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
});
