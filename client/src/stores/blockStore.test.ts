import { describe, it, expect, beforeEach } from 'vitest';
import { useBlockStore } from './blockStore';

describe('useBlockStore', () => {
  beforeEach(() => {
    useBlockStore.getState().clear();
  });

  it('starts empty', () => {
    expect(useBlockStore.getState().blocked.size).toBe(0);
  });

  it('setAll replaces the blocked set', () => {
    useBlockStore.getState().setAll(['u1', 'u2', 'u3']);
    const s = useBlockStore.getState();
    expect(s.blocked.size).toBe(3);
    expect(s.isBlocked('u2')).toBe(true);
    expect(s.isBlocked('u4')).toBe(false);
  });

  it('block adds an id idempotently', () => {
    useBlockStore.getState().block('u1');
    useBlockStore.getState().block('u1');
    expect(useBlockStore.getState().blocked.size).toBe(1);
    expect(useBlockStore.getState().isBlocked('u1')).toBe(true);
  });

  it('block preserves previously blocked users', () => {
    useBlockStore.getState().block('u1');
    useBlockStore.getState().block('u2');
    expect(useBlockStore.getState().blocked.size).toBe(2);
  });

  it('unblock removes the id', () => {
    useBlockStore.getState().block('u1');
    useBlockStore.getState().unblock('u1');
    expect(useBlockStore.getState().isBlocked('u1')).toBe(false);
  });

  it('unblock is a no-op for a missing id', () => {
    useBlockStore.getState().block('u1');
    useBlockStore.getState().unblock('u2');
    expect(useBlockStore.getState().blocked.size).toBe(1);
  });

  it('clear wipes the set', () => {
    useBlockStore.getState().setAll(['u1', 'u2', 'u3']);
    useBlockStore.getState().clear();
    expect(useBlockStore.getState().blocked.size).toBe(0);
  });
});
