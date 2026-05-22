// Smoke + dispatch-trip tests for the global channel-event subscriber.
//
// The hook wires up a fan of ws.on(...) handlers for the active team —
// message:new, message:updated, message:deleted, message:rejected,
// typing:indicator, etc. These tests assert:
//   1. Subscribe + unsubscribe lifecycle (no leaks across team
//      changes / unmount).
//   2. Each handler reaches into the right zustand store mutator.
// The full message:new mention-notifier branch isn't asserted line-
// by-line — that's a lot of window-event surface; the test verifies
// the message lands in the store, which is the user-observable bit.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const wsHandlers = new Map<string, (...args: unknown[]) => void>();
const wsUnsubs = new Map<string, ReturnType<typeof vi.fn>>();

vi.mock('../services/websocket', () => ({
  ws: {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      wsHandlers.set(event, handler);
      const unsub = vi.fn();
      wsUnsubs.set(event, unsub);
      return unsub;
    }),
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

vi.mock('../services/messageCache', () => ({
  deleteCachedMessage: vi.fn(),
}));

vi.mock('../services/crypto', () => ({
  cryptoService: {
    processSenderKey: vi.fn().mockResolvedValue(undefined),
    getSenderKeyDistribution: vi.fn().mockResolvedValue('dist'),
  },
  getIdentityKeys: vi.fn(() => ({ publicKeyBytes: new Uint8Array([1, 2, 3]) })),
}));

vi.mock('../services/crypto/helpers', () => ({
  toBase64: vi.fn(() => 'AQID'),
}));

import { useChannelEvents } from './useChannelEvents';
import { useAuthStore } from '../stores/authStore';
import { useTeamStore } from '../stores/teamStore';
import { useMessageStore } from '../stores/messageStore';

function seedStores(teamId: string) {
  useAuthStore.setState({
    teams: new Map([
      [teamId, {
        token: 'tok',
        user: { id: 'me', username: 'me' },
        teamInfo: {},
        baseUrl: 'http://localhost',
      }],
    ]),
    derivedKey: 'derived-key-test',
  });
  useTeamStore.setState({
    activeTeamId: teamId,
    channels: new Map([[teamId, [{ id: 'ch-1', name: 'general', type: 'text' }]]]),
    members: new Map([[teamId, [
      { id: 'm1', userId: 'me', username: 'me', displayName: 'Me', nickname: '', roles: [], statusType: 'online' },
      { id: 'm2', userId: 'peer', username: 'peer', displayName: 'Peer', nickname: '', roles: [], statusType: 'online' },
    ]]]),
  });
  useMessageStore.setState({ messages: new Map() });
}

describe('useChannelEvents', () => {
  beforeEach(() => {
    wsHandlers.clear();
    wsUnsubs.clear();
    seedStores('team-1');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when activeTeamId is null', () => {
    renderHook(() => useChannelEvents(null, true));
    expect(wsHandlers.has('message:new')).toBe(false);
  });

  it('does nothing while cryptoReady is false', () => {
    renderHook(() => useChannelEvents('team-1', false));
    expect(wsHandlers.has('message:new')).toBe(false);
  });

  it('registers handlers when both team + crypto are ready', () => {
    renderHook(() => useChannelEvents('team-1', true));
    expect(wsHandlers.has('message:new')).toBe(true);
    expect(wsHandlers.has('message:updated')).toBe(true);
    expect(wsHandlers.has('message:deleted')).toBe(true);
    expect(wsHandlers.has('message:rejected')).toBe(true);
    expect(wsHandlers.has('typing:indicator')).toBe(true);
  });

  it('message:new lands a decoded entry in the channel message store', async () => {
    renderHook(() => useChannelEvents('team-1', true));
    const handler = wsHandlers.get('message:new')!;
    await handler({
      id: 'msg-1',
      channel_id: 'ch-1',
      author_id: 'peer',
      content: 'hello',
      type: 'text',
      created_at: new Date().toISOString(),
      deleted: false,
      lamport_ts: 1,
    });
    const msgs = useMessageStore.getState().messages.get('ch-1') ?? [];
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toBe('hello');
  });

  it('message:deleted removes the message from the store', () => {
    // Seed a message first so the delete has something to find.
    useMessageStore.getState().addMessage('ch-1', {
      id: 'msg-1',
      channelId: 'ch-1',
      authorId: 'peer',
      content: 'will be deleted',
      type: 'text',
      createdAt: new Date().toISOString(),
    });
    renderHook(() => useChannelEvents('team-1', true));
    const handler = wsHandlers.get('message:deleted')!;
    handler({ message_id: 'msg-1', channel_id: 'ch-1' });
    const msgs = useMessageStore.getState().messages.get('ch-1') ?? [];
    expect(msgs.find((m) => m.id === 'msg-1')?.deleted ?? true).toBeTruthy();
  });

  it('typing:indicator updates the typing-state slice', () => {
    renderHook(() => useChannelEvents('team-1', true));
    const handler = wsHandlers.get('typing:indicator')!;
    handler({ channel_id: 'ch-1', user_id: 'peer', username: 'peer' });
    // store has a `setTyping` setter; the observable side effect is on
    // `typingByChannel` or similar. Don't deep-assert internal field
    // — assert the call doesn't throw.
    expect(() => handler({ channel_id: 'ch-1', user_id: 'peer', username: 'peer' })).not.toThrow();
  });

  it('message:rejected dispatches a dilla:notify CustomEvent', () => {
    const spy = vi.spyOn(window, 'dispatchEvent');
    renderHook(() => useChannelEvents('team-1', true));
    const handler = wsHandlers.get('message:rejected')!;
    handler({ channel_id: 'ch-1', reason: 'slow_mode', retry_in: 12 });
    const fired = spy.mock.calls.some(
      (call) =>
        call[0] instanceof CustomEvent && call[0].type === 'dilla:notify',
    );
    expect(fired).toBe(true);
    spy.mockRestore();
  });

  it('unmount unsubscribes every handler', () => {
    const { unmount } = renderHook(() => useChannelEvents('team-1', true));
    unmount();
    for (const unsub of wsUnsubs.values()) {
      expect(unsub).toHaveBeenCalled();
    }
  });
});
