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

  describe('initTelemetry', () => {
    it('does not start when telemetry is disabled', async () => {
      const { useTelemetryStore } = await import('../stores/telemetryStore');
      useTelemetryStore.setState({ enabled: false });
      const { initTelemetry } = await import('./telemetry');
      // Should not throw and should not start SDK
      await initTelemetry();
    });
  });

  describe('stopTelemetry', () => {
    it('does nothing when SDK is not active', async () => {
      const { stopTelemetry } = await import('./telemetry');
      // Should not throw
      await stopTelemetry();
    });
  });

  describe('traceWSEvent with attributes', () => {
    it('does not throw with custom attributes', () => {
      expect(() => traceWSEvent('send', 'message:new', { channel_id: 'ch-1', team_id: 't1' })).not.toThrow();
    });

    it('does not throw with empty attributes', () => {
      expect(() => traceWSEvent('receive', 'presence:update', {})).not.toThrow();
    });

    it('does not throw without attributes', () => {
      expect(() => traceWSEvent('send', 'typing:start')).not.toThrow();
    });
  });

  describe('recordException variations', () => {
    it('does not throw without component name', () => {
      expect(() => recordException(new Error('test'))).not.toThrow();
    });

    it('does not throw with various error types', () => {
      expect(() => recordException(new TypeError('type error'), 'Component')).not.toThrow();
      expect(() => recordException(new RangeError('range error'), 'Other')).not.toThrow();
    });
  });
});
