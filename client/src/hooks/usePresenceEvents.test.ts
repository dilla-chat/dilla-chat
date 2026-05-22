// Coverage for the presence/voice WS subscriber. Same pattern as
// useChannelEvents / useDMEvents / useShellSync — drive each ws.on()
// handler from the test and assert observable store mutations.

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

import { usePresenceEvents } from './usePresenceEvents';
import { usePresenceStore } from '../stores/presenceStore';
import { useVoiceStore } from '../stores/voiceStore';

describe('usePresenceEvents', () => {
  beforeEach(() => {
    wsHandlers.clear();
    wsUnsubs.clear();
    usePresenceStore.setState({ presences: {} });
    useVoiceStore.setState({
      voiceOccupants: {},
      currentChannelId: null,
      currentTeamId: null,
      connected: false,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('registers presence + voice event handlers', () => {
    renderHook(() => usePresenceEvents('t1'));
    expect(wsHandlers.has('presence:changed')).toBe(true);
    expect(wsHandlers.has('voice:user-joined')).toBe(true);
    expect(wsHandlers.has('voice:user-left')).toBe(true);
    expect(wsHandlers.has('voice:join-denied')).toBe(true);
  });

  it('presence:changed normalizes status_type and writes to the presence store', () => {
    renderHook(() => usePresenceEvents('t1'));
    wsHandlers.get('presence:changed')!({
      team_id: 't1',
      user_id: 'u1',
      status_type: 'idle',
      status_text: 'brb',
      last_active: '2026-01-01T00:00:00Z',
    });
    const teamPres = usePresenceStore.getState().presences['t1'];
    expect(teamPres?.u1?.status).toBe('idle');
    expect(teamPres?.u1?.custom_status).toBe('brb');
  });

  it('presence:changed falls back to activeTeamId when team_id is missing', () => {
    renderHook(() => usePresenceEvents('t1'));
    wsHandlers.get('presence:changed')!({
      user_id: 'u2',
      status_type: 'online',
    });
    expect(usePresenceStore.getState().presences['t1']?.u2?.status).toBe('online');
  });

  it('voice:user-joined adds an occupant with defaulted fields', () => {
    renderHook(() => usePresenceEvents('t1'));
    wsHandlers.get('voice:user-joined')!({
      channel_id: 'ch-1',
      user_id: 'u1',
      username: 'alice',
    });
    const occ = useVoiceStore.getState().voiceOccupants['ch-1'];
    expect(occ).toBeDefined();
    expect(occ![0].user_id).toBe('u1');
    expect(occ![0].muted).toBe(false);
    expect(occ![0].deafened).toBe(false);
    expect(occ![0].screen_sharing).toBe(false);
  });

  it('voice:user-joined honors the muted/deafened/sharing flags', () => {
    renderHook(() => usePresenceEvents('t1'));
    wsHandlers.get('voice:user-joined')!({
      channel_id: 'ch-1',
      user_id: 'u1',
      username: 'alice',
      muted: true,
      deafened: true,
      screen_sharing: true,
      webcam_sharing: true,
    });
    const occ = useVoiceStore.getState().voiceOccupants['ch-1']?.[0];
    expect(occ?.muted).toBe(true);
    expect(occ?.deafened).toBe(true);
    expect(occ?.screen_sharing).toBe(true);
    expect(occ?.webcam_sharing).toBe(true);
  });

  it('voice:user-left removes an occupant', () => {
    renderHook(() => usePresenceEvents('t1'));
    wsHandlers.get('voice:user-joined')!({
      channel_id: 'ch-1',
      user_id: 'u1',
      username: 'alice',
    });
    wsHandlers.get('voice:user-left')!({ channel_id: 'ch-1', user_id: 'u1' });
    const occ = useVoiceStore.getState().voiceOccupants['ch-1'] ?? [];
    expect(occ.find((o) => o.user_id === 'u1')).toBeUndefined();
  });

  it('voice:join-denied fires a dilla:notify CustomEvent', () => {
    const spy = vi.spyOn(window, 'dispatchEvent');
    renderHook(() => usePresenceEvents('t1'));
    wsHandlers.get('voice:join-denied')!({ channel_id: 'ch-1', reason: 'locked' });
    const fired = spy.mock.calls.some(
      (c) =>
        c[0] instanceof CustomEvent && c[0].type === 'dilla:notify',
    );
    expect(fired).toBe(true);
    spy.mockRestore();
  });

  it('voice:join-denied tears down the local voice state for the affected channel', () => {
    useVoiceStore.setState({ currentChannelId: 'ch-1', connected: true });
    renderHook(() => usePresenceEvents('t1'));
    wsHandlers.get('voice:join-denied')!({ channel_id: 'ch-1', reason: 'locked' });
    // leaveChannel is the observable side-effect; assert it cleared the
    // currentChannelId.
    expect(useVoiceStore.getState().currentChannelId).toBeNull();
  });

  it('unmount unsubscribes every handler', () => {
    const { unmount } = renderHook(() => usePresenceEvents('t1'));
    unmount();
    for (const unsub of wsUnsubs.values()) {
      expect(unsub).toHaveBeenCalled();
    }
  });
});
