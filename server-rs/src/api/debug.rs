// Debug-time relay for browser-side console output.
//
// The client batches `console.{log,info,warn,error}` calls and POSTs
// them here; each entry is printed via `tracing::info!` with
// target="browser" so it interleaves with the server's own log
// stream. Useful when iterating on WebRTC/SDP flow where the
// interesting state lives in the browser but you want one tail to
// read.
//
// Gating: enabled only when `Config::browser_log_forward` is true.
// When disabled the route still exists but returns 204 immediately,
// so the client can fire-and-forget without conditionals.

use axum::{extract::State, http::StatusCode, Json};
use serde::Deserialize;
use serde_json::json;

use crate::api::AppState;
use crate::error::AppError;

const MAX_ENTRIES_PER_BATCH: usize = 100;
const MAX_MESSAGE_LEN: usize = 4096;
const MAX_TAG_LEN: usize = 64;

#[derive(Debug, Deserialize)]
pub struct BrowserLogEntry {
    pub level: String,
    pub message: String,
    /// Browser timestamp in milliseconds since epoch. Accepted from
    /// the client for future ordering work; the server currently
    /// trusts its own receive-order timestamp on the tracing line.
    #[serde(default, rename = "ts")]
    #[allow(dead_code)]
    pub _ts: Option<u64>,
    /// Optional per-entry tag (e.g. "WebRTC", "WS") so logs are scannable.
    #[serde(default)]
    pub tag: Option<String>,
    /// Optional user identifier the client populates after login.
    #[serde(default)]
    pub user: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct BrowserLogBatch {
    pub entries: Vec<BrowserLogEntry>,
    /// Per-session identifier the client generates once on page load
    /// — lets you tell different browser tabs apart in the server log.
    #[serde(default)]
    pub session: Option<String>,
}

pub async fn ingest(
    State(state): State<AppState>,
    Json(body): Json<BrowserLogBatch>,
) -> Result<(StatusCode, Json<serde_json::Value>), AppError> {
    if !state.config.browser_log_forward {
        return Ok((StatusCode::NO_CONTENT, Json(json!({}))));
    }

    let session = body
        .session
        .as_deref()
        .map(truncate_tag)
        .unwrap_or_else(|| "-".to_string());

    let mut accepted = 0usize;
    for entry in body.entries.into_iter().take(MAX_ENTRIES_PER_BATCH) {
        let level = normalize_level(&entry.level);
        let tag = entry.tag.as_deref().map(truncate_tag);
        let user = entry.user.as_deref().map(truncate_tag);
        let message = truncate(&entry.message, MAX_MESSAGE_LEN);

        // One log line per entry, prefixed so it's grep-friendly. The
        // `target="browser"` lets you filter via RUST_LOG=browser=info
        // if the volume gets noisy.
        match level {
            "error" => tracing::error!(
                target: "browser",
                session = %session,
                tag = tag.as_deref().unwrap_or("-"),
                user = user.as_deref().unwrap_or("-"),
                "{}", message
            ),
            "warn" => tracing::warn!(
                target: "browser",
                session = %session,
                tag = tag.as_deref().unwrap_or("-"),
                user = user.as_deref().unwrap_or("-"),
                "{}", message
            ),
            "debug" => tracing::debug!(
                target: "browser",
                session = %session,
                tag = tag.as_deref().unwrap_or("-"),
                user = user.as_deref().unwrap_or("-"),
                "{}", message
            ),
            _ => tracing::info!(
                target: "browser",
                session = %session,
                tag = tag.as_deref().unwrap_or("-"),
                user = user.as_deref().unwrap_or("-"),
                "{}", message
            ),
        }
        accepted += 1;
    }

    Ok((StatusCode::OK, Json(json!({ "accepted": accepted }))))
}

fn normalize_level(raw: &str) -> &'static str {
    match raw.to_ascii_lowercase().as_str() {
        "error" => "error",
        "warn" | "warning" => "warn",
        "debug" => "debug",
        _ => "info",
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        // char_indices keeps us off a UTF-8 byte boundary
        let cut = s
            .char_indices()
            .take_while(|(i, _)| *i < max)
            .last()
            .map(|(i, c)| i + c.len_utf8())
            .unwrap_or(0);
        let mut out = s[..cut].to_string();
        out.push_str("…[truncated]");
        out
    }
}

fn truncate_tag(s: &str) -> String {
    truncate(s, MAX_TAG_LEN)
}
