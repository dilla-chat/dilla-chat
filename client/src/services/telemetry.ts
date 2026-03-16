import { trace, SpanStatusCode } from '@opentelemetry/api';
import { useTelemetryStore } from '../stores/telemetryStore';

// Privacy allowlist — only these attribute keys are permitted in exported spans.
const ALLOWED_ATTRIBUTES = new Set([
  'http.method',
  'http.route',
  'http.status_code',
  'http.duration_ms',
  'http.url',
  'http.host',
  'ws.event_type',
  'db.query_name',
  'user_id',
  'team_id',
  'channel_id',
  'message_id',
  'component',
  'error',
  'error.type',
  'error.message',
  'error.stack',
  'web_vital.name',
  'web_vital.value',
  'web_vital.rating',
]);

let sdkActive = false;
let providerRef: { shutdown(): Promise<void> } | null = null;

/**
 * Check if telemetry is currently enabled (user setting).
 */
function isEnabled(): boolean {
  return useTelemetryStore.getState().enabled;
}

/**
 * Start the OTel SDK. Called when the user enables telemetry.
 * Traces are sent to the Go server's proxy endpoint (/api/v1/telemetry),
 * which forwards them to SigNoz — the SigNoz endpoint and API key are
 * NEVER exposed to the browser.
 */
export async function startTelemetry(): Promise<void> {
  if (sdkActive) return;

  // Dynamic imports so the OTel SDK is fully tree-shaken when telemetry is off.
  const [
    { WebTracerProvider, BatchSpanProcessor },
    { OTLPTraceExporter },
    { resourceFromAttributes },
    { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION },
    { registerInstrumentations },
    { getWebAutoInstrumentations },
  ] = await Promise.all([
    import('@opentelemetry/sdk-trace-web'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/semantic-conventions'),
    import('@opentelemetry/instrumentation'),
    import('@opentelemetry/auto-instrumentations-web'),
  ]);

  const serverOrigin = import.meta.env.VITE_API_URL || window.location.origin;
  const telemetryUrl = `${serverOrigin}/api/v1/telemetry?type=traces`;

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: 'dilla-client',
    [ATTR_SERVICE_VERSION]: import.meta.env.VITE_APP_VERSION || 'dev',
  });

  const exporter = new OTLPTraceExporter({ url: telemetryUrl });

  const provider = new WebTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });

  provider.register();
  providerRef = provider;

  // Auto-instrument fetch (covers all api.ts calls).
  registerInstrumentations({
    instrumentations: [
      getWebAutoInstrumentations({
        '@opentelemetry/instrumentation-fetch': {
          ignoreUrls: [/\/api\/v1\/telemetry/],
          propagateTraceHeaderCorsUrls: [
            new RegExp(serverOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
          ],
          clearTimingResources: true,
        },
        '@opentelemetry/instrumentation-xml-http-request': { enabled: false },
        '@opentelemetry/instrumentation-document-load': { enabled: true },
        '@opentelemetry/instrumentation-user-interaction': { enabled: false },
      }),
    ],
  });

  sdkActive = true;
  console.log('[telemetry] OpenTelemetry started, exporting to', telemetryUrl);
}

/**
 * Stop the OTel SDK. Called when the user disables telemetry.
 */
export async function stopTelemetry(): Promise<void> {
  if (!sdkActive || !providerRef) return;
  await providerRef.shutdown();
  providerRef = null;
  sdkActive = false;
  console.log('[telemetry] OpenTelemetry stopped');
}

/**
 * Initialize telemetry based on the persisted user setting.
 * Called once from main.tsx before React renders.
 */
export async function initTelemetry(): Promise<void> {
  if (isEnabled()) {
    await startTelemetry();
  }

  // React to future store changes (user toggling the setting).
  useTelemetryStore.subscribe((state, prev) => {
    if (state.enabled !== prev.enabled) {
      if (state.enabled) {
        startTelemetry();
      } else {
        stopTelemetry();
      }
    }
  });
}

/**
 * Get the tracer for creating custom spans.
 */
export function getTracer() {
  return trace.getTracer('dilla-client');
}

/**
 * Create and end a span for a WebSocket event (send or receive).
 * Only records event type — NEVER payload content.
 */
export function traceWSEvent(
  direction: 'send' | 'receive',
  eventType: string,
  attrs?: Record<string, string>,
): void {
  if (!sdkActive) return;

  const tracer = getTracer();
  const span = tracer.startSpan(`ws.${direction}.${eventType}`, {
    attributes: {
      'ws.event_type': eventType,
      component: 'websocket',
      ...filterAttributes(attrs),
    },
  });
  span.end();
}

/**
 * Record an error as an OTel exception event (no user data).
 */
export function recordException(error: Error, componentName?: string): void {
  if (!sdkActive) return;

  const tracer = getTracer();
  const span = tracer.startSpan('error', {
    attributes: {
      component: componentName || 'unknown',
      'error.type': error.name,
      'error.message': error.message,
    },
  });
  span.recordException(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  span.end();
}

/**
 * Filter attributes to only include allowlisted keys.
 */
function filterAttributes(attrs?: Record<string, string>): Record<string, string> {
  if (!attrs) return {};
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (ALLOWED_ATTRIBUTES.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}
