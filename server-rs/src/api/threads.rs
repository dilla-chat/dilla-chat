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
pub struct CreateThreadRequest {
    pub parent_message_id: String,
    #[serde(default)]
    pub title: String,
}

#[derive(Deserialize)]
pub struct UpdateThreadRequest {
    pub title: Option<String>,
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
pub struct ListMessagesQuery {
    #[serde(default)]
    pub before: String,
    #[serde(default = "default_limit")]
    pub limit: i32,
}

fn default_limit() -> i32 {
    50
}

pub async fn create(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, channel_id)): Path<(String, String)>,
    Json(body): Json<CreateThreadRequest>,
) -> Result<Json<Value>, AppError> {
    if body.parent_message_id.is_empty() {
        return Err(AppError::BadRequest("parent_message_id is required".into()));
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

            // Verify parent message exists.
            let parent = db::get_message_by_id(conn, &body.parent_message_id)?;
            if parent.is_none() {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }

            // Check if thread already exists for this message.
            if let Some(existing) =
                db::get_thread_by_parent_message(conn, &body.parent_message_id)?
            {
                return Ok(existing);
            }

            let now = db::now_str();
            let thread = db::Thread {
                id: db::new_id(),
                channel_id: cid.clone(),
                parent_message_id: body.parent_message_id.clone(),
                team_id: tid.clone(),
                creator_id: uid.clone(),
                title: body.title.clone(),
                message_count: 0,
                last_message_at: None,
                created_at: now,
            };
            db::create_thread(conn, &thread)?;
            Ok(thread)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(thread) => {
            let event_data = serde_json::to_vec(&json!({
                "type": "thread:created",
                "payload": thread,
            }))
            .unwrap_or_default();
            state
                .hub
                .broadcast_to_channel(&thread.channel_id, event_data, None)
                .await;

            Ok(Json(json!(thread)))
        }
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(AppError::NotFound("parent message not found".into()))
        }
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

pub async fn list(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, channel_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
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
            db::get_channel_threads(conn, &cid)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(threads) => Ok(Json(json!(threads))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

pub async fn get_thread(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, thread_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let tid = team_id.clone();
    let thid = thread_id.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let member = db::get_member_by_user_and_team(conn, &uid, &tid)?;
            if member.is_none() {
                return Err(rusqlite::Error::InvalidParameterName(
                    "not a member of this team".into(),
                ));
            }

            let thread = db::get_thread(conn, &thid)?
                .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;

            if thread.team_id != tid {
                return Err(rusqlite::Error::InvalidParameterName(
                    "thread does not belong to this team".into(),
                ));
            }

            Ok(thread)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(thread) => Ok(Json(json!(thread))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(AppError::NotFound("thread not found".into()))
        }
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

pub async fn update(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, thread_id)): Path<(String, String)>,
    Json(body): Json<UpdateThreadRequest>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let tid = team_id.clone();
    let thid = thread_id.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let member = db::get_member_by_user_and_team(conn, &uid, &tid)?;
            if member.is_none() {
                return Err(rusqlite::Error::InvalidParameterName(
                    "not a member of this team".into(),
                ));
            }

            let mut thread = db::get_thread(conn, &thid)?
                .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;

            if thread.team_id != tid {
                return Err(rusqlite::Error::InvalidParameterName(
                    "thread does not belong to this team".into(),
                ));
            }

            // Only creator or admins can update.
            if thread.creator_id != uid
                && !db::user_has_permission(conn, &uid, &tid, db::PERM_MANAGE_MESSAGES)?
            {
                return Err(rusqlite::Error::InvalidParameterName(
                    "insufficient permissions".into(),
                ));
            }

            if let Some(ref title) = body.title {
                thread.title = title.clone();
            }

            db::update_thread(conn, &thread)?;
            Ok(thread)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(thread) => Ok(Json(json!(thread))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(AppError::NotFound("thread not found".into()))
        }
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

pub async fn delete_thread(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, thread_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let tid = team_id.clone();
    let thid = thread_id.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let thread = db::get_thread(conn, &thid)?
                .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;

            if thread.team_id != tid {
                return Err(rusqlite::Error::InvalidParameterName(
                    "thread does not belong to this team".into(),
                ));
            }

            // Only creator or admins can delete.
            if thread.creator_id != uid
                && !db::user_has_permission(conn, &uid, &tid, db::PERM_MANAGE_MESSAGES)?
            {
                return Err(rusqlite::Error::InvalidParameterName(
                    "insufficient permissions".into(),
                ));
            }

            db::delete_thread(conn, &thid)?;
            Ok(thread.channel_id)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(_channel_id) => Ok(Json(json!({ "ok": true }))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(AppError::NotFound("thread not found".into()))
        }
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

pub async fn create_message(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, thread_id)): Path<(String, String)>,
    Json(body): Json<CreateMessageRequest>,
) -> Result<Json<Value>, AppError> {
    if body.content.is_empty() {
        return Err(AppError::BadRequest("content is required".into()));
    }

    let db = state.db.clone();
    let tid = team_id.clone();
    let thid = thread_id.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let member = db::get_member_by_user_and_team(conn, &uid, &tid)?;
            if member.is_none() {
                return Err(rusqlite::Error::InvalidParameterName(
                    "not a member of this team".into(),
                ));
            }

            let thread = db::get_thread(conn, &thid)?
                .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;

            if thread.team_id != tid {
                return Err(rusqlite::Error::InvalidParameterName(
                    "thread does not belong to this team".into(),
                ));
            }

            let now = db::now_str();
            let msg = db::Message {
                id: db::new_id(),
                channel_id: thread.channel_id.clone(),
                dm_channel_id: String::new(),
                author_id: uid.clone(),
                content: body.content.clone(),
                msg_type: body.msg_type.clone(),
                thread_id: thid.clone(),
                edited_at: None,
                deleted: false,
                lamport_ts: 0,
                created_at: now,
            };
            db::create_thread_message(conn, &msg)?;

            Ok((msg, thread.channel_id))
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok((msg, channel_id)) => {
            let event_data = serde_json::to_vec(&json!({
                "type": "thread:message:new",
                "payload": msg,
            }))
            .unwrap_or_default();
            state
                .hub
                .broadcast_to_channel(&channel_id, event_data, None)
                .await;

            Ok(Json(json!(msg)))
        }
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(AppError::NotFound("thread not found".into()))
        }
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

pub async fn list_messages(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, thread_id)): Path<(String, String)>,
    Query(query): Query<ListMessagesQuery>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let tid = team_id.clone();
    let thid = thread_id.clone();
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

            let thread = db::get_thread(conn, &thid)?;
            if thread.is_none() {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }

            db::get_thread_messages(conn, &thid, &query.before, limit)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(messages) => Ok(Json(json!(messages))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(AppError::NotFound("thread not found".into()))
        }
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}
