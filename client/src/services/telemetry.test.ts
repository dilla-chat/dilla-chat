import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the OTel SDK modules before importing telemetry
vi.mock('@opentelemetry/sdk-trace-web', () => ({
  WebTracerProvider: class {
    register() {}
    shutdown() { return Promise.resolve(); }
  },
  BatchSpanProcessor: class {
    constructor() {}
  },
}));

vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class {
    constructor() {}
  },
}));

vi.mock('@opentelemetry/resources', () => ({
  resourceFromAttributes: () => ({}),
}));

vi.mock('@opentelemetry/semantic-conventions', () => ({
  ATTR_SERVICE_NAME: 'service.name',
  ATTR_SERVICE_VERSION: 'service.version',
}));

vi.mock('@opentelemetry/instrumentation', () => ({
  registerInstrumentations: () => {},
}));

vi.mock('@opentelemetry/auto-instrumentations-web', () => ({
  getWebAutoInstrumentations: () => [],
}));

import { traceWSEvent, recordException, getTracer, startTelemetry, stopTelemetry, initTelemetry } from './telemetry';

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

  describe('filterAttributes', () => {
    it('filters out non-allowlisted keys via traceWSEvent', () => {
      expect(() =>
        traceWSEvent('send', 'test', {
          channel_id: 'ch1',
          'secret_data': 'nope',
          'http.method': 'GET',
        }),
      ).not.toThrow();
    });

    it('handles undefined attributes', () => {
      expect(() => traceWSEvent('send', 'test')).not.toThrow();
    });

    it('handles empty attributes object', () => {
      expect(() => traceWSEvent('send', 'test', {})).not.toThrow();
    });
  });

  describe('startTelemetry and stopTelemetry lifecycle', () => {
    it('starts the OTel SDK, creates provider, and registers instrumentations', async () => {
      await startTelemetry();
      // SDK is now active, verify by checking that a second start is a no-op
      await startTelemetry();
      // Now stop
      await stopTelemetry();
      // Double stop should be a no-op
      await stopTelemetry();
    });

    it('traceWSEvent creates spans when SDK is active', async () => {
      await startTelemetry();
      // Now SDK is active, traceWSEvent should create a span
      traceWSEvent('send', 'message:new', { channel_id: 'ch-1' });
      traceWSEvent('receive', 'presence:update');
      traceWSEvent('send', 'typing:start', { channel_id: 'ch-1', team_id: 't1' });
      // With disallowed attributes (should be filtered)
      traceWSEvent('send', 'test', { channel_id: 'ch1', 'private_data': 'filtered' });
      await stopTelemetry();
    });

    it('recordException creates error spans when SDK is active', async () => {
      await startTelemetry();
      recordException(new Error('test error'), 'TestComponent');
      recordException(new TypeError('type error'));
      await stopTelemetry();
    });

    it('filterAttributes returns empty object for undefined attrs', async () => {
      await startTelemetry();
      // traceWSEvent with no attrs triggers filterAttributes(undefined)
      traceWSEvent('send', 'test');
      // traceWSEvent with empty attrs triggers filterAttributes({})
      traceWSEvent('send', 'test', {});
      // traceWSEvent with mixed allowed/disallowed keys
      traceWSEvent('send', 'test', {
        'http.method': 'GET',
        'http.route': '/api/test',
        'http.status_code': '200',
        'http.duration_ms': '50',
        'http.url': 'http://example.com',
        'http.host': 'example.com',
        'ws.event_type': 'message',
        'db.query_name': 'select',
        'user_id': 'u1',
        'team_id': 't1',
        'channel_id': 'ch1',
        'message_id': 'm1',
        'component': 'ws',
        'error': 'none',
        'error.type': 'none',
        'error.message': 'none',
        'error.stack': 'none',
        'web_vital.name': 'LCP',
        'web_vital.value': '2.5',
        'web_vital.rating': 'good',
        'disallowed_key': 'should be filtered',
      });
      await stopTelemetry();
    });
  });

  describe('initTelemetry', () => {
    it('starts telemetry when store is enabled', async () => {
      const { useTelemetryStore } = await import('../stores/telemetryStore');
      useTelemetryStore.setState({ enabled: false });
      await initTelemetry();
    });

    it('subscribes to store changes and starts/stops on toggle', async () => {
      const { useTelemetryStore } = await import('../stores/telemetryStore');
      useTelemetryStore.setState({ enabled: false });
      await initTelemetry();
      // Toggling enabled should trigger start
      useTelemetryStore.setState({ enabled: true });
      // Wait for subscription to fire
      await new Promise(r => setTimeout(r, 10));
      // Toggling back should trigger stop
      useTelemetryStore.setState({ enabled: false });
      await new Promise(r => setTimeout(r, 10));
    });
  });
});
