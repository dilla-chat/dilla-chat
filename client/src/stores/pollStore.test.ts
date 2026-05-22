import { describe, it, expect, beforeEach } from 'vitest';
import { usePollStore, normalizePoll, type PollState } from './pollStore';

function poll(overrides: Partial<PollState> = {}): PollState {
  return {
    id: 'p1',
    channelId: 'ch-1',
    question: '?',
    options: ['a', 'b'],
    tallies: [0, 0],
    voters: [[], []],
    createdBy: 'u1',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('usePollStore', () => {
  beforeEach(() => {
    usePollStore.getState().clear();
  });

  it('starts empty', () => {
    expect(usePollStore.getState().polls.size).toBe(0);
  });

  it('upsert inserts a new poll for the channel', () => {
    usePollStore.getState().upsert(poll());
    const list = usePollStore.getState().polls.get('ch-1') ?? [];
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('p1');
  });

  it('upsert replaces a poll with the same id', () => {
    usePollStore.getState().upsert(poll({ tallies: [0, 0] }));
    usePollStore.getState().upsert(poll({ tallies: [1, 2] }));
    const list = usePollStore.getState().polls.get('ch-1') ?? [];
    expect(list).toHaveLength(1);
    expect(list[0].tallies).toEqual([1, 2]);
  });

  it('upsert keeps polls in different channels separate', () => {
    usePollStore.getState().upsert(poll({ id: 'p1', channelId: 'ch-1' }));
    usePollStore.getState().upsert(poll({ id: 'p2', channelId: 'ch-2' }));
    expect(usePollStore.getState().polls.size).toBe(2);
  });

  it('remove drops a poll from the channel', () => {
    usePollStore.getState().upsert(poll());
    usePollStore.getState().remove('ch-1', 'p1');
    expect(usePollStore.getState().polls.get('ch-1')).toEqual([]);
  });

  it('remove is a no-op for an unknown id', () => {
    usePollStore.getState().upsert(poll());
    usePollStore.getState().remove('ch-1', 'never');
    expect(usePollStore.getState().polls.get('ch-1')).toHaveLength(1);
  });

  it('clear wipes the map', () => {
    usePollStore.getState().upsert(poll());
    usePollStore.getState().clear();
    expect(usePollStore.getState().polls.size).toBe(0);
  });
});

describe('normalizePoll', () => {
  it('maps snake_case wire fields to the store shape', () => {
    const out = normalizePoll({
      id: 'p1',
      channel_id: 'ch-1',
      question: 'lunch?',
      options: ['pizza', 'sushi'],
      tallies: [1, 2],
      voters: [['u1'], ['u2', 'u3']],
      created_by: 'u1',
      created_at: '2026-01-01T00:00:00Z',
    });
    expect(out).toEqual({
      id: 'p1',
      channelId: 'ch-1',
      question: 'lunch?',
      options: ['pizza', 'sushi'],
      tallies: [1, 2],
      voters: [['u1'], ['u2', 'u3']],
      createdBy: 'u1',
      createdAt: '2026-01-01T00:00:00Z',
    });
  });

  it('defaults missing optional fields', () => {
    const out = normalizePoll({
      id: 'p1',
      channel_id: 'ch-1',
      question: '?',
    });
    expect(out.options).toEqual([]);
    expect(out.tallies).toEqual([]);
    expect(out.voters).toEqual([]);
    expect(out.createdBy).toBeNull();
    expect(out.createdAt).toBe('');
  });
});
