// Pin / unpin a message in a channel. Requires PERM_MANAGE_MESSAGES so
// general members can't pin random messages. Mutations broadcast
// message:pin-update to every client subscribed to the channel so
// sidebars and pin-popovers update without a re-fetch.
//
// Routes (registered in api/mod.rs):
//   GET    /api/v1/teams/{tid}/channels/{cid}/pins        — id list
//   POST   /api/v1/teams/{tid}/channels/{cid}/messages/{mid}/pin
//   DELETE /api/v1/teams/{tid}/channels/{cid}/messages/{mid}/pin

use axum::extract::{Path, State};
use axum::{Extension, Json};
use serde_json::Value;

use crate::api::helpers::{json_ok, json_ok_true, require_permission, require_team_member, spawn_db};
use crate::api::AppState;
use crate::auth::UserId;
use crate::db;
use crate::error::AppError;
use crate::ws::events::Event;

pub async fn list_for_channel(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, channel_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let ids = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id, &team_id)?;
        db::get_pinned_ids_by_channel(conn, &channel_id)
    })
    .await?;
    json_ok(serde_json::json!({ "message_ids": ids }))
}

pub async fn pin(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, channel_id, message_id)): Path<(String, String, String)>,
) -> Result<Json<Value>, AppError> {
    let team_id_clone = team_id.clone();
    let channel_id_clone = channel_id.clone();
    let message_id_clone = message_id.clone();
    let user_id_clone = user_id.clone();
    spawn_db(state.db.clone(), move |conn| {
        require_permission(conn, &user_id_clone, &team_id_clone, db::PERM_MANAGE_MESSAGES)?;
        // Verify the message exists and belongs to the channel — keeps a
        // bad client from pinning across channels via a crafted URL.
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM messages WHERE id = ?1 AND channel_id = ?2 LIMIT 1",
                rusqlite::params![message_id_clone, channel_id_clone],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if !exists {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        db::pin_message(conn, &message_id_clone, &channel_id_clone, &team_id_clone, &user_id_clone)?;
        let _ = db::insert_audit_event(
            conn,
            &team_id_clone,
            Some(&user_id_clone),
            "message.pin",
            Some("message"),
            Some(&message_id_clone),
            Some(&serde_json::json!({ "channel_id": channel_id_clone })),
        );
        Ok(())
    })
    .await
    .map_err(|e| match e {
        AppError::NotFound(_) => AppError::NotFound("message not found in this channel".into()),
        other => other,
    })?;

    broadcast(&state, &team_id, &channel_id, &message_id, true).await;
    json_ok_true()
}

pub async fn unpin(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, channel_id, message_id)): Path<(String, String, String)>,
) -> Result<Json<Value>, AppError> {
    let team_id_clone = team_id.clone();
    let channel_id_clone = channel_id.clone();
    let message_id_clone = message_id.clone();
    let user_id_clone = user_id.clone();
    spawn_db(state.db.clone(), move |conn| {
        require_permission(conn, &user_id_clone, &team_id_clone, db::PERM_MANAGE_MESSAGES)?;
        db::unpin_message(conn, &message_id_clone)?;
        let _ = db::insert_audit_event(
            conn,
            &team_id_clone,
            Some(&user_id_clone),
            "message.unpin",
            Some("message"),
            Some(&message_id_clone),
            Some(&serde_json::json!({ "channel_id": channel_id_clone })),
        );
        Ok(())
    })
    .await?;
    broadcast(&state, &team_id, &channel_id, &message_id, false).await;
    json_ok_true()
}

async fn broadcast(
    state: &AppState,
    team_id: &str,
    channel_id: &str,
    message_id: &str,
    pinned: bool,
) {
    let payload = serde_json::json!({
        "team_id": team_id,
        "channel_id": channel_id,
        "message_id": message_id,
        "pinned": pinned,
    });
    if let Ok(evt) = Event::new("message:pin-update", payload) {
        if let Ok(bytes) = evt.to_bytes() {
            state.hub.broadcast_to_channel(channel_id, bytes, None).await;
        }
    }
}
