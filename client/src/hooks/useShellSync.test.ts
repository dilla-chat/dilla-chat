// Tests for the shell-level mesh sync hook. Mirrors the structure of
// useChannelEvents.test / useDMEvents.test — capture ws.on() handlers
// into a Map, drive each handler from the test, assert the
// observable mesh-store state.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

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

import { useShellSync } from './useShellSync';
import { useMeshStore } from '../stores/meshStore';
import { useAuthStore } from '../stores/authStore';
import { useTeamStore } from '../stores/teamStore';

function resetMeshStore() {
  useMeshStore.setState({
    nodeName: '',
    peersConnected: 0,
    peersTotal: 0,
    lamport: 0,
    latencyMs: 0,
    status: 'ready',
    connectionBanner: null,
  });
}

describe('useShellSync — nodeName derivation', () => {
  beforeEach(() => {
    wsHandlers.clear();
    wsUnsubs.clear();
    resetMeshStore();
  });

  it('clears nodeName when no activeTeamId is set', () => {
    useTeamStore.setState({ activeTeamId: null });
    useAuthStore.setState({ teams: new Map() });
    renderHook(() => useShellSync());
    expect(useMeshStore.getState().nodeName).toBe('');
  });

  it('strips the protocol + trailing slash from the team baseUrl', () => {
    useTeamStore.setState({ activeTeamId: 't1' });
    useAuthStore.setState({
      teams: new Map([
        ['t1', { token: 'tok', user: { id: 'u1' }, teamInfo: {}, baseUrl: 'https://node-a.dilla.test/' }],
      ]),
    });
    renderHook(() => useShellSync());
    expect(useMeshStore.getState().nodeName).toBe('node-a.dilla.test');
  });

  it('handles non-Map teams object defensively', () => {
    useTeamStore.setState({ activeTeamId: 't1' });
    // Some test mocks pass a plain object instead of a Map — guard against it.
    useAuthStore.setState({ teams: {} as never });
    expect(() => renderHook(() => useShellSync())).not.toThrow();
  });
});

describe('useShellSync — WS event dispatch', () => {
  beforeEach(() => {
    wsHandlers.clear();
    wsUnsubs.clear();
    resetMeshStore();
    useTeamStore.setState({ activeTeamId: 't1' });
    useAuthStore.setState({
      teams: new Map([
        ['t1', { token: 'tok', user: { id: 'u1' }, teamInfo: {}, baseUrl: 'http://localhost' }],
      ]),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('registers all expected handlers', () => {
    renderHook(() => useShellSync());
    expect(wsHandlers.has('message:created')).toBe(true);
    expect(wsHandlers.has('dm:message:created')).toBe(true);
    expect(wsHandlers.has('ws:connected')).toBe(true);
    expect(wsHandlers.has('ws:disconnected')).toBe(true);
    expect(wsHandlers.has('federation:peer-status')).toBe(true);
    expect(wsHandlers.has('federation:lamport')).toBe(true);
    expect(wsHandlers.has('federation:latency')).toBe(true);
    expect(wsHandlers.has('voice:incoming-call')).toBe(true);
  });

  it('message:created bumps the lamport tick', () => {
    renderHook(() => useShellSync());
    const before = useMeshStore.getState().lamport;
    wsHandlers.get('message:created')!();
    const after = useMeshStore.getState().lamport;
    expect(after).toBeGreaterThan(before);
  });

  it('dm:message:created also bumps the lamport tick', () => {
    renderHook(() => useShellSync());
    const before = useMeshStore.getState().lamport;
    wsHandlers.get('dm:message:created')!();
    expect(useMeshStore.getState().lamport).toBeGreaterThan(before);
  });

  it('federation:peer-status sets peers + maps status to degraded', () => {
    renderHook(() => useShellSync());
    wsHandlers.get('federation:peer-status')!({ connected: 1, total: 3 });
    const s = useMeshStore.getState();
    expect(s.peersConnected).toBe(1);
    expect(s.peersTotal).toBe(3);
    expect(s.status).toBe('degraded');
  });

  it('federation:peer-status with full connection maps status to ok', () => {
    renderHook(() => useShellSync());
    wsHandlers.get('federation:peer-status')!({ connected: 3, total: 3 });
    expect(useMeshStore.getState().status).toBe('ok');
  });

  it('federation:peer-status with zero peers maps status to ready', () => {
    renderHook(() => useShellSync());
    wsHandlers.get('federation:peer-status')!({ connected: 0, total: 0 });
    expect(useMeshStore.getState().status).toBe('ready');
  });

  it('federation:peer-status ignores payloads with wrong shape', () => {
    renderHook(() => useShellSync());
    expect(() =>
      wsHandlers.get('federation:peer-status')!({ connected: 'wrong' as never }),
    ).not.toThrow();
  });

  it('federation:lamport sets the absolute lamport value', () => {
    renderHook(() => useShellSync());
    wsHandlers.get('federation:lamport')!({ value: 4242 });
    expect(useMeshStore.getState().lamport).toBe(4242);
  });

  it('federation:latency sets the p50 latency in ms', () => {
    renderHook(() => useShellSync());
    wsHandlers.get('federation:latency')!({ p50_ms: 17 });
    expect(useMeshStore.getState().latencyMs).toBe(17);
  });

  it('ws:disconnected raises an offline connection banner', () => {
    renderHook(() => useShellSync());
    wsHandlers.get('ws:disconnected')!();
    const banner = useMeshStore.getState().connectionBanner;
    expect(banner?.kind).toBe('offline');
  });

  it('ws:connected with peersTotal=0 sets status to ready', () => {
    useMeshStore.setState({ peersTotal: 0, peersConnected: 0 } as never);
    renderHook(() => useShellSync());
    wsHandlers.get('ws:connected')!();
    expect(useMeshStore.getState().status).toBe('ready');
  });

  it('ws:connected with peersConnected < peersTotal sets status to degraded', () => {
    useMeshStore.setState({ peersTotal: 3, peersConnected: 1 } as never);
    renderHook(() => useShellSync());
    wsHandlers.get('ws:connected')!();
    expect(useMeshStore.getState().status).toBe('degraded');
  });

  it('ws:connected with full peers + prior offline banner shows restored banner', () => {
    useMeshStore.setState({
      peersTotal: 2,
      peersConnected: 2,
      connectionBanner: { kind: 'offline', message: 'Disconnected' },
    } as never);
    renderHook(() => useShellSync());
    wsHandlers.get('ws:connected')!();
    expect(useMeshStore.getState().connectionBanner?.kind).toBe('restored');
  });

  it('voice:incoming-call dispatches a mesh:incoming-call CustomEvent', () => {
    const spy = vi.spyOn(window, 'dispatchEvent');
    renderHook(() => useShellSync());
    wsHandlers.get('voice:incoming-call')!({
      caller_user_id: 'u-2',
      caller_username: 'bob',
      channel_id: 'ch-1',
      channel_name: 'voice',
    });
    const fired = spy.mock.calls.some(
      (c) =>
        c[0] instanceof CustomEvent && c[0].type === 'mesh:incoming-call',
    );
    expect(fired).toBe(true);
    spy.mockRestore();
  });

  it('voice:incoming-call without a caller_username is ignored', () => {
    const spy = vi.spyOn(window, 'dispatchEvent');
    renderHook(() => useShellSync());
    act(() => {
      wsHandlers.get('voice:incoming-call')!({ caller_user_id: 'u-2' });
    });
    const fired = spy.mock.calls.some(
      (c) =>
        c[0] instanceof CustomEvent && c[0].type === 'mesh:incoming-call',
    );
    expect(fired).toBe(false);
    spy.mockRestore();
  });

  it('unmount unsubscribes every handler', () => {
    const { unmount } = renderHook(() => useShellSync());
    unmount();
    for (const unsub of wsUnsubs.values()) {
      expect(unsub).toHaveBeenCalled();
    }
  });
});
