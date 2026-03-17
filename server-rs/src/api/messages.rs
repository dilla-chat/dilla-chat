use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::api::AppState;
use crate::auth::UserId;
use crate::db;
use crate::error::AppError;

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
    let db = state.db.clone();
    let tid = team_id.clone();
    let cid = channel_id.clone();
    let uid = user_id.clone();

    let limit = query.limit.clamp(1, 100);

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let member = db::get_member_by_user_and_team(conn, &uid, &tid)?;
            if member.is_none() {
                return Err(rusqlite::Error::InvalidParameterName(
                    "not a member of this team".into(),
                ));
            }

            db::get_messages_by_channel(conn, &cid, &query.before, limit)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(messages) => Ok(Json(json!(messages))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
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

    let db = state.db.clone();
    let tid = team_id.clone();
    let cid = channel_id.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let member = db::get_member_by_user_and_team(conn, &uid, &tid)?;
            if member.is_none() {
                return Err(rusqlite::Error::InvalidParameterName(
                    "not a member of this team".into(),
                ));
            }

            // Verify channel exists and belongs to team.
            let channel = db::get_channel_by_id(conn, &cid)?;
            match channel {
                Some(ch) if ch.team_id == tid => {}
                _ => {
                    return Err(rusqlite::Error::QueryReturnedNoRows);
                }
            }

            let now = db::now_str();
            let msg = db::Message {
                id: db::new_id(),
                channel_id: cid.clone(),
                dm_channel_id: String::new(),
                author_id: uid.clone(),
                content: body.content.clone(),
                msg_type: body.msg_type.clone(),
                thread_id: String::new(),
                edited_at: None,
                deleted: false,
                lamport_ts: 0,
                created_at: now,
            };
            db::create_message(conn, &msg)?;
            Ok(msg)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(msg) => {
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

            Ok(Json(json!(msg)))
        }
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(AppError::NotFound("channel not found".into()))
        }
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
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

    let db = state.db.clone();
    let tid = team_id.clone();
    let _cid = channel_id.clone();
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

            let msg = db::get_message_by_id(conn, &mid)?
                .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;

            // Only the author can edit.
            if msg.author_id != uid {
                return Err(rusqlite::Error::InvalidParameterName(
                    "can only edit your own messages".into(),
                ));
            }

            if msg.deleted {
                return Err(rusqlite::Error::InvalidParameterName(
                    "cannot edit a deleted message".into(),
                ));
            }

            db::update_message_content(conn, &mid, &body.content)?;

            // Re-fetch the updated message.
            let updated = db::get_message_by_id(conn, &mid)?
                .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;
            Ok(updated)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(msg) => {
            let event_data = serde_json::to_vec(&json!({
                "type": "message:updated",
                "payload": msg,
            }))
            .unwrap_or_default();
            state
                .hub
                .broadcast_to_channel(&msg.channel_id, event_data, None)
                .await;

            Ok(Json(json!(msg)))
        }
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(AppError::NotFound("message not found".into()))
        }
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

pub async fn delete_msg(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, channel_id, message_id)): Path<(String, String, String)>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let tid = team_id.clone();
    let cid = channel_id.clone();
    let mid = message_id.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let msg = db::get_message_by_id(conn, &mid)?
                .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;

            // Author can delete their own; admins can delete any.
            if msg.author_id != uid {
                if !db::user_has_permission(conn, &uid, &tid, db::PERM_MANAGE_MESSAGES)? {
                    return Err(rusqlite::Error::InvalidParameterName(
                        "insufficient permissions".into(),
                    ));
                }
            }

            db::soft_delete_message(conn, &mid)?;
            Ok(cid)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(channel_id) => {
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

            Ok(Json(json!({ "ok": true })))
        }
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(AppError::NotFound("message not found".into()))
        }
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}
