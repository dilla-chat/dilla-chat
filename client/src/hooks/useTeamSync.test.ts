import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';

// --- mocks ---

vi.mock('../services/websocket', () => ({
  ws: {
    on: vi.fn(() => vi.fn()),
    off: vi.fn(),
    isConnected: vi.fn(() => false),
    request: vi.fn().mockResolvedValue({}),
    connectWithParams: vi.fn(),
    disconnectAll: vi.fn(),
    flushPendingMessages: vi.fn(),
  },
}));

vi.mock('../services/api', () => ({
  api: {
    addTeam: vi.fn(),
    setToken: vi.fn(),
    setAuthErrorHandler: vi.fn(),
    getTeam: vi.fn().mockResolvedValue({ id: 't1', name: 'Test Team' }),
    getChannels: vi.fn().mockResolvedValue([]),
    getMembers: vi.fn().mockResolvedValue([]),
    getRoles: vi.fn().mockResolvedValue([]),
    getPresences: vi.fn().mockResolvedValue({}),
    getWsTicket: vi.fn().mockResolvedValue('ticket-abc'),
    getConnectionInfo: vi.fn(() => ({ baseUrl: 'http://localhost:8080', token: 'tok' })),
  },
}));

vi.mock('../services/telemetryClient', () => ({
  telemetryClient: { setTeamId: vi.fn() },
}));

vi.mock('../services/crypto', () => ({
  cryptoService: {
    rotateChannelKey: vi.fn().mockResolvedValue(null),
    processSenderKey: vi.fn().mockResolvedValue(undefined),
  },
  resetCrypto: vi.fn(),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => vi.fn() };
});

import { ws } from '../services/websocket';
import { useAuthStore } from '../stores/authStore';
import { useTeamStore } from '../stores/teamStore';
import { useUnreadStore } from '../stores/unreadStore';
import { useVoiceStore } from '../stores/voiceStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useTeamSync } from './useTeamSync';

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(MemoryRouter, null, children);
}

function setupAuthStore(teamId = 't1') {
  useAuthStore.setState({
    teams: new Map([
      [teamId, { token: 'tok', user: { id: 'u1', username: 'tester' }, teamInfo: {}, baseUrl: 'http://localhost' }],
    ]),
    derivedKey: null,
  });
}

function setupTeamStore(teamId = 't1') {
  useTeamStore.setState({
    activeTeamId: teamId,
    activeChannelId: 'ch-1',
    channels: new Map([[teamId, []]]),
    members: new Map([[teamId, []]]),
  });
}

describe('useTeamSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupAuthStore();
    setupTeamStore();
    usePresenceStore.setState({ presences: {} });
    useVoiceStore.setState({ voiceOccupants: {} });
    useUnreadStore.setState({ counts: {} });
  });

  it('returns authChecked and dataLoaded refs', () => {
    const { result } = renderHook(() => useTeamSync('t1'), { wrapper });
    expect(result.current).toHaveProperty('authChecked');
    expect(result.current).toHaveProperty('dataLoaded');
  });

  it('registers ws:connected event handler', () => {
    renderHook(() => useTeamSync('t1'), { wrapper });
    const registeredEvents = vi.mocked(ws.on).mock.calls.map((c) => c[0]);
    expect(registeredEvents).toContain('ws:connected');
  });

  it('registers message:new event handler', () => {
    renderHook(() => useTeamSync('t1'), { wrapper });
    const registeredEvents = vi.mocked(ws.on).mock.calls.map((c) => c[0]);
    expect(registeredEvents).toContain('message:new');
  });

  it('registers channel:read event handler', () => {
    renderHook(() => useTeamSync('t1'), { wrapper });
    const registeredEvents = vi.mocked(ws.on).mock.calls.map((c) => c[0]);
    expect(registeredEvents).toContain('channel:read');
  });

  it('registers member:left event handler', () => {
    renderHook(() => useTeamSync('t1'), { wrapper });
    const registeredEvents = vi.mocked(ws.on).mock.calls.map((c) => c[0]);
    expect(registeredEvents).toContain('member:left');
  });

  it('unsubscribes all handlers on unmount', () => {
    const unsub = vi.fn();
    vi.mocked(ws.on).mockReturnValue(unsub);
    const { unmount } = renderHook(() => useTeamSync('t1'), { wrapper });
    unmount();
    expect(unsub).toHaveBeenCalled();
  });

  it('message:new increments unread for non-active channel', () => {
    renderHook(() => useTeamSync('t1'), { wrapper });
    const calls = vi.mocked(ws.on).mock.calls as [string, (...args: unknown[]) => void][];
    const handler = calls.find((c) => c[0] === 'message:new')?.[1];
    expect(handler).toBeDefined();

    // Currently viewing ch-1, new message arrives on ch-99 (different channel)
    useTeamStore.setState({ activeChannelId: 'ch-1' });
    handler?.({ channel_id: 'ch-99' });
    expect(useUnreadStore.getState().counts['ch-99']).toBe(1);
  });

  it('message:new does not increment unread for active channel', () => {
    renderHook(() => useTeamSync('t1'), { wrapper });
    const calls = vi.mocked(ws.on).mock.calls as [string, (...args: unknown[]) => void][];
    const handler = calls.find((c) => c[0] === 'message:new')?.[1];

    useTeamStore.setState({ activeChannelId: 'ch-1' });
    handler?.({ channel_id: 'ch-1' });
    // count should remain 0 (not incremented)
    expect(useUnreadStore.getState().counts['ch-1'] ?? 0).toBe(0);
  });

  it('message:new ignores payload with no channel_id', () => {
    renderHook(() => useTeamSync('t1'), { wrapper });
    const calls = vi.mocked(ws.on).mock.calls as [string, (...args: unknown[]) => void][];
    const handler = calls.find((c) => c[0] === 'message:new')?.[1];
    // Should not throw
    handler?.({});
    expect(useUnreadStore.getState().counts).toEqual({});
  });

  it('channel:read marks the channel as read in unreadStore', () => {
    useUnreadStore.setState({ counts: { 'ch-5': 7 } });
    renderHook(() => useTeamSync('t1'), { wrapper });
    const calls = vi.mocked(ws.on).mock.calls as [string, (...args: unknown[]) => void][];
    const handler = calls.find((c) => c[0] === 'channel:read')?.[1];
    expect(handler).toBeDefined();

    handler?.({ channel_id: 'ch-5' });
    expect(useUnreadStore.getState().counts['ch-5']).toBe(0);
  });

  it('channel:read ignores payload with no channel_id', () => {
    useUnreadStore.setState({ counts: { 'ch-5': 3 } });
    renderHook(() => useTeamSync('t1'), { wrapper });
    const calls = vi.mocked(ws.on).mock.calls as [string, (...args: unknown[]) => void][];
    const handler = calls.find((c) => c[0] === 'channel:read')?.[1];
    handler?.({});
    // count unchanged
    expect(useUnreadStore.getState().counts['ch-5']).toBe(3);
  });

  it('does not register WS event handlers when activeTeamId is null', () => {
    vi.mocked(ws.on).mockClear();
    renderHook(() => useTeamSync(null), { wrapper });
    const registered = vi.mocked(ws.on).mock.calls.map((c) => c[0]);
    // message:new and channel:read handlers require activeTeamId
    expect(registered).not.toContain('message:new');
    expect(registered).not.toContain('channel:read');
  });

  it('sync:init unread_counts are applied to unreadStore via ws:connected', async () => {
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(ws.request).mockResolvedValue({
      channels: [],
      unread_counts: { 'ch-10': 5, 'ch-11': 2 },
    });

    const { result } = renderHook(() => useTeamSync('t1'), { wrapper });
    // Simulate ws:connected event
    const calls = vi.mocked(ws.on).mock.calls as [string, (...args: unknown[]) => void][];
    const connectedHandler = calls.find((c) => c[0] === 'ws:connected')?.[1];
    // Trigger the connected handler (which calls ws.request → applySyncData)
    connectedHandler?.({ teamId: 't1' });

    await vi.waitFor(() => {
      expect(ws.request).toHaveBeenCalledWith('t1', 'sync:init');
    });
    // After the async request resolves, unread counts should be set
    await vi.waitFor(() => {
      const counts = useUnreadStore.getState().counts;
      expect(counts['ch-10']).toBe(5);
      expect(counts['ch-11']).toBe(2);
    });
    expect(result.current.dataLoaded.current.has('t1')).toBe(true);
  });
});
