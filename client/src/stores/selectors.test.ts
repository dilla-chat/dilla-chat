import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useMessageStore } from './messageStore';
import { useVoiceStore } from './voiceStore';
import { useTeamStore } from './teamStore';
import { useThreadStore } from './threadStore';
import { useDMStore } from './dmStore';
import { usePresenceStore } from './presenceStore';
import {
  useChannelMessages,
  useChannelLoading,
  useChannelHasMore,
  useChannelTyping,
  useVoiceConnectionState,
  useVoiceMediaState,
  useVoicePeers,
  useVoiceChannelOccupants,
  useChannelThreads,
  useThreadMessages,
  useTeamChannels,
  useTeamMembers,
  useTeamDMs,
  useDMTyping,
  useUserPresence,
} from './selectors';

describe('Store selectors', () => {
  beforeEach(() => {
    useMessageStore.setState({
      messages: new Map([['ch1', [{ id: 'm1', channelId: 'ch1', authorId: 'u1', username: 'alice', content: 'hi', encryptedContent: '', type: 'text', threadId: null, editedAt: null, deleted: false, createdAt: '2024-01-01', reactions: [] }]]]),
      loadingHistory: new Map([['ch1', true]]),
      hasMore: new Map([['ch1', false]]),
      typing: new Map([['ch1', [{ userId: 'u2', username: 'bob', timestamp: Date.now() }]]]),
    });
  });

  it('useChannelMessages returns messages for channel', () => {
    const { result } = renderHook(() => useChannelMessages('ch1'));
    expect(result.current).toHaveLength(1);
    expect(result.current[0].content).toBe('hi');
  });

  it('useChannelMessages returns empty for unknown channel', () => {
    const { result } = renderHook(() => useChannelMessages('unknown'));
    expect(result.current).toHaveLength(0);
  });

  it('useChannelLoading returns loading state', () => {
    const { result } = renderHook(() => useChannelLoading('ch1'));
    expect(result.current).toBe(true);
  });

  it('useChannelHasMore returns hasMore state', () => {
    const { result } = renderHook(() => useChannelHasMore('ch1'));
    expect(result.current).toBe(false);
  });

  it('useChannelTyping returns typing users', () => {
    const { result } = renderHook(() => useChannelTyping('ch1'));
    expect(result.current).toHaveLength(1);
    expect(result.current[0].username).toBe('bob');
  });

  it('useVoiceConnectionState returns connection slice', () => {
    useVoiceStore.setState({ connected: true, connecting: false, currentChannelId: 'vc1', currentTeamId: 't1' });
    const { result } = renderHook(() => useVoiceConnectionState());
    expect(result.current.connected).toBe(true);
    expect(result.current.currentChannelId).toBe('vc1');
  });

  it('useVoiceMediaState returns media slice', () => {
    useVoiceStore.setState({ muted: true, deafened: false, screenSharing: true });
    const { result } = renderHook(() => useVoiceMediaState());
    expect(result.current.muted).toBe(true);
    expect(result.current.screenSharing).toBe(true);
  });

  it('useVoicePeers returns peers', () => {
    useVoiceStore.setState({ peers: { u1: { user_id: 'u1', username: 'alice', muted: false, deafened: false, speaking: false, voiceLevel: 0 } } });
    const { result } = renderHook(() => useVoicePeers());
    expect(result.current).toHaveProperty('u1');
  });

  it('useVoiceChannelOccupants returns occupants for channel', () => {
    useVoiceStore.setState({ voiceOccupants: { vc1: [{ user_id: 'u1', username: 'alice', muted: false, deafened: false, speaking: false, voiceLevel: 0 }] } });
    const { result } = renderHook(() => useVoiceChannelOccupants('vc1'));
    expect(result.current).toHaveLength(1);
  });

  it('useVoiceChannelOccupants returns empty for unknown channel', () => {
    const { result } = renderHook(() => useVoiceChannelOccupants('unknown'));
    expect(result.current).toHaveLength(0);
  });

  it('useChannelThreads returns threads for channel', () => {
    useThreadStore.setState({ threads: { ch1: [{ id: 't1', channel_id: 'ch1', parent_message_id: 'm1', team_id: 'team1', title: 'Thread', message_count: 3, last_message_at: null, created_at: '2024-01-01' }] } });
    const { result } = renderHook(() => useChannelThreads('ch1'));
    expect(result.current).toHaveLength(1);
  });

  it('useTeamChannels returns channels for team', () => {
    useTeamStore.setState({ channels: new Map([['t1', [{ id: 'ch1', teamId: 't1', name: 'general', topic: '', type: 'text', position: 0, category: '' }]]]) });
    const { result } = renderHook(() => useTeamChannels('t1'));
    expect(result.current).toHaveLength(1);
    expect(result.current[0].name).toBe('general');
  });

  it('useTeamMembers returns members for team', () => {
    useTeamStore.setState({ members: new Map([['t1', [{ id: 'm1', teamId: 't1', userId: 'u1', username: 'alice', displayName: 'Alice', nickname: '', joinedAt: '' }]]]) });
    const { result } = renderHook(() => useTeamMembers('t1'));
    expect(result.current).toHaveLength(1);
  });

  it('useTeamDMs returns DM channels for team', () => {
    useDMStore.setState({ dmChannels: { t1: [{ id: 'dm1', type: 'dm' }] } } as never);
    const { result } = renderHook(() => useTeamDMs('t1'));
    expect(result.current).toHaveLength(1);
  });

  it('useDMTyping returns typing users for DM', () => {
    useDMStore.setState({ dmTyping: { dm1: [{ userId: 'u1', username: 'alice', timestamp: Date.now() }] } } as never);
    const { result } = renderHook(() => useDMTyping('dm1'));
    expect(result.current).toHaveLength(1);
  });

  it('useUserPresence returns presence for user', () => {
    usePresenceStore.setState({ presences: { t1: { u1: { status: 'online' } } } } as never);
    const { result } = renderHook(() => useUserPresence('t1', 'u1'));
    expect(result.current).toEqual({ status: 'online' });
  });

  it('useUserPresence returns undefined for unknown user', () => {
    usePresenceStore.setState({ presences: {} } as never);
    const { result } = renderHook(() => useUserPresence('t1', 'u1'));
    expect(result.current).toBeUndefined();
  });

  it('useThreadMessages returns messages for thread', () => {
    useThreadStore.setState({ threadMessages: { t1: [{ id: 'm1', content: 'reply' }] } } as never);
    const { result } = renderHook(() => useThreadMessages('t1'));
    expect(result.current).toHaveLength(1);
  });
});
