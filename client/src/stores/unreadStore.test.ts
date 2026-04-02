import { describe, it, expect, beforeEach } from 'vitest';
import { useUnreadStore } from './unreadStore';

function getState() {
  return useUnreadStore.getState();
}

beforeEach(() => {
  useUnreadStore.setState({ counts: {} });
});

describe('setCounts', () => {
  it('replaces the entire counts map', () => {
    getState().setCounts({ 'ch-1': 3, 'ch-2': 7 });
    expect(getState().counts).toEqual({ 'ch-1': 3, 'ch-2': 7 });
  });

  it('overwrites previously set counts', () => {
    getState().setCounts({ 'ch-1': 5 });
    getState().setCounts({ 'ch-2': 2 });
    expect(getState().counts).toEqual({ 'ch-2': 2 });
    expect(getState().counts['ch-1']).toBeUndefined();
  });
});

describe('increment', () => {
  it('increments from zero for a new channel', () => {
    getState().increment('ch-1');
    expect(getState().counts['ch-1']).toBe(1);
  });

  it('increments an existing non-zero count', () => {
    getState().setCounts({ 'ch-1': 4 });
    getState().increment('ch-1');
    expect(getState().counts['ch-1']).toBe(5);
  });

  it('increments from zero even when channel key is absent', () => {
    // counts is empty, channel was never mentioned
    getState().increment('ch-brand-new');
    expect(getState().counts['ch-brand-new']).toBe(1);
  });

  it('increments an already-zero channel to 1', () => {
    getState().setCounts({ 'ch-1': 0 });
    getState().increment('ch-1');
    expect(getState().counts['ch-1']).toBe(1);
  });
});

describe('markRead', () => {
  it('sets an existing count to 0', () => {
    getState().setCounts({ 'ch-1': 12 });
    getState().markRead('ch-1');
    expect(getState().counts['ch-1']).toBe(0);
  });

  it('sets count to 0 for a channel not yet tracked', () => {
    getState().markRead('ch-unknown');
    expect(getState().counts['ch-unknown']).toBe(0);
  });

  it('does not affect other channels', () => {
    getState().setCounts({ 'ch-1': 3, 'ch-2': 5 });
    getState().markRead('ch-1');
    expect(getState().counts['ch-1']).toBe(0);
    expect(getState().counts['ch-2']).toBe(5);
  });
});
