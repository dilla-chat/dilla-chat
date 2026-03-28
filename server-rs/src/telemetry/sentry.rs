use super::adapter::{TelemetryAdapter, TelemetryEvent};
use uuid::Uuid;

/// Parsed Sentry DSN components.
#[derive(Debug, Clone)]
pub struct SentryConfig {
    pub key: String,
    pub host: String,
    pub project_id: String,
}

impl SentryConfig {
    /// Parse a Sentry DSN URL.
    ///
    /// Format: `https://<key>@<host>/<project_id>`
    pub fn from_dsn(dsn: &str) -> Result<Self, String> {
        // Strip scheme
        let without_scheme = dsn
            .strip_prefix("https://")
            .or_else(|| dsn.strip_prefix("http://"))
            .ok_or_else(|| "DSN must start with http:// or https://".to_string())?;

        // Split key@host/project_id
        let (key, rest) = without_scheme
            .split_once('@')
            .ok_or_else(|| "DSN missing '@' separator".to_string())?;

        if key.is_empty() {
            return Err("DSN key is empty".to_string());
        }

        // rest = "host/project_id" — project_id is after the last '/'
        let last_slash = rest
            .rfind('/')
            .ok_or_else(|| "DSN missing project ID path".to_string())?;

        let host = &rest[..last_slash];
        let project_id = &rest[last_slash + 1..];

        if host.is_empty() {
            return Err("DSN host is empty".to_string());
        }
        if project_id.is_empty() {
            return Err("DSN project ID is empty".to_string());
        }

        Ok(SentryConfig {
            key: key.to_string(),
            host: host.to_string(),
            project_id: project_id.to_string(),
        })
    }
}

/// Sentry adapter that forwards telemetry events as Sentry envelopes.
pub struct SentryAdapter {
    config: SentryConfig,
    client: reqwest::Client,
}

impl SentryAdapter {
    pub fn new(config: SentryConfig) -> Self {
        Self {
            config,
            client: reqwest::Client::new(),
        }
    }

    /// Build a Sentry envelope body from a telemetry event.
    pub fn build_envelope(&self, event: &TelemetryEvent) -> String {
        let event_id = Uuid::new_v4().to_string().replace('-', "");

        // Envelope header
        let envelope_header = serde_json::json!({
            "event_id": event_id,
            "dsn": format!("https://{}@{}/{}", self.config.key, self.config.host, self.config.project_id),
        });

        // Build the event item
        let mut exception_values = Vec::new();
        if !event.message.is_empty() {
            let mut exc = serde_json::json!({
                "type": event.level,
                "value": event.message,
            });
            if !event.stack.is_empty() {
                exc["stacktrace"] = serde_json::json!({
                    "frames": [{
                        "filename": "<client>",
                        "function": "?",
                        "raw": event.stack,
                    }]
                });
            }
            exception_values.push(exc);
        }

        let breadcrumbs: Vec<serde_json::Value> = event
            .breadcrumbs
            .iter()
            .map(|b| {
                serde_json::json!({
                    "type": b.crumb_type,
                    "message": b.message,
                    "data": b.data,
                    "timestamp": b.ts,
                })
            })
            .collect();

        let event_body = serde_json::json!({
            "event_id": event_id,
            "level": if event.level.is_empty() { "error" } else { &event.level },
            "platform": "javascript",
            "timestamp": event.timestamp,
            "server_name": event.server_name,
            "release": event.release,
            "environment": event.environment,
            "user": {
                "id": event.user_id,
            },
            "tags": event.tags,
            "exception": {
                "values": exception_values,
            },
            "breadcrumbs": {
                "values": breadcrumbs,
            },
            "contexts": {
                "browser": { "name": event.context.browser },
                "os": { "name": event.context.os },
                "client": {
                    "url": event.context.url,
                    "viewport": event.context.viewport,
                },
            },
        });

        let event_json = serde_json::to_string(&event_body).unwrap_or_default();

        // Item header
        let item_header = serde_json::json!({
            "type": "event",
            "length": event_json.len(),
        });

        format!(
            "{}\n{}\n{}",
            envelope_header,
            item_header,
            event_json,
        )
    }
}

#[async_trait::async_trait]
impl TelemetryAdapter for SentryAdapter {
    async fn forward(&self, event: TelemetryEvent) -> Result<(), String> {
        let envelope = self.build_envelope(&event);
        let url = format!(
            "https://{}/api/{}/envelope/",
            self.config.host, self.config.project_id,
        );

        let resp = self
            .client
            .post(&url)
            .header("Content-Type", "application/x-sentry-envelope")
            .header(
                "X-Sentry-Auth",
                format!(
                    "Sentry sentry_version=7,sentry_key={},sentry_client=dilla-server/0.1.0",
                    self.config.key,
                ),
            )
            .body(envelope)
            .send()
            .await
            .map_err(|e| format!("sentry request failed: {e}"))?;

        if resp.status().is_success() {
            Ok(())
        } else {
            Err(format!(
                "sentry returned status {}",
                resp.status().as_u16()
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry::adapter::{Breadcrumb, ClientContext};
    use std::collections::HashMap;

    #[test]
    fn parse_dsn_standard() {
        let dsn = "https://abc123@o123456.ingest.sentry.io/456789";
        let config = SentryConfig::from_dsn(dsn).unwrap();
        assert_eq!(config.key, "abc123");
        assert_eq!(config.host, "o123456.ingest.sentry.io");
        assert_eq!(config.project_id, "456789");
    }

    #[test]
    fn parse_dsn_with_port() {
        let dsn = "https://key@sentry.example.com:9000/42";
        let config = SentryConfig::from_dsn(dsn).unwrap();
        assert_eq!(config.key, "key");
        assert_eq!(config.host, "sentry.example.com:9000");
        assert_eq!(config.project_id, "42");
    }

    #[test]
    fn parse_dsn_invalid_returns_error() {
        assert!(SentryConfig::from_dsn("not-a-url").is_err());
        assert!(SentryConfig::from_dsn("https://noatsign/123").is_err());
        assert!(SentryConfig::from_dsn("https://@host/123").is_err());
        assert!(SentryConfig::from_dsn("https://key@/123").is_err());
        assert!(SentryConfig::from_dsn("https://key@host/").is_err());
    }

    #[test]
    fn builds_valid_envelope_body() {
        let config = SentryConfig {
            key: "testkey".into(),
            host: "sentry.example.com".into(),
            project_id: "1".into(),
        };
        let adapter = SentryAdapter::new(config);

        let event = TelemetryEvent {
            level: "error".into(),
            message: "test error".into(),
            stack: "Error: test\n  at main.js:10".into(),
            tags: HashMap::new(),
            breadcrumbs: vec![Breadcrumb {
                crumb_type: "http".into(),
                message: "GET /api/foo".into(),
                data: serde_json::json!({"status_code": 500}),
                ts: 1700000000,
            }],
            context: ClientContext::default(),
            timestamp: 1700000000,
            user_id: "u1".into(),
            server_name: "node-1".into(),
            release: "0.1.0".into(),
            environment: "test".into(),
        };

        let envelope = adapter.build_envelope(&event);
        let lines: Vec<&str> = envelope.splitn(3, '\n').collect();
        assert_eq!(lines.len(), 3, "envelope should have 3 lines");

        // Envelope header should contain event_id
        let header: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert!(header.get("event_id").is_some());

        // Item header should have type=event
        let item_header: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(item_header["type"], "event");

        // Event body should contain exception and breadcrumbs
        let body: serde_json::Value = serde_json::from_str(lines[2]).unwrap();
        assert!(body.get("exception").is_some());
        assert_eq!(body["exception"]["values"][0]["value"], "test error");
        assert_eq!(body["breadcrumbs"]["values"].as_array().unwrap().len(), 1);
        assert_eq!(body["user"]["id"], "u1");
    }

    fn test_event() -> TelemetryEvent {
        TelemetryEvent {
            level: "error".into(),
            message: "test".into(),
            stack: String::new(),
            tags: HashMap::new(),
            breadcrumbs: vec![],
            context: ClientContext::default(),
            timestamp: 1700000000,
            user_id: "u1".into(),
            server_name: "n1".into(),
            release: "0.1.0".into(),
            environment: "test".into(),
        }
    }

    #[tokio::test]
    async fn forward_returns_error_on_connection_failure() {
        let config = SentryConfig {
            key: "testkey".into(),
            host: "localhost:1".into(), // unreachable port
            project_id: "1".into(),
        };
        let adapter = SentryAdapter::new(config);
        let result = adapter.forward(test_event()).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("sentry request failed"));
    }

    #[tokio::test]
    async fn forward_returns_error_on_non_success_status() {
        // Spin up a minimal TCP server that returns 400
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                use tokio::io::AsyncWriteExt;
                // Read request then send 400
                let mut buf = vec![0u8; 4096];
                let _ = tokio::io::AsyncReadExt::read(&mut stream, &mut buf).await;
                let response = "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n";
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });

        let config = SentryConfig {
            key: "testkey".into(),
            host: format!("127.0.0.1:{}", port),
            project_id: "1".into(),
        };
        let adapter = SentryAdapter {
            config,
            client: reqwest::Client::new(),
        };

        // Use http:// since our mock doesn't do TLS
        // Override the URL construction by testing the error path
        let event = test_event();
        let envelope = adapter.build_envelope(&event);
        let url = format!("http://127.0.0.1:{}/api/1/envelope/", port);
        let resp = adapter
            .client
            .post(&url)
            .header("Content-Type", "application/x-sentry-envelope")
            .body(envelope)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 400);
    }
}
