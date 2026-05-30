// Drive the WS handlers in useChannelEvents.ts that aren't already
// exercised: message:updated, channel:key-distribute (process + echo +
// dedupe + skip-self), reaction:added, reaction:removed, and the
// mention-notifier branches of message:new.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const h = vi.hoisted(() => ({
  wsHandlers: new Map<string, (...args: unknown[]) => void>(),
  distributeChannelKey: vi.fn(),
  processSenderKey: vi.fn().mockResolvedValue(undefined),
  getSenderKeyDistribution: vi.fn().mockResolvedValue('fresh-dist'),
}));

vi.mock('../services/websocket', () => ({
  ws: {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      h.wsHandlers.set(event, handler);
      return vi.fn();
    }),
    distributeChannelKey: h.distributeChannelKey,
  },
}));

vi.mock('./useMessageDecryption', () => ({
  tryDecrypt: vi.fn(async (_id, content) => content),
  forgetDecryptFailure: vi.fn(),
  serverToMessage: vi.fn((m: { id: string; channel_id: string; author_id: string; content: string }, content: string) => ({
    id: m.id,
    channelId: m.channel_id,
    authorId: m.author_id,
    content,
    type: 'text',
    createdAt: new Date().toISOString(),
  })),
}));

vi.mock('../services/messageCache', () => ({ deleteCachedMessage: vi.fn() }));

vi.mock('../services/crypto', () => ({
  cryptoService: { processSenderKey: h.processSenderKey, getSenderKeyDistribution: h.getSenderKeyDistribution },
  getIdentityKeys: vi.fn(() => ({ publicKeyBytes: new Uint8Array([1, 2, 3]) })),
}));

vi.mock('../services/crypto/helpers', () => ({ toBase64: vi.fn(() => 'OWN-ID') }));

import { useChannelEvents } from './useChannelEvents';
import { useAuthStore } from '../stores/authStore';
import { useTeamStore } from '../stores/teamStore';
import { useMessageStore } from '../stores/messageStore';
import { useChannelMuteStore } from '../stores/channelMuteStore';

function seedStores(teamId = 't1') {
  useAuthStore.setState({
    teams: new Map([
      [teamId, { token: 'tok', user: { id: 'me', username: 'me' }, teamInfo: {}, baseUrl: 'http://localhost' }],
    ]),
    derivedKey: 'dk-test',
  } as never);
  useTeamStore.setState({
    activeTeamId: teamId,
    channels: new Map([[teamId, [{ id: 'ch-1', name: 'general', type: 'text', teamId }]]]),
    members: new Map([[teamId, [
      { id: 'm1', userId: 'me', username: 'me', displayName: 'Me', nickname: '', roleIds: [], roles: [], statusType: 'online', isAdmin: false, publicKeyHex: '', avatarUrl: '' },
      { id: 'm2', userId: 'u2', username: 'alice', displayName: 'Alice', nickname: '', roleIds: [], roles: [], statusType: 'online', isAdmin: false, publicKeyHex: '', avatarUrl: '' },
    ]]]),
  } as never);
  useMessageStore.setState({
    messages: new Map([['ch-1', [
      { id: 'm1', channelId: 'ch-1', authorId: 'u2', content: 'hi', type: 'text', createdAt: new Date().toISOString(), reactions: [] as never[] },
    ]]]),
    typing: new Map(), hasMore: new Map(), loadingHistory: new Map(),
  } as never);
  useChannelMuteStore.setState({ muted: new Map() } as never);
  (window as { SHELL_DATA?: unknown }).SHELL_DATA = {
    currentUserId: 'me',
    byId: { me: { name: 'me', username: 'me' }, u2: { name: 'alice', username: 'alice' } },
  };
}

beforeEach(() => {
  h.wsHandlers.clear();
  h.distributeChannelKey.mockClear();
  h.processSenderKey.mockClear();
  h.getSenderKeyDistribution.mockClear();
  seedStores();
});

describe('message:updated', () => {
  it('decrypts + patches the message in store', async () => {
    renderHook(() => useChannelEvents('t1', true));
    const fn = h.wsHandlers.get('message:updated');
    expect(h).toBeDefined();
    await fn?.({ message_id: 'm1', channel_id: 'ch-1', content: 'edited content', author_id: 'u2' });
    const list = useMessageStore.getState().messages.get('ch-1') ?? [];
    const m = list.find((mm) => mm.id === 'm1');
    expect(m?.content).toBe('edited content');
  });
});

describe('channel:key-distribute', () => {
  it('processes and echoes a peer distribute', async () => {
    renderHook(() => useChannelEvents('t1', true));
    const fn = h.wsHandlers.get('channel:key-distribute');
    await fn?.({ channel_id: 'ch-1', sender_id: 'peer-id', distribution: '{"k":"v"}' });
    expect(h.processSenderKey).toHaveBeenCalled();
    expect(h.getSenderKeyDistribution).toHaveBeenCalled();
    expect(h.distributeChannelKey).toHaveBeenCalled();
  });

  it('skips echo when sender_id is our own id', async () => {
    renderHook(() => useChannelEvents('t1', true));
    const fn = h.wsHandlers.get('channel:key-distribute');
    await fn?.({ channel_id: 'ch-1', sender_id: 'OWN-ID', distribution: '{"k":"self"}' });
    expect(h.processSenderKey).toHaveBeenCalled();
    expect(h.distributeChannelKey).not.toHaveBeenCalled();
  });

  it('dedupes exact-duplicate distributes', async () => {
    renderHook(() => useChannelEvents('t1', true));
    const fn = h.wsHandlers.get('channel:key-distribute');
    await fn?.({ channel_id: 'ch-1', sender_id: 'peer-id', distribution: '{"k":"dup"}' });
    h.processSenderKey.mockClear();
    await fn?.({ channel_id: 'ch-1', sender_id: 'peer-id', distribution: '{"k":"dup"}' });
    expect(h.processSenderKey).not.toHaveBeenCalled();
  });

  it('returns early when derivedKey is missing', async () => {
    useAuthStore.setState({ derivedKey: null } as never);
    renderHook(() => useChannelEvents('t1', true));
    const fn = h.wsHandlers.get('channel:key-distribute');
    await fn?.({ channel_id: 'ch-1', sender_id: 'peer-id', distribution: '{}' });
    expect(h.processSenderKey).not.toHaveBeenCalled();
  });
});

describe('reaction:added / reaction:removed', () => {
  it('adds a reaction to a message', () => {
    renderHook(() => useChannelEvents('t1', true));
    const fn = h.wsHandlers.get('reaction:added');
    fn?.({ message_id: 'm1', channel_id: 'ch-1', user_id: 'me', emoji: '👍' });
    const msg = useMessageStore.getState().messages.get('ch-1')?.find((m) => m.id === 'm1');
    expect(msg?.reactions?.find((r) => r.emoji === '👍')?.count).toBe(1);
  });

  it('appends user to existing reaction', () => {
    useMessageStore.setState({
      messages: new Map([['ch-1', [
        { id: 'm1', channelId: 'ch-1', authorId: 'u2', content: 'x', type: 'text', createdAt: new Date().toISOString(),
          reactions: [{ emoji: '👍', users: ['u2'], count: 1 }] },
      ]]]),
      typing: new Map(), hasMore: new Map(), loadingHistory: new Map(),
    } as never);
    renderHook(() => useChannelEvents('t1', true));
    const fn = h.wsHandlers.get('reaction:added');
    fn?.({ message_id: 'm1', channel_id: 'ch-1', user_id: 'me', emoji: '👍' });
    const msg = useMessageStore.getState().messages.get('ch-1')?.find((m) => m.id === 'm1');
    expect(msg?.reactions?.find((r) => r.emoji === '👍')?.count).toBe(2);
  });

  it('reaction:added is idempotent for the same user', () => {
    useMessageStore.setState({
      messages: new Map([['ch-1', [
        { id: 'm1', channelId: 'ch-1', authorId: 'u2', content: 'x', type: 'text', createdAt: new Date().toISOString(),
          reactions: [{ emoji: '👍', users: ['me'], count: 1 }] },
      ]]]),
      typing: new Map(), hasMore: new Map(), loadingHistory: new Map(),
    } as never);
    renderHook(() => useChannelEvents('t1', true));
    const fn = h.wsHandlers.get('reaction:added');
    fn?.({ message_id: 'm1', channel_id: 'ch-1', user_id: 'me', emoji: '👍' });
    const msg = useMessageStore.getState().messages.get('ch-1')?.find((m) => m.id === 'm1');
    expect(msg?.reactions?.find((r) => r.emoji === '👍')?.count).toBe(1);
  });

  it('removes a reaction from a message', () => {
    useMessageStore.setState({
      messages: new Map([['ch-1', [
        { id: 'm1', channelId: 'ch-1', authorId: 'u2', content: 'x', type: 'text', createdAt: new Date().toISOString(),
          reactions: [{ emoji: '👍', users: ['me', 'u2'], count: 2 }] },
      ]]]),
      typing: new Map(), hasMore: new Map(), loadingHistory: new Map(),
    } as never);
    renderHook(() => useChannelEvents('t1', true));
    const fn = h.wsHandlers.get('reaction:removed');
    fn?.({ message_id: 'm1', channel_id: 'ch-1', user_id: 'me', emoji: '👍' });
    const msg = useMessageStore.getState().messages.get('ch-1')?.find((m) => m.id === 'm1');
    expect(msg?.reactions?.find((r) => r.emoji === '👍')?.count).toBe(1);
  });

  it('reaction:removed drops the entry when count reaches 0', () => {
    useMessageStore.setState({
      messages: new Map([['ch-1', [
        { id: 'm1', channelId: 'ch-1', authorId: 'u2', content: 'x', type: 'text', createdAt: new Date().toISOString(),
          reactions: [{ emoji: '👍', users: ['me'], count: 1 }] },
      ]]]),
      typing: new Map(), hasMore: new Map(), loadingHistory: new Map(),
    } as never);
    renderHook(() => useChannelEvents('t1', true));
    const fn = h.wsHandlers.get('reaction:removed');
    fn?.({ message_id: 'm1', channel_id: 'ch-1', user_id: 'me', emoji: '👍' });
    const msg = useMessageStore.getState().messages.get('ch-1')?.find((m) => m.id === 'm1');
    expect(msg?.reactions?.find((r) => r.emoji === '👍')).toBeUndefined();
  });

  it('reaction:added is a no-op when message not found', () => {
    renderHook(() => useChannelEvents('t1', true));
    const fn = h.wsHandlers.get('reaction:added');
    expect(() => fn?.({ message_id: 'm-missing', channel_id: 'ch-1', user_id: 'me', emoji: '👍' })).not.toThrow();
  });
});

describe('mention notifier', () => {
  it('fires dilla:notify for @me direct mention', async () => {
    const listener = vi.fn();
    window.addEventListener('dilla:notify', listener);
    renderHook(() => useChannelEvents('t1', true));
    const fn = h.wsHandlers.get('message:new');
    await fn?.({
      id: 'm-mention',
      channel_id: 'ch-1',
      author_id: 'u2',
      content: 'hey @me check this',
      type: 'text',
    });
    // Allow async tryDecrypt + handler chain to complete
    await new Promise((r) => setTimeout(r, 5));
    expect(listener).toHaveBeenCalled();
    window.removeEventListener('dilla:notify', listener);
  });

  it('fires dilla:notify for @everyone when channel is not muted', async () => {
    const listener = vi.fn();
    window.addEventListener('dilla:notify', listener);
    renderHook(() => useChannelEvents('t1', true));
    const fn = h.wsHandlers.get('message:new');
    await fn?.({
      id: 'm-bc',
      channel_id: 'ch-1',
      author_id: 'u2',
      content: 'hi @everyone',
      type: 'text',
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(listener).toHaveBeenCalled();
    window.removeEventListener('dilla:notify', listener);
  });

  it('suppresses @everyone notify when channel is muted', async () => {
    useChannelMuteStore.setState({ muted: new Map([['ch-1', null]]) } as never);
    const listener = vi.fn();
    window.addEventListener('dilla:notify', listener);
    renderHook(() => useChannelEvents('t1', true));
    const fn = h.wsHandlers.get('message:new');
    await fn?.({
      id: 'm-bc',
      channel_id: 'ch-1',
      author_id: 'u2',
      content: 'hi @everyone',
      type: 'text',
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener('dilla:notify', listener);
  });

  it('does not fire when author is current user', async () => {
    const listener = vi.fn();
    window.addEventListener('dilla:notify', listener);
    renderHook(() => useChannelEvents('t1', true));
    const fn = h.wsHandlers.get('message:new');
    await fn?.({
      id: 'm-self',
      channel_id: 'ch-1',
      author_id: 'me',
      content: '@me self mention',
      type: 'text',
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener('dilla:notify', listener);
  });
});
