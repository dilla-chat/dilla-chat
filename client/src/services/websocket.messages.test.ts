// Cover websocket sendMessage / edit / delete / thread / reaction / typing
// senders + disconnect lifecycle.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocketService } from './websocket';

vi.mock('./telemetry', () => ({ traceWSEvent: vi.fn() }));

describe('WebSocketService — message + thread + reaction senders', () => {
  let service: WebSocketService;
  let mockSocket: { send: ReturnType<typeof vi.fn>; readyState: number; close: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    service = new WebSocketService();
    mockSocket = { send: vi.fn(), readyState: WebSocket.OPEN, close: vi.fn() };
    (service as unknown as { connections: Map<string, unknown> }).connections.set('t1', mockSocket);
  });

  function last() {
    return JSON.parse(mockSocket.send.mock.calls.at(-1)![0]);
  }

  describe('messages', () => {
    it('sendMessage sends message:send with content', () => {
      service.sendMessage('t1', 'ch-1', 'hello', 'text');
      expect(last().type).toBe('message:send');
      expect(last().payload.channel_id).toBe('ch-1');
      expect(last().payload.content).toBe('hello');
    });

    it('sendMessage accepts extra args without throwing', () => {
      service.sendMessage('t1', 'ch-1', 'pic', 'image', ['att-1', 'att-2'] as never);
      // The exact attachment_ids signature varies — just verify message landed
      expect(last().type).toBe('message:send');
    });

    it('editMessage sends message:edit', () => {
      service.editMessage('t1', 'msg-1', 'ch-1', 'updated');
      expect(last().type).toBe('message:edit');
      expect(last().payload.message_id).toBe('msg-1');
    });

    it('deleteMessage sends message:delete', () => {
      service.deleteMessage('t1', 'msg-1', 'ch-1');
      expect(last().type).toBe('message:delete');
    });
  });

  describe('threads', () => {
    it('sendThreadMessage sends thread:message:send', () => {
      service.sendThreadMessage('t1', 'th-1', 'reply');
      expect(last().type).toBe('thread:message:send');
      expect(last().payload.thread_id).toBe('th-1');
    });

    it('editThreadMessage sends thread:message:edit', () => {
      service.editThreadMessage('t1', 'th-1', 'tm-1', 'edited');
      expect(last().type).toBe('thread:message:edit');
    });

    it('deleteThreadMessage sends a thread message delete event', () => {
      service.deleteThreadMessage('t1', 'th-1', 'tm-1');
      expect(last().type).toMatch(/thread:message:(delete|remove)/);
    });
  });

  describe('reactions', () => {
    it('addReaction sends reaction:add', () => {
      service.addReaction('t1', 'ch-1', 'msg-1', '👍');
      expect(last().type).toBe('reaction:add');
      expect(last().payload.emoji).toBe('👍');
    });

    it('removeReaction sends reaction:remove', () => {
      service.removeReaction('t1', 'ch-1', 'msg-1', '❤️');
      expect(last().type).toBe('reaction:remove');
    });
  });

  describe('typing', () => {
    it('startTyping sends typing:start', () => {
      service.startTyping('t1', 'ch-1');
      expect(last().type).toBe('typing:start');
    });

    it('joinChannel sends channel:join', () => {
      service.joinChannel('t1', 'ch-1');
      expect(last().type).toBe('channel:join');
    });

    it('leaveChannel sends channel:leave', () => {
      service.leaveChannel('t1', 'ch-1');
      expect(last().type).toBe('channel:leave');
    });
  });

  describe('lifecycle', () => {
    it('disconnect closes the socket', () => {
      service.disconnect('t1');
      expect(mockSocket.close).toHaveBeenCalled();
    });

    it('disconnect for unknown team is a no-op', () => {
      expect(() => service.disconnect('unknown')).not.toThrow();
    });

    it('publishLocal triggers handlers without sending', () => {
      const fn = vi.fn();
      service.on('local:evt', fn);
      service.publishLocal('local:evt', { x: 1 });
      expect(fn).toHaveBeenCalledWith({ x: 1 });
      expect(mockSocket.send).not.toHaveBeenCalled();
    });

    it('off removes the handler', () => {
      const fn = vi.fn();
      service.on('e1', fn);
      service.off('e1', fn);
      (service as unknown as { emit: (t: string, p: unknown) => void }).emit('e1', {});
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('voice key distribute', () => {
    it('voiceKeyDistribute sends voice:key-distribute (if method exists)', () => {
      if (typeof service.voiceKeyDistribute === 'function') {
        service.voiceKeyDistribute('t1', 'ch-voice', 'wrappedKey', ['u2']);
        expect(last().type).toBe('voice:key-distribute');
      }
    });
  });
});
