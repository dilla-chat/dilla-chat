// Smoke + dispatch tests for the global DM-event subscriber.
//
// Mirrors useChannelEvents but on a separate event namespace (dm:created,
// dm:message:new, dm:message:updated, dm:message:deleted, dm:typing:indicator)
// dispatching into useDMStore + useUnreadStore.

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
    markChannelRead: vi.fn(),
  },
}));

vi.mock('../services/api', () => ({
  api: {
    getDMChannels: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../services/crypto', () => ({
  cryptoService: {
    decryptDM: vi.fn(async (_t, _s, ct) => `decrypted:${ct}`),
  },
}));

vi.mock('../services/messageCache', () => ({
  deleteCachedMessage: vi.fn(),
  getCachedMessage: vi.fn(async () => null),
  cacheMessage: vi.fn(),
}));

vi.mock('./useMessageDecryption', () => ({
  serverToMessage: vi.fn((m: { id: string; channel_id: string; author_id: string; content: string }, content: string) => ({
    id: m.id,
    channelId: m.channel_id,
    authorId: m.author_id,
    content,
    type: 'text',
    createdAt: new Date().toISOString(),
  })),
}));

import { useDMEvents } from './useDMEvents';
import { useAuthStore } from '../stores/authStore';
import { useDMStore } from '../stores/dmStore';
import { useUnreadStore } from '../stores/unreadStore';

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
    derivedKey: 'derived-key',
  });
  useDMStore.setState({
    activeDMId: null,
    dmChannels: { [teamId]: [] },
    dmMessages: {},
    dmTyping: {},
  });
  useUnreadStore.setState({ counts: new Map() });
}

describe('useDMEvents', () => {
  beforeEach(() => {
    wsHandlers.clear();
    wsUnsubs.clear();
    seedStores('team-1');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when activeTeamId is null', () => {
    renderHook(() => useDMEvents(null, true));
    expect(wsHandlers.has('dm:created')).toBe(false);
  });

  it('does nothing while cryptoReady is false', () => {
    renderHook(() => useDMEvents('team-1', false));
    expect(wsHandlers.has('dm:created')).toBe(false);
  });

  it('registers handlers when team + crypto are ready', () => {
    renderHook(() => useDMEvents('team-1', true));
    expect(wsHandlers.has('dm:created')).toBe(true);
    expect(wsHandlers.has('dm:message:new')).toBe(true);
    expect(wsHandlers.has('dm:message:updated')).toBe(true);
    expect(wsHandlers.has('dm:message:deleted')).toBe(true);
    expect(wsHandlers.has('dm:typing:indicator')).toBe(true);
  });

  it('dm:created adds the channel to useDMStore', () => {
    renderHook(() => useDMEvents('team-1', true));
    const handler = wsHandlers.get('dm:created')!;
    handler({
      id: 'dm-1',
      team_id: 'team-1',
      type: 'dm',
      name: '',
      created_at: new Date().toISOString(),
      members: ['me', 'peer'],
    });
    const dms = useDMStore.getState().dmChannels['team-1'] ?? [];
    expect(dms.some((c) => c.id === 'dm-1')).toBe(true);
  });

  it('dm:message:deleted invokes the store without throwing', () => {
    renderHook(() => useDMEvents('team-1', true));
    const handler = wsHandlers.get('dm:message:deleted')!;
    expect(() => handler({ dm_id: 'dm-1', message_id: 'm1' })).not.toThrow();
  });

  it('dm:message:deleted ignores payloads with no dm_id', () => {
    renderHook(() => useDMEvents('team-1', true));
    const handler = wsHandlers.get('dm:message:deleted')!;
    expect(() => handler({ message_id: 'm1' })).not.toThrow();
  });

  it('dm:typing:indicator adds the user id to the typing list', () => {
    renderHook(() => useDMEvents('team-1', true));
    const handler = wsHandlers.get('dm:typing:indicator')!;
    handler({ dm_id: 'dm-1', user_id: 'peer', username: 'peer' });
    const typing = useDMStore.getState().dmTyping['dm-1'] ?? [];
    expect(typing).toContain('peer');
  });

  it('dm:typing:indicator dedupes the same user', () => {
    renderHook(() => useDMEvents('team-1', true));
    const handler = wsHandlers.get('dm:typing:indicator')!;
    handler({ dm_id: 'dm-1', user_id: 'peer', username: 'peer' });
    handler({ dm_id: 'dm-1', user_id: 'peer', username: 'peer' });
    const typing = useDMStore.getState().dmTyping['dm-1'] ?? [];
    expect(typing.filter((u) => u === 'peer').length).toBe(1);
  });

  it('unmount unsubscribes every handler', () => {
    const { unmount } = renderHook(() => useDMEvents('team-1', true));
    unmount();
    for (const unsub of wsUnsubs.values()) {
      expect(unsub).toHaveBeenCalled();
    }
  });
});
