// Observability module — OpenTelemetry tracing, metrics, and HTTP middleware.
//
// Port of the Go observability package. Provides:
// - Structured logging (tracing-subscriber)
// - OTel trace + metric providers (OTLP/HTTP export)
// - Pre-created metric instruments for HTTP, WebSocket, DB, federation, voice
// - Axum middleware layer for request tracing + metrics

use crate::config::Config;

use axum::{
    extract::Request,
    http::header,
    middleware::Next,
    response::Response,
};
use opentelemetry::{
    global,
    trace::{TraceContextExt, Tracer},
    Context as OtelContext, KeyValue,
};
use opentelemetry_sdk::{
    metrics::{PeriodicReader, SdkMeterProvider},
    trace::SdkTracerProvider,
    Resource,
};
use std::sync::Arc;
use std::time::Instant;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/// Initialize the tracing-subscriber logging layer.
/// Respects `config.log_level` and `config.log_format` ("json" or "text").
pub fn init_logging(config: &Config) {
    use tracing_subscriber::{fmt, EnvFilter};

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(&config.log_level));

    if config.log_format == "json" {
        fmt().with_env_filter(filter).json().init();
    } else {
        fmt().with_env_filter(filter).init();
    }
}

// ---------------------------------------------------------------------------
// OTel providers
// ---------------------------------------------------------------------------

/// Holds optional OTel tracer and meter providers.
/// When OTel is disabled, both fields are `None` and global providers are
/// noops — zero overhead.
#[allow(dead_code)]
pub struct OtelProviders {
    pub tracer_provider: Option<SdkTracerProvider>,
    pub meter_provider: Option<SdkMeterProvider>,
}

#[allow(dead_code)]
impl OtelProviders {
    /// Flush and shut down all providers. Call on graceful shutdown.
    pub fn shutdown(&self) {
        if let Some(ref tp) = self.tracer_provider {
            if let Err(e) = tp.shutdown() {
                tracing::error!("otel trace shutdown error: {}", e);
            }
        }
        if let Some(ref mp) = self.meter_provider {
            if let Err(e) = mp.shutdown() {
                tracing::error!("otel metric shutdown error: {}", e);
            }
        }
    }
}

/// Initialise OTel trace and metric providers.
///
/// Returns empty (noop) providers when `config.otel_enabled` is false.
/// Uses OTLP/HTTP exporter pointed at `config.otel_http_endpoint` (falls back
/// to `config.otel_endpoint`).
/// HTTP client wrapper that runs reqwest on the Tokio runtime so it works
/// inside the batch processor's non-Tokio thread.
#[derive(Debug, Clone)]
struct TokioHttpClient {
    inner: reqwest::Client,
    handle: tokio::runtime::Handle,
}

impl TokioHttpClient {
    async fn do_send(
        client: reqwest::Client,
        request: http::Request<bytes::Bytes>,
    ) -> Result<http::Response<bytes::Bytes>, opentelemetry_http::HttpError> {
        let (parts, body) = request.into_parts();
        let req = http::Request::from_parts(parts, body.to_vec());
        let req: reqwest::Request = req.try_into()?;
        let resp = client.execute(req).await?;
        let status = resp.status();
        let headers = resp.headers().clone();
        let body = resp.bytes().await?;
        let mut http_resp = http::Response::builder().status(status);
        for (k, v) in headers.iter() {
            http_resp = http_resp.header(k, v);
        }
        Ok(http_resp.body(body)?)
    }
}

#[async_trait::async_trait]
impl opentelemetry_http::HttpClient for TokioHttpClient {
    async fn send(
        &self,
        request: http::Request<Vec<u8>>,
    ) -> Result<http::Response<bytes::Bytes>, opentelemetry_http::HttpError> {
        let (parts, body) = request.into_parts();
        let bytes_req = http::Request::from_parts(parts, bytes::Bytes::from(body));
        let client = self.inner.clone();
        let handle = self.handle.clone();
        handle.spawn(Self::do_send(client, bytes_req)).await.unwrap()
    }

    async fn send_bytes(
        &self,
        request: http::Request<bytes::Bytes>,
    ) -> Result<http::Response<bytes::Bytes>, opentelemetry_http::HttpError> {
        let client = self.inner.clone();
        let handle = self.handle.clone();
        handle.spawn(Self::do_send(client, request)).await.unwrap()
    }
}

#[allow(dead_code)]
pub fn init_otel(config: &Config) -> Result<OtelProviders, Box<dyn std::error::Error>> {
    use opentelemetry_otlp::{WithExportConfig, WithHttpConfig};

    if !config.otel_enabled {
        tracing::info!("observability: OTel disabled");
        return Ok(OtelProviders {
            tracer_provider: None,
            meter_provider: None,
        });
    }

    let service_name = if config.otel_service_name.is_empty() {
        "dilla-server".to_string()
    } else {
        config.otel_service_name.clone()
    };

    let resource = Resource::builder()
        .with_attributes(vec![
            KeyValue::new("service.name", service_name.clone()),
            KeyValue::new("service.version", env!("CARGO_PKG_VERSION").to_string()),
        ])
        .build();

    let endpoint = if !config.otel_http_endpoint.is_empty() {
        config.otel_http_endpoint.clone()
    } else {
        config.otel_endpoint.clone()
    };

    let full_endpoint = format!(
        "{}://{}",
        if config.otel_insecure { "http" } else { "https" },
        endpoint
    );

    // Build auth headers if configured.
    let mut headers = std::collections::HashMap::new();
    if !config.otel_api_key.is_empty() && !config.otel_api_header.is_empty() {
        headers.insert(
            config.otel_api_header.clone(),
            config.otel_api_key.clone(),
        );
    }

    // Build a Tokio-aware HTTP client so reqwest works in batch processor threads.
    let http_client = TokioHttpClient {
        inner: reqwest::Client::new(),
        handle: tokio::runtime::Handle::current(),
    };

    // --- Trace exporter (OTLP/HTTP) ---
    let trace_endpoint = format!("{}/v1/traces", full_endpoint);
    let mut trace_builder = opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .with_http_client(http_client)
        .with_endpoint(&trace_endpoint);

    if !headers.is_empty() {
        trace_builder = trace_builder.with_headers(headers.clone());
    }

    let trace_exporter = trace_builder.build()?;

    // Use a Tokio-aware batch config by entering the runtime handle
    // before building the provider (reqwest needs a Tokio reactor).
    let tracer_provider = SdkTracerProvider::builder()
        .with_batch_exporter(trace_exporter)
        .with_resource(resource.clone())
        .build();

    global::set_tracer_provider(tracer_provider.clone());

    // Set composite propagator (TraceContext + Baggage).
    global::set_text_map_propagator(
        opentelemetry_sdk::propagation::TraceContextPropagator::new(),
    );

    // --- Metric exporter (OTLP/HTTP) ---
    let metric_http_client = TokioHttpClient {
        inner: reqwest::Client::new(),
        handle: tokio::runtime::Handle::current(),
    };
    let metric_endpoint = format!("{}/v1/metrics", full_endpoint);
    let mut metric_builder = opentelemetry_otlp::MetricExporter::builder()
        .with_http()
        .with_http_client(metric_http_client)
        .with_endpoint(&metric_endpoint);

    if !headers.is_empty() {
        metric_builder = metric_builder.with_headers(headers);
    }

    let metric_exporter = metric_builder.build()?;

    let reader = PeriodicReader::builder(metric_exporter)
        .build();

    let meter_provider = SdkMeterProvider::builder()
        .with_reader(reader)
        .with_resource(resource)
        .build();

    global::set_meter_provider(meter_provider.clone());

    let scheme = if config.otel_insecure { "http" } else { "https" };
    tracing::info!(
        protocol = "http",
        endpoint = format!("{}://{}", scheme, endpoint),
        service = %service_name,
        "observability: OTel enabled"
    );

    // Emit a test span to verify the pipeline works end-to-end.
    {
        use opentelemetry::trace::{TracerProvider, Tracer, Span};
        let test_tracer = tracer_provider.tracer("dilla-server-init");
        let mut test_span = test_tracer.start("otel-init-test");
        test_span.set_attribute(KeyValue::new("test", "init"));
        test_span.end();
        tracing::info!("emitted test span via provider to verify OTel pipeline");
    }

    Ok(OtelProviders {
        tracer_provider: Some(tracer_provider),
        meter_provider: Some(meter_provider),
    })
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/// Pre-created metric instruments for the entire server.
/// When OTel is disabled the global meter is a noop — all calls are zero-cost.
#[derive(Clone)]
#[allow(dead_code)]
pub struct Metrics {
    // HTTP
    pub http_request_duration: opentelemetry::metrics::Histogram<f64>,
    pub http_requests_total: opentelemetry::metrics::Counter<u64>,
    pub http_active_requests: opentelemetry::metrics::UpDownCounter<i64>,

    // WebSocket
    pub ws_active_connections: opentelemetry::metrics::UpDownCounter<i64>,
    pub ws_messages_total: opentelemetry::metrics::Counter<u64>,

    // Database
    pub db_query_duration: opentelemetry::metrics::Histogram<f64>,
    pub db_query_total: opentelemetry::metrics::Counter<u64>,

    // Federation
    pub fed_peers_connected: opentelemetry::metrics::UpDownCounter<i64>,
    pub fed_sync_total: opentelemetry::metrics::Counter<u64>,

    // Voice
    pub voice_rooms_active: opentelemetry::metrics::UpDownCounter<i64>,
    pub voice_participants: opentelemetry::metrics::UpDownCounter<i64>,
}

#[allow(dead_code)]
impl Metrics {
    /// Create all instruments from the global meter provider.
    pub fn new() -> Self {
        let meter = global::meter("dilla-server");

        let http_request_duration = meter
            .f64_histogram("http.server.request.duration")
            .with_description("HTTP request duration in milliseconds")
            .with_unit("ms")
            .build();

        let http_requests_total = meter
            .u64_counter("http.server.requests.total")
            .with_description("Total HTTP requests")
            .build();

        let http_active_requests = meter
            .i64_up_down_counter("http.server.active_requests")
            .with_description("Number of active HTTP requests")
            .build();

        let ws_active_connections = meter
            .i64_up_down_counter("ws.connections.active")
            .with_description("Number of active WebSocket connections")
            .build();

        let ws_messages_total = meter
            .u64_counter("ws.messages.total")
            .with_description("Total WebSocket messages")
            .build();

        let db_query_duration = meter
            .f64_histogram("db.query.duration")
            .with_description("Database query duration in milliseconds")
            .with_unit("ms")
            .build();

        let db_query_total = meter
            .u64_counter("db.query.total")
            .with_description("Total database queries")
            .build();

        let fed_peers_connected = meter
            .i64_up_down_counter("federation.peers.connected")
            .with_description("Number of connected federation peers")
            .build();

        let fed_sync_total = meter
            .u64_counter("federation.sync.total")
            .with_description("Total federation sync operations")
            .build();

        let voice_rooms_active = meter
            .i64_up_down_counter("voice.rooms.active")
            .with_description("Number of active voice rooms")
            .build();

        let voice_participants = meter
            .i64_up_down_counter("voice.participants")
            .with_description("Number of voice participants")
            .build();

        Metrics {
            http_request_duration,
            http_requests_total,
            http_active_requests,
            ws_active_connections,
            ws_messages_total,
            db_query_duration,
            db_query_total,
            fed_peers_connected,
            fed_sync_total,
            voice_rooms_active,
            voice_participants,
        }
    }
}

// ---------------------------------------------------------------------------
// Route sanitisation
// ---------------------------------------------------------------------------

/// Replace UUID path segments with `{id}` to prevent high-cardinality metric
/// labels. Matches the standard 8-4-4-4-12 hex pattern.
#[allow(dead_code)]
pub fn sanitize_route(path: &str) -> String {
    use std::sync::LazyLock;
    static UUID_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
        )
        .unwrap()
    });
    UUID_RE.replace_all(path, "{id}").into_owned()
}

// ---------------------------------------------------------------------------
// Axum HTTP middleware
// ---------------------------------------------------------------------------

/// Axum middleware that:
/// 1. Extracts incoming OTel trace context from request headers
/// 2. Starts a span named `"{METHOD} {sanitized_route}"`
/// 3. Records request duration, total requests, and active request gauge
/// 4. Logs each request with method, path, status, and duration_ms
///
/// Usage:
/// ```ignore
/// let metrics = Arc::new(Metrics::new());
/// let app = Router::new()
///     .route("/api/v1/health", get(health))
///     .layer(axum::middleware::from_fn_with_state(metrics, http_middleware));
/// ```
#[allow(dead_code)]
pub async fn http_middleware(
    axum::extract::State(metrics): axum::extract::State<Arc<Metrics>>,
    request: Request,
    next: Next,
) -> Response {
    let start = Instant::now();

    let method = request.method().to_string();
    let path = request.uri().path().to_string();
    let route = sanitize_route(&path);

    // Extract propagated trace context from request headers.
    let parent_cx = extract_context_from_request(&request);

    let tracer = global::tracer("dilla-server");
    let span = tracer
        .span_builder(format!("{} {}", method, route))
        .with_attributes(vec![
            KeyValue::new("http.method", method.clone()),
            KeyValue::new("http.route", route.clone()),
        ])
        .start_with_context(&tracer, &parent_cx);
    let cx = parent_cx.with_span(span);

    // Track active requests.
    let attrs = &[
        KeyValue::new("http.method", method.clone()),
        KeyValue::new("http.route", route.clone()),
    ];
    metrics.http_active_requests.add(1, attrs);

    let response = next.run(request).await;

    let duration_ms = start.elapsed().as_secs_f64() * 1000.0;
    let status = response.status().as_u16();

    let metric_attrs = &[
        KeyValue::new("http.method", method.clone()),
        KeyValue::new("http.route", route.clone()),
        KeyValue::new("http.status_code", status as i64),
    ];

    // Record span attributes and end.
    let span_ref = cx.span();
    span_ref.set_attribute(KeyValue::new("http.status_code", status as i64));
    span_ref.set_attribute(KeyValue::new("http.duration_ms", duration_ms));
    span_ref.end();

    // Record metrics.
    metrics.http_request_duration.record(duration_ms, metric_attrs);
    metrics.http_requests_total.add(1, metric_attrs);
    metrics.http_active_requests.add(-1, attrs);

    // Structured log.
    tracing::info!(
        method = %method,
        path = %path,
        status = %status,
        duration_ms = %format!("{:.2}", duration_ms),
        "request"
    );

    response
}

/// Extract OTel context from HTTP request headers using the global propagator.
#[allow(dead_code)]
fn extract_context_from_request(request: &Request) -> OtelContext {
    let extractor = HeaderExtractor(request.headers());
    global::get_text_map_propagator(|propagator| propagator.extract(&extractor))
}

/// Adapter to let the OTel propagator read from `axum::http::HeaderMap`.
#[allow(dead_code)]
struct HeaderExtractor<'a>(&'a header::HeaderMap);

impl opentelemetry::propagation::Extractor for HeaderExtractor<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(|v| v.to_str().ok())
    }

    fn keys(&self) -> Vec<&str> {
        self.0.keys().map(|k| k.as_str()).collect()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_route_replaces_uuids() {
        let input = "/api/v1/teams/550e8400-e29b-41d4-a716-446655440000/channels/6ba7b810-9dad-11d1-80b4-00c04fd430c8";
        let expected = "/api/v1/teams/{id}/channels/{id}";
        assert_eq!(sanitize_route(input), expected);
    }

    #[test]
    fn test_sanitize_route_no_uuids() {
        let input = "/api/v1/health";
        assert_eq!(sanitize_route(input), input);
    }

    #[test]
    fn test_sanitize_route_mixed() {
        let input = "/api/v1/users/a1b2c3d4-e5f6-7890-abcd-ef1234567890/messages";
        assert_eq!(sanitize_route(input), "/api/v1/users/{id}/messages");
    }

    #[test]
    fn test_metrics_creation() {
        // Metrics::new() should not panic with noop global provider.
        let _m = Metrics::new();
    }
}
