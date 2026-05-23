// Coverage for the global thread-event subscriber. Same pattern as
// useChannelEvents / useDMEvents — capture ws.on handlers via the mock
// factory, drive each from the test, assert observable store changes.

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
  serverToMessage: vi.fn(
    (m: { id: string; channel_id: string; author_id: string; content: string }, content: string) => ({
      id: m.id,
      channelId: m.channel_id,
      authorId: m.author_id,
      content,
      type: 'text',
      createdAt: new Date().toISOString(),
    }),
  ),
}));

vi.mock('../services/messageCache', () => ({
  deleteCachedMessage: vi.fn(),
}));

import { useThreadEvents } from './useThreadEvents';
import { useAuthStore } from '../stores/authStore';
import { useTeamStore } from '../stores/teamStore';
import { useThreadStore } from '../stores/threadStore';

describe('useThreadEvents', () => {
  beforeEach(() => {
    wsHandlers.clear();
    wsUnsubs.clear();
    useAuthStore.setState({
      teams: new Map([
        ['t1', { token: 'tok', user: { id: 'u1' }, teamInfo: {}, baseUrl: 'http://localhost' }],
      ]),
      derivedKey: 'key',
    });
    useTeamStore.setState({
      activeTeamId: 't1',
      members: new Map([['t1', []]]),
      channels: new Map([['t1', []]]),
    });
    useThreadStore.setState({ threads: {}, threadMessages: {} });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when activeTeamId is null', () => {
    renderHook(() => useThreadEvents(null));
    expect(wsHandlers.has('thread:created')).toBe(false);
  });

  it('registers thread:* handlers when team is set', () => {
    renderHook(() => useThreadEvents('t1'));
    expect(wsHandlers.has('thread:created')).toBe(true);
    expect(wsHandlers.has('thread:updated')).toBe(true);
    expect(wsHandlers.has('thread:message:new')).toBe(true);
    expect(wsHandlers.has('thread:message:updated')).toBe(true);
    expect(wsHandlers.has('thread:message:deleted')).toBe(true);
  });

  it('thread:created adds the thread to useThreadStore', () => {
    renderHook(() => useThreadEvents('t1'));
    wsHandlers.get('thread:created')!({
      id: 'th-1',
      channel_id: 'ch-1',
      parent_message_id: 'm-parent',
      team_id: 't1',
      creator_id: 'u1',
      title: 'discussion',
      message_count: 0,
      last_message_at: null,
      created_at: new Date().toISOString(),
    });
    const threads = useThreadStore.getState().threads['ch-1'] ?? [];
    expect(threads.some((t) => t.id === 'th-1')).toBe(true);
  });

  it('thread:message:* handlers do not throw on malformed payloads', () => {
    renderHook(() => useThreadEvents('t1'));
    expect(() => wsHandlers.get('thread:message:deleted')!({})).not.toThrow();
  });

  it('unmount unsubscribes every handler', () => {
    const { unmount } = renderHook(() => useThreadEvents('t1'));
    unmount();
    for (const unsub of wsUnsubs.values()) {
      expect(unsub).toHaveBeenCalled();
    }
  });
});
