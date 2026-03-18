import { describe, it, expect, vi, beforeEach } from 'vitest';
import { traceWSEvent, recordException, getTracer } from './telemetry';

// The telemetry module uses dynamic imports for OTel SDK.
// We test the exported utility functions that don't require the SDK to be started.

describe('telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('traceWSEvent', () => {
    it('does nothing when SDK is not active', () => {
      // Should not throw even though SDK is inactive
      expect(() => traceWSEvent('send', 'message:new', { channel_id: 'ch-1' })).not.toThrow();
    });

    it('does nothing for receive events when inactive', () => {
      expect(() => traceWSEvent('receive', 'presence:update')).not.toThrow();
    });
  });

  describe('recordException', () => {
    it('does nothing when SDK is not active', () => {
      expect(() => recordException(new Error('test'), 'TestComponent')).not.toThrow();
    });
  });

  describe('getTracer', () => {
    it('returns a tracer object', () => {
      const tracer = getTracer();
      expect(tracer).toBeDefined();
      expect(typeof tracer.startSpan).toBe('function');
    });
  });
});
