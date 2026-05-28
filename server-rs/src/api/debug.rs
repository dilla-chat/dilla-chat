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
/// Advance past a CSI sequence body once the leading `ESC [` has been
/// consumed: skip parameter/intermediate bytes up to and including the
/// final byte (0x40..=0x7e). Extracted from `strip_ansi` to keep that
/// function's cognitive complexity below the rule threshold.
fn skip_csi_body(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) {
    for ch in chars.by_ref() {
        let v = ch as u32;
        if (0x40..=0x7e).contains(&v) {
            return;
        }
    }
}

/// Predicate for `strip_ansi`: keep printable chars + common whitespace,
/// drop other C0 controls.
fn is_keepable_char(c: char) -> bool {
    let v = c as u32;
    v >= 0x20 || c == '\n' || c == '\r' || c == '\t'
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{001b}' {
            // CSI sequence: ESC [ … <final byte in 0x40..=0x7e>.
            if chars.peek() == Some(&'[') {
                chars.next();
                skip_csi_body(&mut chars);
            }
            // Either way, drop the ESC and any swallowed sequence.
            continue;
        }
        if !is_keepable_char(c) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_ansi_removes_csi_sequences() {
        // Foreground red + reset.
        let input = "\u{001b}[31merror\u{001b}[0m text";
        assert_eq!(strip_ansi(input), "error text");
    }

    #[test]
    fn strip_ansi_drops_bare_esc() {
        let input = "before\u{001b}after";
        assert_eq!(strip_ansi(input), "beforeafter");
    }

    #[test]
    fn strip_ansi_drops_c0_controls_keeps_newline_cr_tab() {
        let input = "line1\nline2\rcontinue\twith\u{0001}bell";
        // 0x01 is dropped, \n \r \t survive.
        assert_eq!(strip_ansi(input), "line1\nline2\rcontinue\twithbell");
    }

    #[test]
    fn strip_ansi_passes_unicode_through() {
        assert_eq!(strip_ansi("héllo · 世界"), "héllo · 世界");
    }

    #[test]
    fn normalize_level_maps_known_strings() {
        assert_eq!(normalize_level("error"), "error");
        assert_eq!(normalize_level("ERROR"), "error");
        assert_eq!(normalize_level("warn"), "warn");
        assert_eq!(normalize_level("warning"), "warn");
        assert_eq!(normalize_level("debug"), "debug");
        // unknown → "info"
        assert_eq!(normalize_level("notice"), "info");
        assert_eq!(normalize_level("info"), "info");
        assert_eq!(normalize_level(""), "info");
    }

    #[test]
    fn truncate_under_limit_is_passthrough() {
        assert_eq!(truncate("short", 100), "short");
    }

    #[test]
    fn truncate_at_limit_is_passthrough() {
        let s = "x".repeat(10);
        assert_eq!(truncate(&s, 10), s);
    }

    #[test]
    fn truncate_over_limit_appends_marker() {
        let s = "x".repeat(20);
        let out = truncate(&s, 10);
        assert!(out.starts_with("xxxxxxxxxx"));
        assert!(out.ends_with("…[truncated]"));
    }

    #[test]
    fn truncate_respects_utf8_boundaries() {
        // 3-byte chars (each '世' is 3 bytes in UTF-8). Asking for max=4 must
        // cut at a boundary, not mid-codepoint.
        let s = "世界世界";
        let out = truncate(s, 4);
        // Result must be valid UTF-8 (the test itself reading it as &str
        // would panic if it weren't).
        assert!(out.starts_with('世'));
        assert!(out.ends_with("…[truncated]"));
    }

    #[test]
    fn truncate_tag_caps_at_max_tag_len() {
        let s = "x".repeat(MAX_TAG_LEN + 50);
        let out = truncate_tag(&s);
        // truncate_tag uses MAX_TAG_LEN; out is at-most that many chars
        // plus the marker suffix.
        assert!(out.contains("…[truncated]"));
    }

    // ── axum integration tests ──────────────────────────────────────

    use crate::api::AppState;
    use crate::auth::AuthService;
    use crate::config::Config;
    use crate::db::Database;
    use crate::presence::PresenceManager;
    use crate::ws::Hub;
    use axum::body::Body;
    use axum::http::Request;
    use axum::routing::post;
    use axum::Router;
    use std::sync::Arc;
    use tower::ServiceExt;

    fn make_state(browser_log_forward: bool) -> (AppState, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let database = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        database.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
        database.run_migrations().unwrap();
        let auth = Arc::new(AuthService::new(database.clone(), ""));
        let hub = Arc::new(Hub::new(database.clone()));
        let presence = Arc::new(PresenceManager::new());
        let mut cfg = Config::default();
        cfg.port = 8080;
        cfg.data_dir = tmp.path().to_str().unwrap().to_string();
        cfg.browser_log_forward = browser_log_forward;
        let state = AppState {
            db: database,
            auth,
            hub,
            presence,
            config: Arc::new(cfg),
            mesh: None,
            custom_theme_css: None,
        };
        (state, tmp)
    }

    #[tokio::test]
    async fn ingest_returns_204_when_browser_log_forward_disabled() {
        let (state, _tmp) = make_state(false);
        let app = Router::new()
            .route("/debug/browser-log", post(ingest))
            .with_state(state);
        let resp = app
            .oneshot(
                Request::post("/debug/browser-log")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"session":"abc","entries":[]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 204);
    }

    #[tokio::test]
    async fn ingest_rejects_malformed_json_when_enabled() {
        let (state, _tmp) = make_state(true);
        let app = Router::new()
            .route("/debug/browser-log", post(ingest))
            .with_state(state);
        let resp = app
            .oneshot(
                Request::post("/debug/browser-log")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{not json"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn ingest_accepts_valid_batch_when_enabled() {
        let (state, _tmp) = make_state(true);
        let app = Router::new()
            .route("/debug/browser-log", post(ingest))
            .with_state(state);
        let body = r#"{"session":"sess-1","entries":[{"level":"error","message":"oops"},{"level":"info","message":"hi"}]}"#;
        let resp = app
            .oneshot(
                Request::post("/debug/browser-log")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() < 400);
    }
}
