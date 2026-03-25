use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// A breadcrumb captured by the client before an error occurred.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Breadcrumb {
    #[serde(rename = "type", default)]
    pub crumb_type: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub data: serde_json::Value,
    #[serde(default)]
    pub ts: u64,
}

/// Browser / OS context sent by the client.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ClientContext {
    #[serde(default)]
    pub browser: String,
    #[serde(default)]
    pub os: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub viewport: String,
}

/// A telemetry event received from a client, enriched with server-side metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetryEvent {
    #[serde(default)]
    pub level: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub stack: String,
    #[serde(default)]
    pub tags: HashMap<String, String>,
    #[serde(default)]
    pub breadcrumbs: Vec<Breadcrumb>,
    #[serde(default)]
    pub context: ClientContext,
    #[serde(default)]
    pub timestamp: u64,

    // Server-enriched fields
    #[serde(default)]
    pub user_id: String,
    #[serde(default)]
    pub server_name: String,
    #[serde(default)]
    pub release: String,
    #[serde(default)]
    pub environment: String,
}

/// Trait for forwarding telemetry events to an external service.
#[async_trait::async_trait]
pub trait TelemetryAdapter: Send + Sync {
    async fn forward(&self, event: TelemetryEvent) -> Result<(), String>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn breadcrumb_deserializes_with_defaults() {
        let json = r#"{}"#;
        let b: Breadcrumb = serde_json::from_str(json).unwrap();
        assert_eq!(b.crumb_type, "");
        assert_eq!(b.message, "");
        assert_eq!(b.ts, 0);
    }

    #[test]
    fn client_context_default_is_empty() {
        let ctx = ClientContext::default();
        assert_eq!(ctx.browser, "");
        assert_eq!(ctx.os, "");
        assert_eq!(ctx.url, "");
        assert_eq!(ctx.viewport, "");
    }

    #[test]
    fn telemetry_event_round_trips() {
        let mut tags = HashMap::new();
        tags.insert("page".to_string(), "/home".to_string());

        let event = TelemetryEvent {
            level: "error".into(),
            message: "something broke".into(),
            stack: "Error: something broke\n  at foo.js:1".into(),
            tags,
            breadcrumbs: vec![Breadcrumb {
                crumb_type: "navigation".into(),
                message: "navigated to /home".into(),
                data: serde_json::json!({}),
                ts: 1234567890,
            }],
            context: ClientContext {
                browser: "Chrome 120".into(),
                os: "macOS".into(),
                url: "https://example.com".into(),
                viewport: "1920x1080".into(),
            },
            timestamp: 1234567890,
            user_id: "u1".into(),
            server_name: "node-1".into(),
            release: "0.1.0".into(),
            environment: "production".into(),
        };

        let json = serde_json::to_string(&event).unwrap();
        let parsed: TelemetryEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.level, "error");
        assert_eq!(parsed.message, "something broke");
        assert_eq!(parsed.user_id, "u1");
        assert_eq!(parsed.breadcrumbs.len(), 1);
    }
}
