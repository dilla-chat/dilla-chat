import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useChannelMuteStore } from './channelMuteStore';

describe('useChannelMuteStore', () => {
  beforeEach(() => {
    useChannelMuteStore.setState({ muted: new Map() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with no muted channels', () => {
    expect(useChannelMuteStore.getState().muted.size).toBe(0);
    expect(useChannelMuteStore.getState().isMuted('ch-1')).toBe(false);
  });

  it('setAll seeds the map from a sync:init-style payload', () => {
    useChannelMuteStore.getState().setAll([
      { channel_id: 'ch-1', muted_until: null },
      { channel_id: 'ch-2', muted_until: '2050-01-01T00:00:00Z' },
    ]);
    const s = useChannelMuteStore.getState();
    expect(s.muted.size).toBe(2);
    expect(s.isMuted('ch-1')).toBe(true); // null = indefinite
    expect(s.isMuted('ch-2')).toBe(true); // expires far in the future
  });

  it('setMuted with null = indefinite mute', () => {
    useChannelMuteStore.getState().setMuted('ch-1', null);
    expect(useChannelMuteStore.getState().isMuted('ch-1')).toBe(true);
  });

  it('setMuted with a future ISO is muted', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    useChannelMuteStore.getState().setMuted('ch-1', future);
    expect(useChannelMuteStore.getState().isMuted('ch-1')).toBe(true);
  });

  it('setMuted with a past ISO is NOT muted (expired)', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    useChannelMuteStore.getState().setMuted('ch-1', past);
    expect(useChannelMuteStore.getState().isMuted('ch-1')).toBe(false);
  });

  it('clear removes a channel from the mute map', () => {
    useChannelMuteStore.getState().setMuted('ch-1', null);
    useChannelMuteStore.getState().clear('ch-1');
    expect(useChannelMuteStore.getState().isMuted('ch-1')).toBe(false);
  });

  it('clear is a no-op for an untracked channel', () => {
    useChannelMuteStore.getState().setMuted('ch-1', null);
    useChannelMuteStore.getState().clear('ch-other');
    expect(useChannelMuteStore.getState().isMuted('ch-1')).toBe(true);
  });
});
