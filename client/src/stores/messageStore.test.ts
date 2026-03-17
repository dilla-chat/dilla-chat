import { describe, it, expect, beforeEach } from 'vitest';
import { useMessageStore } from './messageStore';
import { createMockMessage } from '../test/helpers';

function getState() {
  return useMessageStore.getState();
}

beforeEach(() => {
  useMessageStore.setState({
    messages: new Map(),
    typing: new Map(),
    loadingHistory: new Map(),
    hasMore: new Map(),
  });
});

describe('addMessage', () => {
  it('appends a message to a channel', () => {
    const msg = createMockMessage({ channelId: 'ch-1' });
    getState().addMessage('ch-1', msg);
    expect(getState().messages.get('ch-1')).toHaveLength(1);
    expect(getState().messages.get('ch-1')![0].id).toBe(msg.id);
  });

  it('deduplicates by id', () => {
    const msg = createMockMessage({ id: 'dup', channelId: 'ch-1' });
    getState().addMessage('ch-1', msg);
    getState().addMessage('ch-1', msg);
    expect(getState().messages.get('ch-1')).toHaveLength(1);
  });
});

describe('prependMessages', () => {
  it('prepends messages', () => {
    const existing = createMockMessage({ id: 'existing', channelId: 'ch-1' });
    getState().addMessage('ch-1', existing);

    const older = [
      createMockMessage({ id: 'old-1', channelId: 'ch-1' }),
      createMockMessage({ id: 'old-2', channelId: 'ch-1' }),
    ];
    getState().prependMessages('ch-1', older);

    const msgs = getState().messages.get('ch-1')!;
    expect(msgs).toHaveLength(3);
    expect(msgs[0].id).toBe('old-1');
    expect(msgs[2].id).toBe('existing');
  });

  it('filters duplicates via Set', () => {
    const msg = createMockMessage({ id: 'x', channelId: 'ch-1' });
    getState().addMessage('ch-1', msg);
    getState().prependMessages('ch-1', [msg]);
    expect(getState().messages.get('ch-1')).toHaveLength(1);
  });
});

describe('updateMessage', () => {
  it('updates content and sets editedAt', () => {
    const msg = createMockMessage({ id: 'm1', channelId: 'ch-1' });
    getState().addMessage('ch-1', msg);
    getState().updateMessage('ch-1', 'm1', 'updated content');

    const updated = getState().messages.get('ch-1')![0];
    expect(updated.content).toBe('updated content');
    expect(updated.editedAt).toBeTruthy();
  });
});

describe('deleteMessage', () => {
  it('marks deleted=true and clears content', () => {
    const msg = createMockMessage({ id: 'm1', channelId: 'ch-1', content: 'hello' });
    getState().addMessage('ch-1', msg);
    getState().deleteMessage('ch-1', 'm1');

    const deleted = getState().messages.get('ch-1')![0];
    expect(deleted.deleted).toBe(true);
    expect(deleted.content).toBe('');
  });
});

describe('updateReactions', () => {
  it('replaces reactions array', () => {
    const msg = createMockMessage({ id: 'm1', channelId: 'ch-1', reactions: [] });
    getState().addMessage('ch-1', msg);

    const newReactions = [{ emoji: '🎉', users: ['u1'], count: 1 }];
    getState().updateReactions('ch-1', 'm1', newReactions);

    expect(getState().messages.get('ch-1')![0].reactions).toEqual(newReactions);
  });
});

describe('typing', () => {
  it('setTyping upserts a typing user', () => {
    getState().setTyping('ch-1', { userId: 'u1', username: 'alice', timestamp: Date.now() });
    expect(getState().typing.get('ch-1')).toHaveLength(1);

    // Update same user
    getState().setTyping('ch-1', { userId: 'u1', username: 'alice', timestamp: Date.now() + 1 });
    expect(getState().typing.get('ch-1')).toHaveLength(1);
  });

  it('clearTyping removes a user', () => {
    getState().setTyping('ch-1', { userId: 'u1', username: 'alice', timestamp: Date.now() });
    getState().clearTyping('ch-1', 'u1');
    expect(getState().typing.get('ch-1')).toHaveLength(0);
  });
});

describe('flags', () => {
  it('setLoadingHistory sets per-channel flag', () => {
    getState().setLoadingHistory('ch-1', true);
    expect(getState().loadingHistory.get('ch-1')).toBe(true);
  });

  it('setHasMore sets per-channel flag', () => {
    getState().setHasMore('ch-1', false);
    expect(getState().hasMore.get('ch-1')).toBe(false);
  });
});

describe('clearChannel', () => {
  it('removes all data for a channel', () => {
    const msg = createMockMessage({ channelId: 'ch-1' });
    getState().addMessage('ch-1', msg);
    getState().setTyping('ch-1', { userId: 'u1', username: 'a', timestamp: Date.now() });
    getState().setLoadingHistory('ch-1', true);
    getState().setHasMore('ch-1', true);

    getState().clearChannel('ch-1');

    expect(getState().messages.get('ch-1')).toBeUndefined();
    expect(getState().typing.get('ch-1')).toBeUndefined();
    expect(getState().loadingHistory.get('ch-1')).toBeUndefined();
    expect(getState().hasMore.get('ch-1')).toBeUndefined();
  });
});
