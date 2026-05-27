use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::api::helpers::{json_ok, json_ok_true, map_not_found, spawn_db};
use crate::api::AppState;
use crate::auth::UserId;
use crate::db;
use crate::error::AppError;
// A6: REST authz routes through the central policy module so every
// deny flows through one place. Same semantics as the prior
// `helpers::require_team_member` call sites.
use crate::policy::require_team_member;

#[derive(Deserialize)]
pub struct ListMessagesQuery {
    #[serde(default)]
    pub before: String,
    #[serde(default = "default_limit")]
    pub limit: i32,
}

fn default_limit() -> i32 {
    50
}

/// Server-side maximum page size for message / reaction / thread
/// listing. Clients may pass a larger `limit` query parameter but the
/// server silently clamps it. MSG-DOS-1 / H6.
pub(crate) const MAX_PAGE_LIMIT: i32 = 200;

#[derive(Deserialize)]
pub struct CreateMessageRequest {
    pub content: String,
    #[serde(rename = "type", default = "default_msg_type")]
    pub msg_type: String,
}

fn default_msg_type() -> String {
    "text".into()
}

#[derive(Deserialize)]
pub struct EditMessageRequest {
    pub content: String,
}

pub async fn list(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, channel_id)): Path<(String, String)>,
    Query(query): Query<ListMessagesQuery>,
) -> Result<Json<Value>, AppError> {
    // MSG-DOS-1 / H6: server-side cap on pagination — the client can
    // ask for any limit but we never return more than MAX_PAGE_LIMIT
    // rows per call regardless. The existing clamp(1, 100) already
    // limited list; widen to 200 to align with the other listing
    // endpoints but make it a *server* cap not a client suggestion.
    let limit = query.limit.clamp(1, MAX_PAGE_LIMIT);

    let enriched = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id, &team_id)?;
        // VULN-007: REST mirror of the WS-side check. user_can_access_channel
        // already short-circuits for the team owner and open channels.
        // InvalidParameterName → AppError::Forbidden via map_db_error.
        if !db::user_can_access_channel(conn, &user_id, &team_id, &channel_id)? {
            return Err(rusqlite::Error::InvalidParameterName(
                "channel access denied".into(),
            ));
        }
        let messages = db::get_messages_by_channel(conn, &channel_id, &query.before, limit)?;
        let enriched: Vec<serde_json::Value> = messages
            .into_iter()
            .map(|msg| {
                let attachments = db::get_message_attachments(conn, &msg.id)
                    .unwrap_or_default();
                let attachment_payloads: Vec<serde_json::Value> = attachments
                    .iter()
                    .map(|a| serde_json::json!({
                        "id": a.id,
                        "filename": String::from_utf8_lossy(&a.filename_encrypted),
                        "content_type": String::from_utf8_lossy(&a.content_type_encrypted),
                        "size": a.size,
                        "url": format!("/api/v1/teams/{}/attachments/{}", team_id, a.id),
                    }))
                    .collect();
                let mut val = serde_json::to_value(&msg).unwrap();
                val.as_object_mut().unwrap().insert(
                    "attachments".to_string(),
                    serde_json::json!(attachment_payloads),
                );
                val
            })
            .collect();
        Ok(enriched)
    })
    .await?;

    json_ok(enriched)
}

pub async fn create(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, channel_id)): Path<(String, String)>,
    Json(body): Json<CreateMessageRequest>,
) -> Result<Json<Value>, AppError> {
    if body.content.is_empty() {
        return Err(AppError::BadRequest("content is required".into()));
    }

    let msg = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id, &team_id)?;

        // Verify channel exists and belongs to team.
        let channel = db::get_channel_by_id(conn, &channel_id)?;
        match channel {
            Some(ch) if ch.team_id == team_id => {}
            _ => {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
        }

        // VULN-007: per-channel ACL — don't 404 (leaks existence),
        // map to 403 via InvalidParameterName.
        if !db::user_can_access_channel(conn, &user_id, &team_id, &channel_id)? {
            return Err(rusqlite::Error::InvalidParameterName(
                "channel access denied".into(),
            ));
        }

        let now = db::now_str();
        let msg = db::Message {
            id: db::new_id(),
            channel_id: channel_id.clone(),
            dm_channel_id: String::new(),
            author_id: user_id.clone(),
            content: body.content.clone(),
            msg_type: body.msg_type.clone(),
            thread_id: String::new(),
            edited_at: None,
            deleted: false,
            lamport_ts: 0, reply_to_message_id: None,
            created_at: now,
        };
        db::create_message(conn, &msg)?;
        Ok(msg)
    })
    .await
    .map_err(map_not_found("channel"))?;

    // Broadcast via WebSocket.
    let event_data = serde_json::to_vec(&json!({
        "type": "message:new",
        "payload": msg,
    }))
    .unwrap_or_default();
    state
        .hub
        .broadcast_to_channel(&msg.channel_id, event_data, None)
        .await;

    json_ok(msg)
}

pub async fn edit(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, channel_id, message_id)): Path<(String, String, String)>,
    Json(body): Json<EditMessageRequest>,
) -> Result<Json<Value>, AppError> {
    if body.content.is_empty() {
        return Err(AppError::BadRequest("content is required".into()));
    }

    let msg = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id, &team_id)?;

        // VULN-007: a user excluded from the channel can't edit either —
        // not even their own historical messages once access is revoked.
        if !db::user_can_access_channel(conn, &user_id, &team_id, &channel_id)? {
            return Err(rusqlite::Error::InvalidParameterName(
                "channel access denied".into(),
            ));
        }

        let msg = db::get_message_by_id(conn, &message_id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;

        // Only the author can edit.
        if msg.author_id != user_id {
            return Err(rusqlite::Error::InvalidParameterName(
                "can only edit your own messages".into(),
            ));
        }

        if msg.deleted {
            return Err(rusqlite::Error::InvalidParameterName(
                "cannot edit a deleted message".into(),
            ));
        }

        // No-op edit (same content) skips the audit row so the log
        // doesn't accumulate write-amplified entries. H5 / MSG-AUDIT-1.
        let is_noop = msg.content == body.content;

        db::update_message_content(conn, &message_id, &body.content)?;

        // Re-fetch the updated message.
        let updated = db::get_message_by_id(conn, &message_id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;

        if !is_noop {
            let details = serde_json::json!({
                "channel_id": channel_id,
                "edited_at": updated.edited_at,
            });
            // Best-effort audit insert — message edit/delete take
            // precedence over the audit row so a transient audit
            // failure must not block the user-visible action.
            let _ = db::insert_audit_event(
                conn,
                &team_id,
                Some(&user_id),
                "message.edit",
                Some("message"),
                Some(&message_id),
                Some(&details),
            );
        }

        Ok(updated)
    })
    .await
    .map_err(map_not_found("message"))?;

    let event_data = serde_json::to_vec(&json!({
        "type": "message:updated",
        "payload": msg,
    }))
    .unwrap_or_default();
    state
        .hub
        .broadcast_to_channel(&msg.channel_id, event_data, None)
        .await;

    json_ok(msg)
}

pub async fn delete_msg(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, channel_id, message_id)): Path<(String, String, String)>,
) -> Result<Json<Value>, AppError> {
    let mid = message_id.clone();
    let cid_check = channel_id.clone();
    let cid_audit = channel_id.clone();
    let team_audit = team_id.clone();
    spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id, &team_id)?;
        // VULN-007: same per-channel ACL on delete. Author of an old
        // message who lost access to the channel must NOT be able to
        // delete via REST when WS would have blocked it.
        if !db::user_can_access_channel(conn, &user_id, &team_id, &cid_check)? {
            return Err(rusqlite::Error::InvalidParameterName(
                "channel access denied".into(),
            ));
        }

        let msg = db::get_message_by_id(conn, &mid)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;

        // Idempotence — refuse to log a duplicate delete on an already
        // soft-deleted row. H5 / MSG-AUDIT-1.
        if msg.deleted {
            return Err(rusqlite::Error::InvalidParameterName(
                "message already deleted".into(),
            ));
        }

        // Author can delete their own; admins can delete any.
        if msg.author_id != user_id
            && !db::user_has_permission(conn, &user_id, &team_id, db::PERM_MANAGE_MESSAGES)?
        {
            return Err(rusqlite::Error::InvalidParameterName(
                "insufficient permissions".into(),
            ));
        }

        db::soft_delete_message(conn, &mid)?;

        // H5 / MSG-AUDIT-1: log the delete after the row flips. The
        // pre-check above keeps this idempotent (already-deleted rows
        // never reach here).
        let details = serde_json::json!({
            "channel_id": cid_audit,
            "deleted_at": db::now_str(),
        });
        let _ = db::insert_audit_event(
            conn,
            &team_audit,
            Some(&user_id),
            "message.delete",
            Some("message"),
            Some(&mid),
            Some(&details),
        );

        Ok(())
    })
    .await
    .map_err(map_not_found("message"))?;

    let event_data = serde_json::to_vec(&json!({
        "type": "message:deleted",
        "payload": {
            "message_id": message_id,
            "channel_id": channel_id,
        },
    }))
    .unwrap_or_default();
    state
        .hub
        .broadcast_to_channel(&channel_id, event_data, None)
        .await;

    json_ok_true()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_messages_query_defaults() {
        let q: ListMessagesQuery = serde_json::from_str("{}").unwrap();
        assert_eq!(q.before, "");
        assert_eq!(q.limit, 50);
    }

    #[test]
    fn list_messages_query_explicit_values() {
        let q: ListMessagesQuery = serde_json::from_str(r#"{"before":"2026-01-01","limit":25}"#).unwrap();
        assert_eq!(q.before, "2026-01-01");
        assert_eq!(q.limit, 25);
    }

    #[test]
    fn default_msg_type_is_text() {
        let r: CreateMessageRequest = serde_json::from_str(r#"{"content":"hi"}"#).unwrap();
        assert_eq!(r.msg_type, "text");
    }

    #[test]
    fn create_message_request_renames_type_to_msg_type() {
        let r: CreateMessageRequest = serde_json::from_str(r#"{"content":"x","type":"system"}"#).unwrap();
        assert_eq!(r.msg_type, "system");
    }

    #[test]
    fn max_page_limit_is_at_least_default() {
        // Sanity check: the server-side clamp must be ≥ the default
        // limit, otherwise a client requesting the default would be
        // clamped lower than what they thought they'd get.
        assert!(MAX_PAGE_LIMIT >= default_limit());
        assert_eq!(MAX_PAGE_LIMIT, 200);
    }

    #[test]
    fn edit_message_request_requires_content() {
        // Missing `content` must fail.
        assert!(serde_json::from_str::<EditMessageRequest>("{}").is_err());
    }

    // ── axum integration tests ──────────────────────────────────────

    use crate::auth::{AuthService, UserId};
    use crate::config::Config;
    use crate::db::Database;
    use crate::presence::PresenceManager;
    use crate::ws::Hub;
    use axum::body::Body;
    use axum::http::Request;
    use axum::routing::{get, patch, post, delete as axum_delete};
    use axum::Router;
    use std::sync::Arc;
    use tower::ServiceExt;

    fn make_state() -> (AppState, tempfile::TempDir) {
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

    fn router(state: AppState, user_id: &'static str) -> Router {
        Router::new()
            .route("/teams/{team_id}/channels/{channel_id}/messages", get(list).post(create))
            .route(
                "/teams/{team_id}/channels/{channel_id}/messages/{message_id}",
                patch(edit).route_layer(axum::middleware::from_fn(|req, next: axum::middleware::Next| async move { next.run(req).await })),
            )
            .route(
                "/teams/{team_id}/channels/{channel_id}/messages/{message_id}/del",
                axum_delete(delete_msg),
            )
            .layer(axum::Extension(UserId(user_id.to_string())))
            .with_state(state)
    }

    #[tokio::test]
    async fn create_message_rejects_empty_content() {
        let (state, _tmp) = make_state();
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::post("/teams/t1/channels/ch1/messages")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"content":"","type":"text"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn create_message_404s_for_unknown_team() {
        let (state, _tmp) = make_state();
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::post("/teams/nope/channels/ch1/messages")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"content":"hi","type":"text"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status() == 404 || resp.status() == 403);
    }

    #[tokio::test]
    async fn list_messages_404s_for_unknown_channel() {
        let (state, _tmp) = make_state();
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::get("/teams/t1/channels/ch1/messages?limit=10").body(Body::empty()).unwrap(),
            )
            .await
            .unwrap();
        // Non-member of team → 404/403 either way.
        assert!(resp.status() == 404 || resp.status() == 403);
    }
}
