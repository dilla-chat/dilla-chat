use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde_json::{json, Value};

use crate::api::AppState;
use crate::auth::UserId;
use crate::db;
use crate::error::AppError;

pub async fn add(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, channel_id, message_id, emoji)): Path<(String, String, String, String)>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let tid = team_id.clone();
    let cid = channel_id.clone();
    let mid = message_id.clone();
    let uid = user_id.clone();
    let em = emoji.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let member = db::get_member_by_user_and_team(conn, &uid, &tid)?;
            if member.is_none() {
                return Err(rusqlite::Error::InvalidParameterName(
                    "not a member of this team".into(),
                ));
            }

            // Verify message exists.
            let msg = db::get_message_by_id(conn, &mid)?;
            if msg.is_none() {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }

            let reaction = db::add_reaction(conn, &mid, &uid, &em)?;
            Ok((reaction, cid))
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok((reaction, channel_id)) => {
            let event_data = serde_json::to_vec(&json!({
                "type": "reaction:added",
                "payload": {
                    "message_id": reaction.message_id,
                    "channel_id": channel_id,
                    "user_id": reaction.user_id,
                    "emoji": reaction.emoji,
                },
            }))
            .unwrap_or_default();
            state
                .hub
                .broadcast_to_channel(&channel_id, event_data, None)
                .await;

            Ok(Json(json!(reaction)))
        }
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(AppError::NotFound("message not found".into()))
        }
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

pub async fn remove(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, channel_id, message_id, emoji)): Path<(String, String, String, String)>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let tid = team_id.clone();
    let cid = channel_id.clone();
    let mid = message_id.clone();
    let uid = user_id.clone();
    let em = emoji.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let member = db::get_member_by_user_and_team(conn, &uid, &tid)?;
            if member.is_none() {
                return Err(rusqlite::Error::InvalidParameterName(
                    "not a member of this team".into(),
                ));
            }

            db::remove_reaction(conn, &mid, &uid, &em)?;
            Ok(cid)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(channel_id) => {
            let event_data = serde_json::to_vec(&json!({
                "type": "reaction:removed",
                "payload": {
                    "message_id": message_id,
                    "channel_id": channel_id,
                    "user_id": user_id,
                    "emoji": emoji,
                },
            }))
            .unwrap_or_default();
            state
                .hub
                .broadcast_to_channel(&channel_id, event_data, None)
                .await;

            Ok(Json(json!({ "ok": true })))
        }
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

pub async fn list(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, _channel_id, message_id)): Path<(String, String, String)>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let tid = team_id.clone();
    let mid = message_id.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let member = db::get_member_by_user_and_team(conn, &uid, &tid)?;
            if member.is_none() {
                return Err(rusqlite::Error::InvalidParameterName(
                    "not a member of this team".into(),
                ));
            }

            db::get_message_reactions(conn, &mid)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(reactions) => Ok(Json(json!(reactions))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}
