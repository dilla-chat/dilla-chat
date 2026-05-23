import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockWebSocketService } from './mockWebSocket';

describe('MockWebSocketService', () => {
  let ws: MockWebSocketService;
  beforeEach(() => {
    vi.useFakeTimers();
    ws = new MockWebSocketService();
  });
  afterEach(() => {
    ws.disconnect();
    vi.useRealTimers();
  });

  it('connect() emits ws:connected after a short delay', () => {
    const handler = vi.fn();
    ws.on('ws:connected', handler);
    ws.connect('t1', 'ws://', 'tok');
    vi.advanceTimersByTime(150);
    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0][0] as { teamId: string }).teamId).toBe('t1');
  });

  it('connect() is idempotent (second call is a no-op)', () => {
    const handler = vi.fn();
    ws.on('ws:connected', handler);
    ws.connect('t1', 'ws://', 'tok');
    ws.connect('t1', 'ws://', 'tok');
    vi.advanceTimersByTime(150);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('isConnected reflects connect / disconnect state', () => {
    expect(ws.isConnected('t1')).toBe(false);
    ws.connect('t1', 'ws://', 'tok');
    expect(ws.isConnected('t1')).toBe(true);
    ws.disconnect();
    expect(ws.isConnected('t1')).toBe(false);
  });

  it('on() returns an unsubscribe function', () => {
    const handler = vi.fn();
    const off = ws.on('ws:connected', handler);
    off();
    ws.connect('t1', 'ws://', 'tok');
    vi.advanceTimersByTime(150);
    expect(handler).not.toHaveBeenCalled();
  });

  it('off() removes a specific handler without disturbing others', () => {
    const a = vi.fn();
    const b = vi.fn();
    ws.on('ws:connected', a);
    ws.on('ws:connected', b);
    ws.off('ws:connected', a);
    ws.connect('t1', 'ws://', 'tok');
    vi.advanceTimersByTime(150);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('connectWithParams is an alias for connect', () => {
    const handler = vi.fn();
    ws.on('ws:connected', handler);
    ws.connectWithParams('t1', 'ws://', 'auth-param');
    vi.advanceTimersByTime(150);
    expect(handler).toHaveBeenCalled();
  });

  it('disconnectAll calls disconnect', () => {
    ws.connect('t1', 'ws://', 'tok');
    expect(ws.isConnected('t1')).toBe(true);
    ws.disconnectAll();
    expect(ws.isConnected('t1')).toBe(false);
  });

  it('request("sync:init") returns a payload with team + members + channels', async () => {
    const resp = await ws.request<Record<string, unknown>>('t1', 'sync:init');
    expect(resp).toHaveProperty('team');
    expect(resp).toHaveProperty('members');
    expect(resp).toHaveProperty('channels');
    expect(resp).toHaveProperty('roles');
  });

  it('request() without peerApi returns {} for unknown actions', async () => {
    const resp = await ws.request<object>('t1', 'unknown:action');
    expect(resp).toEqual({});
  });

  it('request() delegates to the linked peerApi for messages:list', async () => {
    const getMessages = vi.fn().mockResolvedValue([{ id: 'm1' }]);
    ws.setPeerApi({ getMessages });
    const resp = await ws.request<Array<{ id: string }>>('t1', 'messages:list', {
      channel_id: 'c1',
      limit: 50,
    });
    expect(getMessages).toHaveBeenCalledWith('t1', 'c1', 50, undefined);
    expect(resp).toEqual([{ id: 'm1' }]);
  });

  it('all send-style no-op methods exist and return undefined', () => {
    // The MockWebSocketService advertises the same surface area as the
    // real ws so /mesh can use it as a drop-in. None of these need to
    // *do* anything in mock mode, but they MUST exist or the consumer
    // hits "is not a function".
    expect(ws.send('t1', { type: 'x', payload: {} })).toBeUndefined();
    expect(ws.sendMessage()).toBeUndefined();
    expect(ws.editMessage()).toBeUndefined();
    expect(ws.deleteMessage()).toBeUndefined();
    expect(ws.addReaction()).toBeUndefined();
    expect(ws.removeReaction()).toBeUndefined();
    expect(ws.startTyping()).toBeUndefined();
    expect(ws.joinChannel()).toBeUndefined();
    expect(ws.leaveChannel()).toBeUndefined();
    expect(ws.updatePresence()).toBeUndefined();
    expect(ws.voiceJoin()).toBeUndefined();
    expect(ws.voiceLeave()).toBeUndefined();
    expect(ws.voiceAnswer()).toBeUndefined();
    expect(ws.voiceICECandidate()).toBeUndefined();
    expect(ws.voiceMute()).toBeUndefined();
    expect(ws.voiceDeafen()).toBeUndefined();
    expect(ws.sendDMMessage()).toBeUndefined();
    expect(ws.editDMMessage()).toBeUndefined();
    expect(ws.deleteDMMessage()).toBeUndefined();
    expect(ws.startDMTyping()).toBeUndefined();
    expect(ws.stopDMTyping()).toBeUndefined();
    expect(ws.flushPendingMessages('t1')).toBeUndefined();
  });

  it('schedules typing / new-message / presence ticks after connect', () => {
    const onTyping = vi.fn();
    const onMsg = vi.fn();
    const onPresence = vi.fn();
    // Event names mirror the real ws so consumers can swap impls without changes.
    ws.on('typing:started', onTyping);
    ws.on('message:created', onMsg);
    ws.on('presence:updated', onPresence);
    ws.connect('t1', 'ws://', 'tok');
    // Max initial delays: typing 10–20s, msg 30–45s, presence ~30s.
    // Advance well past all of them so at least one ticks.
    vi.advanceTimersByTime(120_000);
    const total =
      onTyping.mock.calls.length +
      onMsg.mock.calls.length +
      onPresence.mock.calls.length;
    expect(total).toBeGreaterThan(0);
  });
});
