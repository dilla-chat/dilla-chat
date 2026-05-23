use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::api::helpers::{json_ok, json_ok_true, map_not_found, spawn_db};
// A6 migration tail: route authz through policy::*.
use crate::policy::{require_permission, require_team_member};
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

/// Fetch a thread by ID and verify it belongs to the given team.
fn get_thread_for_team(
    conn: &rusqlite::Connection,
    thread_id: &str,
    team_id: &str,
) -> Result<db::Thread, rusqlite::Error> {
    let thread = db::get_thread(conn, thread_id)?
        .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
    if thread.team_id != team_id {
        return Err(rusqlite::Error::InvalidParameterName(
            "thread does not belong to this team".into(),
        ));
    }
    Ok(thread)
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

    let thread = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id, &team_id)?;

        // Verify parent message exists.
        if db::get_message_by_id(conn, &body.parent_message_id)?.is_none() {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }

        // Check if thread already exists for this message.
        if let Some(existing) = db::get_thread_by_parent_message(conn, &body.parent_message_id)? {
            return Ok(existing);
        }

        let now = db::now_str();
        let thread = db::Thread {
            id: db::new_id(),
            channel_id: channel_id.clone(),
            parent_message_id: body.parent_message_id.clone(),
            team_id: team_id.clone(),
            creator_id: user_id.clone(),
            title: body.title.clone(),
            message_count: 0,
            last_message_at: None,
            created_at: now,
        };
        db::create_thread(conn, &thread)?;
        Ok(thread)
    })
    .await
    .map_err(map_not_found("parent message"))?;

    let event_data = serde_json::to_vec(&json!({
        "type": "thread:created",
        "payload": thread,
    }))
    .unwrap_or_default();
    state
        .hub
        .broadcast_to_channel(&thread.channel_id, event_data, None)
        .await;

    json_ok(thread)
}

pub async fn list(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, channel_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let threads = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id, &team_id)?;
        db::get_channel_threads(conn, &channel_id)
    })
    .await?;

    json_ok(threads)
}

pub async fn get_thread(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, thread_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let thread = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id, &team_id)?;
        get_thread_for_team(conn, &thread_id, &team_id)
    })
    .await
    .map_err(map_not_found("thread"))?;

    json_ok(thread)
}

pub async fn update(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, thread_id)): Path<(String, String)>,
    Json(body): Json<UpdateThreadRequest>,
) -> Result<Json<Value>, AppError> {
    let thread = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id, &team_id)?;
        let mut thread = get_thread_for_team(conn, &thread_id, &team_id)?;

        // Only creator or admins can update.
        if thread.creator_id != user_id {
            require_permission(conn, &user_id, &team_id, db::PERM_MANAGE_MESSAGES)?;
        }

        if let Some(ref title) = body.title {
            thread.title = title.clone();
        }

        db::update_thread(conn, &thread)?;
        Ok(thread)
    })
    .await
    .map_err(map_not_found("thread"))?;

    json_ok(thread)
}

pub async fn delete_thread(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, thread_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    spawn_db(state.db.clone(), move |conn| {
        let thread = get_thread_for_team(conn, &thread_id, &team_id)?;

        // Only creator or admins can delete.
        if thread.creator_id != user_id {
            require_permission(conn, &user_id, &team_id, db::PERM_MANAGE_MESSAGES)?;
        }

        db::delete_thread(conn, &thread_id)?;
        Ok(())
    })
    .await
    .map_err(map_not_found("thread"))?;

    json_ok_true()
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

    let (msg, channel_id) = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id, &team_id)?;
        let thread = get_thread_for_team(conn, &thread_id, &team_id)?;

        let now = db::now_str();
        let msg = db::Message {
            id: db::new_id(),
            channel_id: thread.channel_id.clone(),
            dm_channel_id: String::new(),
            author_id: user_id.clone(),
            content: body.content.clone(),
            msg_type: body.msg_type.clone(),
            thread_id: thread_id.clone(),
            edited_at: None,
            deleted: false,
            lamport_ts: 0, reply_to_message_id: None,
            created_at: now,
        };
        db::create_thread_message(conn, &msg)?;
        Ok((msg, thread.channel_id))
    })
    .await
    .map_err(map_not_found("thread"))?;

    let event_data = serde_json::to_vec(&json!({
        "type": "thread:message:new",
        "payload": msg,
    }))
    .unwrap_or_default();
    state
        .hub
        .broadcast_to_channel(&channel_id, event_data, None)
        .await;

    json_ok(msg)
}

pub async fn list_messages(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, thread_id)): Path<(String, String)>,
    Query(query): Query<ListMessagesQuery>,
) -> Result<Json<Value>, AppError> {
    // MSG-DOS-1 / H6: server-side cap on thread page size.
    let limit = query.limit.clamp(1, crate::api::messages::MAX_PAGE_LIMIT);

    let messages = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id, &team_id)?;

        if db::get_thread(conn, &thread_id)?.is_none() {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }

        db::get_thread_messages(conn, &thread_id, &query.before, limit)
    })
    .await
    .map_err(map_not_found("thread"))?;

    json_ok(messages)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_thread_request_title_defaults_empty() {
        let r: CreateThreadRequest =
            serde_json::from_str(r#"{"parent_message_id":"m1"}"#).unwrap();
        assert_eq!(r.parent_message_id, "m1");
        assert_eq!(r.title, "");
    }

    #[test]
    fn update_thread_request_only_field_is_optional_title() {
        let r: UpdateThreadRequest = serde_json::from_str("{}").unwrap();
        assert!(r.title.is_none());
        let r: UpdateThreadRequest = serde_json::from_str(r#"{"title":"x"}"#).unwrap();
        assert_eq!(r.title.as_deref(), Some("x"));
    }

    #[test]
    fn create_message_request_default_msg_type_is_text() {
        let r: CreateMessageRequest = serde_json::from_str(r#"{"content":"hi"}"#).unwrap();
        assert_eq!(r.msg_type, "text");
    }

    #[test]
    fn create_message_request_renames_type_to_msg_type() {
        let r: CreateMessageRequest =
            serde_json::from_str(r#"{"content":"x","type":"system"}"#).unwrap();
        assert_eq!(r.msg_type, "system");
    }

    #[test]
    fn list_messages_query_defaults_match_messages_handler() {
        // Threads list endpoint mirrors the channel list endpoint
        // defaults — keep them in sync.
        let q: ListMessagesQuery = serde_json::from_str("{}").unwrap();
        assert_eq!(q.before, "");
        assert_eq!(q.limit, 50);
    }
}
