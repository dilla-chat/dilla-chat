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

use axum::{extract::{Request, State}, http::StatusCode, Json};
use serde::Deserialize;
use serde_json::json;

use crate::api::AppState;
use crate::error::AppError;

const MAX_ENTRIES_PER_BATCH: usize = 100;
const MAX_MESSAGE_LEN: usize = 4096;
const MAX_TAG_LEN: usize = 64;

/// Strip ANSI escape sequences and most C0 control chars from a string.
/// H8 / VULN-010: the browser-log relay is the only path a non-server
/// actor can write into the server's tracing stream — without this, a
/// hostile browser could inject color codes / cursor-moves that confuse
/// log viewers or hide payload content. Operates on the char iterator
/// so multi-byte UTF-8 survives intact.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{001b}' {
            // CSI sequence: ESC [ … <final byte in 0x40..=0x7e>.
            if chars.peek() == Some(&'[') {
                chars.next();
                for ch in chars.by_ref() {
                    let v = ch as u32;
                    if (0x40..=0x7e).contains(&v) {
                        break;
                    }
                }
                continue;
            }
            // Bare ESC — drop.
            continue;
        }
        let v = c as u32;
        // Drop other C0 control chars except common whitespace.
        if v < 0x20 && c != '\n' && c != '\r' && c != '\t' {
            continue;
        }
        out.push(c);
    }
    out
}

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
    req: Request,
) -> Result<(StatusCode, Json<serde_json::Value>), AppError> {
    if !state.config.browser_log_forward {
        // Drain the body to avoid leaving the socket in an awkward
        // state, then 204.
        let _ = axum::body::to_bytes(req.into_body(), 1024 * 1024).await;
        return Ok((StatusCode::NO_CONTENT, Json(json!({}))));
    }

    // H8 / VULN-010: when the caller carries a valid Bearer token,
    // attach the user_id to every log span. When the token is absent or
    // invalid, still accept the batch but mark it
    // `unauthenticated_browser_log=true` so log searches can filter.
    let auth_user_id = extract_auth_user_id(&state, &req);

    let body_bytes = axum::body::to_bytes(req.into_body(), 1024 * 1024)
        .await
        .map_err(|e| AppError::BadRequest(format!("body read: {}", e)))?;
    let body: BrowserLogBatch = serde_json::from_slice(&body_bytes)
        .map_err(|e| AppError::BadRequest(format!("invalid JSON: {}", e)))?;

    let session = body
        .session
        .as_deref()
        .map(|s| truncate_tag(&strip_ansi(s)))
        .unwrap_or_else(|| "-".to_string());

    let unauthenticated = auth_user_id.is_none();

    let mut accepted = 0usize;
    for entry in body.entries.into_iter().take(MAX_ENTRIES_PER_BATCH) {
        let level = normalize_level(&entry.level);
        let tag = entry
            .tag
            .as_deref()
            .map(|s| truncate_tag(&strip_ansi(s)));
        let user_from_client = entry
            .user
            .as_deref()
            .map(|s| truncate_tag(&strip_ansi(s)));
        // Prefer the JWT-verified user_id over the client-supplied one
        // — the client field is operator-trusted at best, attacker-
        // controlled at worst.
        let user = auth_user_id
            .clone()
            .or(user_from_client)
            .unwrap_or_else(|| "-".to_string());
        let message = strip_ansi(&entry.message);
        let message = truncate(&message, MAX_MESSAGE_LEN);

        // One log line per entry, prefixed so it's grep-friendly. The
        // `target="browser"` lets you filter via RUST_LOG=browser=info
        // if the volume gets noisy.
        match level {
            "error" => tracing::error!(
                target: "browser",
                session = %session,
                tag = tag.as_deref().unwrap_or("-"),
                user = %user,
                unauthenticated_browser_log = unauthenticated,
                "{}", message
            ),
            "warn" => tracing::warn!(
                target: "browser",
                session = %session,
                tag = tag.as_deref().unwrap_or("-"),
                user = %user,
                unauthenticated_browser_log = unauthenticated,
                "{}", message
            ),
            "debug" => tracing::debug!(
                target: "browser",
                session = %session,
                tag = tag.as_deref().unwrap_or("-"),
                user = %user,
                unauthenticated_browser_log = unauthenticated,
                "{}", message
            ),
            _ => tracing::info!(
                target: "browser",
                session = %session,
                tag = tag.as_deref().unwrap_or("-"),
                user = %user,
                unauthenticated_browser_log = unauthenticated,
                "{}", message
            ),
        }
        accepted += 1;
    }

    Ok((StatusCode::OK, Json(json!({ "accepted": accepted }))))
}

/// Return the JWT subject (user_id) when the incoming request carries
/// a valid `Authorization: Bearer …` header. Soft-fails to None so the
/// public route still accepts pre-login logs.
fn extract_auth_user_id(state: &AppState, req: &Request) -> Option<String> {
    let token = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())?
        .strip_prefix("Bearer ")?;
    state.auth.validate_jwt(token).ok()
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
