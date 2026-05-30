use axum::extract::{Path, State};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::Value;

use crate::api::helpers::{json_ok, json_ok_true, spawn_db};
use crate::api::AppState;
use crate::auth::UserId;
use crate::db;
use crate::error::AppError;

#[derive(Deserialize)]
pub struct MuteRequest {
    /// Optional ISO-8601 timestamp; null/unset means mute indefinitely.
    pub muted_until: Option<String>,
}

pub async fn list(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
) -> Result<Json<Value>, AppError> {
    let rows = spawn_db(state.db.clone(), move |conn| {
        db::get_muted_channels(conn, &user_id)
    })
    .await?;
    let payload: Vec<Value> = rows
        .into_iter()
        .map(|(channel_id, muted_until)| {
            serde_json::json!({ "channel_id": channel_id, "muted_until": muted_until })
        })
        .collect();
    json_ok(payload)
}

pub async fn mute(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Json(body): Json<MuteRequest>,
) -> Result<Json<Value>, AppError> {
    let uid = user_id.clone();
    let cid = channel_id.clone();
    let until = body.muted_until.clone();
    spawn_db(state.db.clone(), move |conn| {
        db::upsert_channel_mute(conn, &uid, &cid, until.as_deref())
    })
    .await?;

    // Broadcast to the same user only — multi-device sync, no privacy
    // leak. send_to_user fans out to every connected client for that user.
    if let Ok(evt) = crate::ws::events::Event::new(
        "channel:mute-update",
        serde_json::json!({
            "channel_id": &channel_id,
            "muted": true,
            "muted_until": &body.muted_until,
        }),
    ) {
        if let Ok(bytes) = evt.to_bytes() {
            state.hub.send_to_user(&user_id, bytes).await;
        }
    }

    json_ok(serde_json::json!({ "channel_id": channel_id, "muted_until": body.muted_until }))
}

pub async fn unmute(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let uid = user_id.clone();
    let cid = channel_id.clone();
    spawn_db(state.db.clone(), move |conn| {
        db::delete_channel_mute(conn, &uid, &cid)
    })
    .await?;

    if let Ok(evt) = crate::ws::events::Event::new(
        "channel:mute-update",
        serde_json::json!({ "channel_id": &channel_id, "muted": false }),
    ) {
        if let Ok(bytes) = evt.to_bytes() {
            state.hub.send_to_user(&user_id, bytes).await;
        }
    }

    json_ok_true()
}
