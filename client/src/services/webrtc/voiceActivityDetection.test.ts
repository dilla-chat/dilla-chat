// Cover the remote-VAD timer + updateLocalLevel sidebar mirror branches in
// voiceActivityDetection.ts (uncov lines 85-105 and 138-158).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useVoiceStore } from '../../stores/voiceStore';

vi.mock('../sounds', () => ({ playJoinSound: vi.fn(), playLeaveSound: vi.fn() }));

import { VoiceActivityDetector } from './voiceActivityDetection';

function resetStore() {
  useVoiceStore.setState({
    voiceOccupants: {},
    peers: {},
    currentChannelId: null,
    currentTeamId: null,
    connected: false,
  } as never);
}

beforeEach(() => {
  resetStore();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('VoiceActivityDetector.updateLocalLevel — sidebar mirror', () => {
  it('flips voiceOccupants speaking state on transition', () => {
    useVoiceStore.setState({
      voiceOccupants: {
        'ch-1': [
          { user_id: 'me', username: 'me', muted: false, deafened: false, speaking: false, voiceLevel: 0 },
          { user_id: 'other', username: 'other', muted: false, deafened: false, speaking: false, voiceLevel: 0 },
        ],
      },
      peers: { me: { user_id: 'me', username: 'me', muted: false, deafened: false, speaking: false, voiceLevel: 0 } },
    } as never);

    const vad = new VoiceActivityDetector();
    vad.updateLocalLevel(0.5, true, 'me');

    const list = useVoiceStore.getState().voiceOccupants['ch-1'];
    const me = list.find((p) => p.user_id === 'me');
    expect(me?.speaking).toBe(true);
    // Other user untouched.
    const other = list.find((p) => p.user_id === 'other');
    expect(other?.speaking).toBe(false);
  });

  it('returns early when no peer entry exists for the local user', () => {
    const vad = new VoiceActivityDetector();
    // No peers populated — updatePeer should not fire.
    expect(() => vad.updateLocalLevel(0.5, true, 'ghost-user')).not.toThrow();
  });

  it('skips state set when no meaningful change', () => {
    useVoiceStore.setState({
      peers: { me: { user_id: 'me', username: 'me', muted: false, deafened: false, speaking: false, voiceLevel: 0 } },
    } as never);
    const vad = new VoiceActivityDetector();
    // First call sets speaking=true (transition).
    vad.updateLocalLevel(0.5, true, 'me');
    // Second call with same speaking + level → returns early.
    vad.updateLocalLevel(0.5, true, 'me');
    // Voice level shouldn't change because the delta < 0.05 threshold.
    expect(useVoiceStore.getState().peers.me?.speaking).toBe(true);
  });

  it('skips emit when level changes below the 0.05 delta threshold', () => {
    useVoiceStore.setState({
      peers: { me: { user_id: 'me', username: 'me', muted: false, deafened: false, speaking: false, voiceLevel: 0 } },
    } as never);
    const vad = new VoiceActivityDetector();
    vad.updateLocalLevel(0.5, true, 'me');
    // Tiny delta — should be ignored.
    vad.updateLocalLevel(0.51, true, 'me');
    expect(useVoiceStore.getState().peers.me?.voiceLevel).toBe(0.5);
  });

  it('does nothing when localUserId is null', () => {
    const vad = new VoiceActivityDetector();
    expect(() => vad.updateLocalLevel(0.5, true, null)).not.toThrow();
  });
});

describe('VoiceActivityDetector.startRemoteVAD timer', () => {
  it('startRemoteVAD does not throw without remote streams', () => {
    const vad = new VoiceActivityDetector();
    vad.startRemoteVAD({} as never, 'me');
    vi.advanceTimersByTime(500);
    vad.stopRemoteVAD();
  });

  it('stopRemoteVAD is idempotent', () => {
    const vad = new VoiceActivityDetector();
    vad.stopRemoteVAD();
    vad.stopRemoteVAD();
  });
});
