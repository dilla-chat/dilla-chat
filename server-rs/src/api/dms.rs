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
pub struct CreateDMRequest {
    pub user_ids: Vec<String>,
    #[serde(default)]
    pub name: String,
}

#[derive(Deserialize)]
pub struct SendMessageRequest {
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
pub struct AddMembersRequest {
    pub user_ids: Vec<String>,
}

pub async fn create_or_get(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
    Json(body): Json<CreateDMRequest>,
) -> Result<Json<Value>, AppError> {
    if body.user_ids.is_empty() {
        return Err(AppError::BadRequest("user_ids is required".into()));
    }

    let db = state.db.clone();
    let tid = team_id.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            require_team_member(conn, &uid, &tid)?;

            // For 1:1 DMs, check if one already exists.
            if body.user_ids.len() == 1 {
                if let Some(existing) = db::get_dm_channel_by_members(conn, &tid, &uid, &body.user_ids[0])? {
                    return Ok(existing);
                }
            }

            create_new_dm_channel(conn, &tid, &uid, &body)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(dm) => Ok(Json(json!(dm))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

pub async fn list(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let tid = team_id.clone();
    let uid = user_id.clone();

    let dms = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| db::get_user_dm_channels(conn, &tid, &uid))
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?
    .map_err(|e| AppError::Internal(format!("db: {}", e)))?;

    Ok(Json(json!(dms)))
}

pub async fn get_dm(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((_team_id, dm_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let did = dm_id.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            if !db::is_dm_member(conn, &did, &uid)? {
                return Err(rusqlite::Error::InvalidParameterName(
                    "not a member of this DM".into(),
                ));
            }

            let dm = db::get_dm_channel(conn, &did)?
                .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;

            let members = db::get_dm_members(conn, &did)?;

            Ok(json!({
                "channel": dm,
                "members": members,
            }))
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(data) => Ok(Json(data)),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(AppError::NotFound("DM channel not found".into()))
        }
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

pub async fn send_message(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((_team_id, dm_id)): Path<(String, String)>,
    Json(body): Json<SendMessageRequest>,
) -> Result<Json<Value>, AppError> {
    if body.content.is_empty() {
        return Err(AppError::BadRequest("content is required".into()));
    }

    let db = state.db.clone();
    let did = dm_id.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            if !db::is_dm_member(conn, &did, &uid)? {
                return Err(rusqlite::Error::InvalidParameterName(
                    "not a member of this DM".into(),
                ));
            }

            let now = db::now_str();
            let msg = db::Message {
                id: db::new_id(),
                channel_id: String::new(),
                dm_channel_id: did.clone(),
                author_id: uid.clone(),
                content: body.content.clone(),
                msg_type: body.msg_type.clone(),
                thread_id: String::new(),
                edited_at: None,
                deleted: false,
                lamport_ts: 0,
                created_at: now,
            };
            db::create_dm_message(conn, &msg)?;

            // Get members to notify.
            let members = db::get_dm_members(conn, &did)?;
            let member_ids: Vec<String> = members.into_iter().map(|m| m.user_id).collect();

            Ok((msg, member_ids))
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok((msg, member_ids)) => {
            // Notify all DM members via WebSocket.
            let event_data = serde_json::to_vec(&json!({
                "type": "dm:message:new",
                "payload": msg,
            }))
            .unwrap_or_default();
            for member_id in &member_ids {
                state.hub.send_to_user(member_id, event_data.clone()).await;
            }

            Ok(Json(json!(msg)))
        }
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

pub async fn list_messages(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((_team_id, dm_id)): Path<(String, String)>,
    Query(query): Query<ListMessagesQuery>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let did = dm_id.clone();
    let uid = user_id.clone();
    let limit = query.limit.clamp(1, 100);

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            if !db::is_dm_member(conn, &did, &uid)? {
                return Err(rusqlite::Error::InvalidParameterName(
                    "not a member of this DM".into(),
                ));
            }
            db::get_dm_messages(conn, &did, &query.before, limit)
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

pub async fn edit_message(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((_team_id, dm_id, message_id)): Path<(String, String, String)>,
    Json(body): Json<EditMessageRequest>,
) -> Result<Json<Value>, AppError> {
    if body.content.is_empty() {
        return Err(AppError::BadRequest("content is required".into()));
    }

    let db = state.db.clone();
    let did = dm_id.clone();
    let mid = message_id.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            if !db::is_dm_member(conn, &did, &uid)? {
                return Err(rusqlite::Error::InvalidParameterName(
                    "not a member of this DM".into(),
                ));
            }

            let msg = db::get_message_by_id(conn, &mid)?
                .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;

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

            let updated = db::get_message_by_id(conn, &mid)?
                .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;

            let members = db::get_dm_members(conn, &did)?;
            let member_ids: Vec<String> = members.into_iter().map(|m| m.user_id).collect();

            Ok((updated, member_ids))
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok((msg, member_ids)) => {
            let event_data = serde_json::to_vec(&json!({
                "type": "dm:message:updated",
                "payload": msg,
            }))
            .unwrap_or_default();
            for member_id in &member_ids {
                state.hub.send_to_user(member_id, event_data.clone()).await;
            }

            Ok(Json(json!(msg)))
        }
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(AppError::NotFound("message not found".into()))
        }
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

pub async fn delete_message(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((_team_id, dm_id, message_id)): Path<(String, String, String)>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let did = dm_id.clone();
    let mid = message_id.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            if !db::is_dm_member(conn, &did, &uid)? {
                return Err(rusqlite::Error::InvalidParameterName(
                    "not a member of this DM".into(),
                ));
            }

            let msg = db::get_message_by_id(conn, &mid)?
                .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;

            if msg.author_id != uid {
                return Err(rusqlite::Error::InvalidParameterName(
                    "can only delete your own messages".into(),
                ));
            }

            db::soft_delete_message(conn, &mid)?;

            let members = db::get_dm_members(conn, &did)?;
            let member_ids: Vec<String> = members.into_iter().map(|m| m.user_id).collect();

            Ok(member_ids)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(member_ids) => {
            let event_data = serde_json::to_vec(&json!({
                "type": "dm:message:deleted",
                "payload": {
                    "message_id": message_id,
                    "dm_channel_id": dm_id,
                },
            }))
            .unwrap_or_default();
            for member_id in &member_ids {
                state.hub.send_to_user(member_id, event_data.clone()).await;
            }

            Ok(Json(json!({ "ok": true })))
        }
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(AppError::NotFound("message not found".into()))
        }
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

pub async fn add_members(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((_team_id, dm_id)): Path<(String, String)>,
    Json(body): Json<AddMembersRequest>,
) -> Result<Json<Value>, AppError> {
    if body.user_ids.is_empty() {
        return Err(AppError::BadRequest("user_ids is required".into()));
    }

    let db = state.db.clone();
    let did = dm_id.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            if !db::is_dm_member(conn, &did, &uid)? {
                return Err(rusqlite::Error::InvalidParameterName(
                    "not a member of this DM".into(),
                ));
            }

            db::add_dm_members(conn, &did, &body.user_ids)?;

            let members = db::get_dm_members(conn, &did)?;
            Ok(members)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(members) => Ok(Json(json!(members))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

pub async fn remove_member(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((_team_id, dm_id, target_user_id)): Path<(String, String, String)>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let did = dm_id.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            if !db::is_dm_member(conn, &did, &uid)? {
                return Err(rusqlite::Error::InvalidParameterName(
                    "not a member of this DM".into(),
                ));
            }

            db::remove_dm_member(conn, &did, &target_user_id)?;
            Ok(())
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(()) => Ok(Json(json!({ "ok": true }))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

// --- Shared helpers ---

/// Verify that a user is a member of the given team.
fn require_team_member(
    conn: &rusqlite::Connection,
    user_id: &str,
    team_id: &str,
) -> Result<(), rusqlite::Error> {
    if db::get_member_by_user_and_team(conn, user_id, team_id)?.is_none() {
        return Err(rusqlite::Error::InvalidParameterName(
            "not a member of this team".into(),
        ));
    }
    Ok(())
}

/// Create a new DM channel and add all members.
fn create_new_dm_channel(
    conn: &rusqlite::Connection,
    team_id: &str,
    creator_id: &str,
    body: &CreateDMRequest,
) -> Result<db::DMChannel, rusqlite::Error> {
    let dm_type = if body.user_ids.len() > 1 { "group" } else { "dm" };

    let dm = db::DMChannel {
        id: db::new_id(),
        team_id: team_id.to_string(),
        dm_type: dm_type.into(),
        name: body.name.clone(),
        created_at: db::now_str(),
    };
    db::create_dm_channel(conn, &dm)?;

    let mut all_members: Vec<String> = vec![creator_id.to_string()];
    for id in &body.user_ids {
        if *id != creator_id {
            all_members.push(id.clone());
        }
    }
    db::add_dm_members(conn, &dm.id, &all_members)?;

    Ok(dm)
}
