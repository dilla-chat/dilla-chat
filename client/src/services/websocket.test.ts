import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocketService } from './websocket';

// Mock telemetry to avoid side effects
vi.mock('./telemetry', () => ({
  traceWSEvent: vi.fn(),
}));

describe('WebSocketService', () => {
  let service: WebSocketService;
  let mockSocket: { send: ReturnType<typeof vi.fn>; readyState: number; close: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    service = new WebSocketService();
    mockSocket = {
      send: vi.fn(),
      readyState: WebSocket.OPEN,
      close: vi.fn(),
    };
    // Inject a mock socket for team "t1"
    (service as unknown as { connections: Map<string, unknown> }).connections.set('t1', mockSocket);
  });

  describe('DM WebSocket methods send correct field names', () => {
    it('sendDMMessage sends dm_channel_id (not dm_id)', () => {
      service.sendDMMessage('t1', 'dm-123', 'hello', 'text');
      expect(mockSocket.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(mockSocket.send.mock.calls[0][0]);
      expect(sent.type).toBe('dm:message:send');
      expect(sent.payload.dm_channel_id).toBe('dm-123');
      expect(sent.payload).not.toHaveProperty('dm_id');
    });

    it('editDMMessage sends dm_channel_id (not dm_id)', () => {
      service.editDMMessage('t1', 'dm-123', 'msg-1', 'updated');
      const sent = JSON.parse(mockSocket.send.mock.calls[0][0]);
      expect(sent.type).toBe('dm:message:edit');
      expect(sent.payload.dm_channel_id).toBe('dm-123');
      expect(sent.payload.message_id).toBe('msg-1');
      expect(sent.payload).not.toHaveProperty('dm_id');
    });

    it('deleteDMMessage sends dm_channel_id (not dm_id)', () => {
      service.deleteDMMessage('t1', 'dm-123', 'msg-1');
      const sent = JSON.parse(mockSocket.send.mock.calls[0][0]);
      expect(sent.type).toBe('dm:message:delete');
      expect(sent.payload.dm_channel_id).toBe('dm-123');
      expect(sent.payload).not.toHaveProperty('dm_id');
    });

    it('startDMTyping sends dm_channel_id (not dm_id)', () => {
      service.startDMTyping('t1', 'dm-123');
      const sent = JSON.parse(mockSocket.send.mock.calls[0][0]);
      expect(sent.type).toBe('dm:typing:start');
      expect(sent.payload.dm_channel_id).toBe('dm-123');
      expect(sent.payload).not.toHaveProperty('dm_id');
    });

    it('stopDMTyping sends dm_channel_id (not dm_id)', () => {
      service.stopDMTyping('t1', 'dm-123');
      const sent = JSON.parse(mockSocket.send.mock.calls[0][0]);
      expect(sent.type).toBe('dm:typing:stop');
      expect(sent.payload.dm_channel_id).toBe('dm-123');
      expect(sent.payload).not.toHaveProperty('dm_id');
    });
  });

  describe('send', () => {
    it('drops messages when socket is not open', () => {
      mockSocket.readyState = WebSocket.CLOSED;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      service.send('t1', { type: 'test', payload: {} });
      expect(mockSocket.send).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('drops messages for unknown team', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      service.send('unknown-team', { type: 'test', payload: {} });
      expect(mockSocket.send).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe('disconnectAll', () => {
    it('disconnects every team stored in connectionParams', () => {
      // Add a second connection params entry
      const connParams = (service as unknown as { connectionParams: Map<string, unknown> })
        .connectionParams;
      connParams.set('t1', { url: 'ws://a', token: 'tok-a' });
      connParams.set('t2', { url: 'ws://b', token: 'tok-b' });

      // Also inject a mock socket for t2
      const mockSocket2 = { send: vi.fn(), readyState: WebSocket.OPEN, close: vi.fn(), onclose: null as (() => void) | null };
      (service as unknown as { connections: Map<string, unknown> }).connections.set('t2', mockSocket2);

      service.disconnectAll();

      expect(connParams.size).toBe(0);
      expect(mockSocket.close).toHaveBeenCalled();
      expect(mockSocket2.close).toHaveBeenCalled();
    });

    it('is a no-op when no teams are connected', () => {
      // Clear everything
      (service as unknown as { connectionParams: Map<string, unknown> }).connectionParams.clear();
      (service as unknown as { connections: Map<string, unknown> }).connections.clear();

      // Should not throw
      service.disconnectAll();
    });
  });

  describe('connectWithParams', () => {
    it('stores connection params and creates connection', () => {
      const connParams = (service as unknown as { connectionParams: Map<string, { url: string; token: string }> }).connectionParams;
      service.connectWithParams('t2', 'ws://test/ws', 'ticket=abc123');
      expect(connParams.has('t2')).toBe(true);
      expect(connParams.get('t2')!.token).toBe('ticket=abc123');
    });
  });

  describe('event handlers', () => {
    it('on/off registers and removes handlers', () => {
      const handler = vi.fn();
      const unsub = service.on('test:event', handler);

      // Emit by triggering the private emit via a simulated message
      (service as unknown as { emit: (type: string, payload: unknown) => void }).emit(
        'test:event',
        { data: 'hello' },
      );
      expect(handler).toHaveBeenCalledWith({ data: 'hello' });

      unsub();
      (service as unknown as { emit: (type: string, payload: unknown) => void }).emit(
        'test:event',
        { data: 'world' },
      );
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});
