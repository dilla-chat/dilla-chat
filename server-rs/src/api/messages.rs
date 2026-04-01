use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::api::helpers::{json_ok, json_ok_true, map_not_found, require_team_member, spawn_db};
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
    let limit = query.limit.clamp(1, 100);

    let enriched = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id, &team_id)?;
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
            lamport_ts: 0,
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
    Path((team_id, _channel_id, message_id)): Path<(String, String, String)>,
    Json(body): Json<EditMessageRequest>,
) -> Result<Json<Value>, AppError> {
    if body.content.is_empty() {
        return Err(AppError::BadRequest("content is required".into()));
    }

    let msg = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id, &team_id)?;

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

        db::update_message_content(conn, &message_id, &body.content)?;

        // Re-fetch the updated message.
        let updated = db::get_message_by_id(conn, &message_id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
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
    spawn_db(state.db.clone(), move |conn| {
        let msg = db::get_message_by_id(conn, &mid)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;

        // Author can delete their own; admins can delete any.
        if msg.author_id != user_id
            && !db::user_has_permission(conn, &user_id, &team_id, db::PERM_MANAGE_MESSAGES)?
        {
            return Err(rusqlite::Error::InvalidParameterName(
                "insufficient permissions".into(),
            ));
        }

        db::soft_delete_message(conn, &mid)?;
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
