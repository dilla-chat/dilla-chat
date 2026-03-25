pub mod adapter;
pub mod sentry;

use adapter::{Breadcrumb, TelemetryAdapter, TelemetryEvent};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Per-user rate limiter with a rolling window.
struct RateLimiter {
    /// Max errors allowed per window.
    error_limit: usize,
    /// Max breadcrumbs allowed per window.
    breadcrumb_limit: usize,
    /// Window duration in seconds.
    window_secs: u64,
    /// Timestamps of recent errors per user.
    error_counts: Mutex<HashMap<String, Vec<u64>>>,
    /// Timestamps of recent breadcrumbs per user.
    breadcrumb_counts: Mutex<HashMap<String, Vec<u64>>>,
}

impl RateLimiter {
    fn new(error_limit: usize, breadcrumb_limit: usize, window_secs: u64) -> Self {
        Self {
            error_limit,
            breadcrumb_limit,
            window_secs,
            error_counts: Mutex::new(HashMap::new()),
            breadcrumb_counts: Mutex::new(HashMap::new()),
        }
    }

    /// Check and record an error event. Returns true if allowed.
    async fn check_error(&self, user_id: &str) -> bool {
        Self::check_and_record(
            &self.error_counts,
            user_id,
            self.error_limit,
            self.window_secs,
        )
        .await
    }

    /// Check and record a breadcrumb event. Returns true if allowed.
    async fn check_breadcrumb(&self, user_id: &str) -> bool {
        Self::check_and_record(
            &self.breadcrumb_counts,
            user_id,
            self.breadcrumb_limit,
            self.window_secs,
        )
        .await
    }

    async fn check_and_record(
        counts: &Mutex<HashMap<String, Vec<u64>>>,
        user_id: &str,
        limit: usize,
        window_secs: u64,
    ) -> bool {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let cutoff = now.saturating_sub(window_secs);

        let mut map = counts.lock().await;
        let timestamps = map.entry(user_id.to_string()).or_default();

        // Prune old entries outside the window.
        timestamps.retain(|&ts| ts > cutoff);

        if timestamps.len() >= limit {
            return false;
        }

        timestamps.push(now);
        true
    }
}

/// Server-side telemetry relay that rate-limits and forwards client events.
pub struct TelemetryRelay {
    adapter: Option<Arc<dyn TelemetryAdapter>>,
    rate_limiter: RateLimiter,
    server_name: String,
    release: String,
    environment: String,
}

impl TelemetryRelay {
    pub fn new(
        adapter: Option<Arc<dyn TelemetryAdapter>>,
        server_name: String,
        release: String,
        environment: String,
    ) -> Self {
        Self {
            adapter,
            rate_limiter: RateLimiter::new(10, 60, 60),
            server_name,
            release,
            environment,
        }
    }

    /// Enrich an error event with server context, rate-limit, and forward to adapter.
    pub async fn forward_error(&self, user_id: &str, mut event: TelemetryEvent) {
        if !self.rate_limiter.check_error(user_id).await {
            tracing::debug!(user_id, "telemetry error rate-limited");
            return;
        }

        // Enrich with server context.
        event.user_id = user_id.to_string();
        event.server_name = self.server_name.clone();
        event.release = self.release.clone();
        event.environment = self.environment.clone();

        if let Some(ref adapter) = self.adapter {
            if let Err(e) = adapter.forward(event).await {
                tracing::warn!(error = %e, "failed to forward telemetry event");
            }
        }
    }

    /// Rate-limit breadcrumb events. In v1 we don't forward breadcrumbs — only enforce limits.
    pub async fn forward_breadcrumb(&self, user_id: &str, _breadcrumb: Breadcrumb) {
        if !self.rate_limiter.check_breadcrumb(user_id).await {
            tracing::debug!(user_id, "telemetry breadcrumb rate-limited");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use adapter::ClientContext;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Mock adapter that counts forwarded events.
    struct MockAdapter {
        count: AtomicUsize,
    }

    impl MockAdapter {
        fn new() -> Self {
            Self {
                count: AtomicUsize::new(0),
            }
        }

        fn call_count(&self) -> usize {
            self.count.load(Ordering::SeqCst)
        }
    }

    #[async_trait::async_trait]
    impl TelemetryAdapter for MockAdapter {
        async fn forward(&self, _event: TelemetryEvent) -> Result<(), String> {
            self.count.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    fn test_event() -> TelemetryEvent {
        TelemetryEvent {
            level: "error".into(),
            message: "test".into(),
            stack: String::new(),
            tags: HashMap::new(),
            breadcrumbs: Vec::new(),
            context: ClientContext::default(),
            timestamp: 0,
            user_id: String::new(),
            server_name: String::new(),
            release: String::new(),
            environment: String::new(),
        }
    }

    #[tokio::test]
    async fn forwards_to_adapter() {
        let mock = Arc::new(MockAdapter::new());
        let relay = TelemetryRelay::new(
            Some(mock.clone() as Arc<dyn TelemetryAdapter>),
            "node-1".into(),
            "0.1.0".into(),
            "test".into(),
        );

        relay.forward_error("u1", test_event()).await;

        assert_eq!(mock.call_count(), 1);
    }

    #[tokio::test]
    async fn enriches_event_with_server_context() {
        /// Adapter that captures the last event.
        struct CapturingAdapter {
            last: Mutex<Option<TelemetryEvent>>,
        }

        #[async_trait::async_trait]
        impl TelemetryAdapter for CapturingAdapter {
            async fn forward(&self, event: TelemetryEvent) -> Result<(), String> {
                *self.last.lock().await = Some(event);
                Ok(())
            }
        }

        let cap = Arc::new(CapturingAdapter {
            last: Mutex::new(None),
        });
        let relay = TelemetryRelay::new(
            Some(cap.clone() as Arc<dyn TelemetryAdapter>),
            "node-1".into(),
            "0.1.0".into(),
            "production".into(),
        );

        relay.forward_error("user-42", test_event()).await;

        let captured = cap.last.lock().await;
        let evt = captured.as_ref().unwrap();
        assert_eq!(evt.user_id, "user-42");
        assert_eq!(evt.server_name, "node-1");
        assert_eq!(evt.release, "0.1.0");
        assert_eq!(evt.environment, "production");
    }

    #[tokio::test]
    async fn drops_when_no_adapter() {
        let relay = TelemetryRelay::new(None, "node-1".into(), "0.1.0".into(), "test".into());

        // Should not panic.
        relay.forward_error("u1", test_event()).await;
    }

    #[tokio::test]
    async fn rate_limits_errors() {
        let mock = Arc::new(MockAdapter::new());
        let relay = TelemetryRelay::new(
            Some(mock.clone() as Arc<dyn TelemetryAdapter>),
            "node-1".into(),
            "0.1.0".into(),
            "test".into(),
        );

        // Send 15 errors — only 10 should be forwarded (limit is 10/min).
        for _ in 0..15 {
            relay.forward_error("u1", test_event()).await;
        }

        assert_eq!(mock.call_count(), 10);
    }

    #[tokio::test]
    async fn rate_limits_are_per_user() {
        let mock = Arc::new(MockAdapter::new());
        let relay = TelemetryRelay::new(
            Some(mock.clone() as Arc<dyn TelemetryAdapter>),
            "node-1".into(),
            "0.1.0".into(),
            "test".into(),
        );

        // Each user gets their own 10/min allowance.
        for _ in 0..10 {
            relay.forward_error("u1", test_event()).await;
        }
        for _ in 0..10 {
            relay.forward_error("u2", test_event()).await;
        }

        assert_eq!(mock.call_count(), 20);
    }

    #[tokio::test]
    async fn breadcrumb_does_not_panic() {
        let relay = TelemetryRelay::new(None, "node-1".into(), "0.1.0".into(), "test".into());

        relay
            .forward_breadcrumb(
                "u1",
                Breadcrumb {
                    crumb_type: "nav".into(),
                    message: "test".into(),
                    data: serde_json::json!({}),
                    ts: 0,
                },
            )
            .await;
    }
}
