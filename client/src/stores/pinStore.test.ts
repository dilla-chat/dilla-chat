import { describe, it, expect, beforeEach } from 'vitest';
import { usePinStore } from './pinStore';

describe('usePinStore', () => {
  beforeEach(() => {
    usePinStore.getState().clear();
  });

  it('starts empty', () => {
    expect(usePinStore.getState().pinned.size).toBe(0);
    expect(usePinStore.getState().isPinned('ch-1', 'm1')).toBe(false);
  });

  it('setAll seeds the map grouped by channel', () => {
    usePinStore.getState().setAll([
      { channel_id: 'ch-1', message_id: 'm1' },
      { channel_id: 'ch-1', message_id: 'm2' },
      { channel_id: 'ch-2', message_id: 'm3' },
    ]);
    const s = usePinStore.getState();
    expect(s.pinned.size).toBe(2);
    expect(s.isPinned('ch-1', 'm1')).toBe(true);
    expect(s.isPinned('ch-1', 'm2')).toBe(true);
    expect(s.isPinned('ch-2', 'm3')).toBe(true);
    expect(s.isPinned('ch-2', 'm1')).toBe(false);
  });

  it('setAll replaces a channel\'s pin set (not merges)', () => {
    usePinStore.getState().setAll([
      { channel_id: 'ch-1', message_id: 'm1' },
      { channel_id: 'ch-1', message_id: 'm2' },
    ]);
    // Re-seed with a single message for ch-1.
    usePinStore.getState().setAll([
      { channel_id: 'ch-1', message_id: 'm3' },
    ]);
    const s = usePinStore.getState();
    expect(s.isPinned('ch-1', 'm1')).toBe(false);
    expect(s.isPinned('ch-1', 'm3')).toBe(true);
  });

  it('setAll skips malformed entries', () => {
    usePinStore.getState().setAll([
      // @ts-expect-error testing the no-channel_id branch
      { message_id: 'm1' },
      // @ts-expect-error testing the no-message_id branch
      { channel_id: 'ch-1' },
      { channel_id: 'ch-1', message_id: 'm2' },
    ]);
    expect(usePinStore.getState().isPinned('ch-1', 'm2')).toBe(true);
  });

  it('pin adds an id idempotently', () => {
    usePinStore.getState().pin('ch-1', 'm1');
    usePinStore.getState().pin('ch-1', 'm1');
    expect(usePinStore.getState().forChannel('ch-1').length).toBe(1);
  });

  it('unpin removes the id', () => {
    usePinStore.getState().pin('ch-1', 'm1');
    usePinStore.getState().unpin('ch-1', 'm1');
    expect(usePinStore.getState().isPinned('ch-1', 'm1')).toBe(false);
  });

  it('unpin of a missing id is a no-op', () => {
    usePinStore.getState().pin('ch-1', 'm1');
    usePinStore.getState().unpin('ch-1', 'm2');
    expect(usePinStore.getState().isPinned('ch-1', 'm1')).toBe(true);
  });

  it('forChannel returns the pinned ids for a channel (empty for unknown)', () => {
    usePinStore.getState().pin('ch-1', 'm1');
    usePinStore.getState().pin('ch-1', 'm2');
    expect(usePinStore.getState().forChannel('ch-1').sort()).toEqual(['m1', 'm2']);
    expect(usePinStore.getState().forChannel('ch-other')).toEqual([]);
  });

  it('clear wipes the entire map', () => {
    usePinStore.getState().pin('ch-1', 'm1');
    usePinStore.getState().pin('ch-2', 'm2');
    usePinStore.getState().clear();
    expect(usePinStore.getState().pinned.size).toBe(0);
  });
});
