import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useVoiceStore } from '../stores/voiceStore';
import { useVoiceConnection } from './useVoiceConnection';

describe('useVoiceConnection', () => {
  it('returns connection state from store', () => {
    useVoiceStore.setState({
      connected: true,
      connecting: false,
      currentChannelId: 'vc1',
      currentTeamId: 't1',
      muted: true,
      deafened: false,
      speaking: false,
      peers: {
        u1: { user_id: 'u1', username: 'alice', muted: false, deafened: false, speaking: false, voiceLevel: 0 },
        u2: { user_id: 'u2', username: 'bob', muted: true, deafened: false, speaking: false, voiceLevel: 0 },
      },
    });

    const { result } = renderHook(() => useVoiceConnection());

    expect(result.current.connected).toBe(true);
    expect(result.current.currentChannelId).toBe('vc1');
    expect(result.current.muted).toBe(true);
    expect(result.current.peerList).toHaveLength(2);
    expect(result.current.peerCount).toBe(2);
  });

  it('peerList is an array of peers', () => {
    useVoiceStore.setState({
      peers: {
        u1: { user_id: 'u1', username: 'alice', muted: false, deafened: false, speaking: false, voiceLevel: 0 },
      },
    });

    const { result } = renderHook(() => useVoiceConnection());
    expect(Array.isArray(result.current.peerList)).toBe(true);
    expect(result.current.peerList[0].username).toBe('alice');
  });

  it('returns empty peer list when disconnected', () => {
    useVoiceStore.setState({ connected: false, peers: {} });
    const { result } = renderHook(() => useVoiceConnection());
    expect(result.current.peerList).toHaveLength(0);
    expect(result.current.peerCount).toBe(0);
  });
});
