use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::api::AppState;
use crate::auth::UserId;
use crate::db;
use crate::error::AppError;

#[derive(Deserialize)]
pub struct CreateChannelRequest {
    pub name: String,
    #[serde(default)]
    pub topic: String,
    #[serde(rename = "type", default = "default_channel_type")]
    pub channel_type: String,
    #[serde(default)]
    pub category: String,
}

fn default_channel_type() -> String {
    "text".into()
}

#[derive(Deserialize)]
pub struct UpdateChannelRequest {
    pub name: Option<String>,
    pub topic: Option<String>,
    pub position: Option<i32>,
    pub category: Option<String>,
}

pub async fn list(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let tid = team_id.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let member = db::get_member_by_user_and_team(conn, &uid, &tid)?;
            if member.is_none() {
                return Err(rusqlite::Error::InvalidParameterName(
                    "not a member of this team".into(),
                ));
            }
            db::get_channels_by_team(conn, &tid)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(channels) => Ok(Json(json!(channels))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

pub async fn create(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
    Json(body): Json<CreateChannelRequest>,
) -> Result<Json<Value>, AppError> {
    if body.name.is_empty() {
        return Err(AppError::BadRequest("name is required".into()));
    }

    let db = state.db.clone();
    let tid = team_id.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            if !db::user_has_permission(conn, &uid, &tid, db::PERM_MANAGE_CHANNELS)? {
                return Err(rusqlite::Error::InvalidParameterName(
                    "insufficient permissions".into(),
                ));
            }

            let now = db::now_str();
            let channel = db::Channel {
                id: db::new_id(),
                team_id: tid.clone(),
                name: body.name.clone(),
                topic: body.topic.clone(),
                channel_type: body.channel_type.clone(),
                position: 0,
                category: body.category.clone(),
                created_by: uid.clone(),
                created_at: now.clone(),
                updated_at: now.clone(),
            };
            db::create_channel(conn, &channel)?;
            Ok(channel)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(channel) => Ok(Json(json!(channel))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

pub async fn get_channel(
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

            let channel = db::get_channel_by_id(conn, &cid)?;
            match channel {
                Some(ch) if ch.team_id == tid => Ok(ch),
                Some(_) => Err(rusqlite::Error::InvalidParameterName(
                    "channel does not belong to this team".into(),
                )),
                None => Err(rusqlite::Error::QueryReturnedNoRows),
            }
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(channel) => Ok(Json(json!(channel))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(AppError::NotFound("channel not found".into()))
        }
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

pub async fn update(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, channel_id)): Path<(String, String)>,
    Json(body): Json<UpdateChannelRequest>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let tid = team_id.clone();
    let cid = channel_id.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            if !db::user_has_permission(conn, &uid, &tid, db::PERM_MANAGE_CHANNELS)? {
                return Err(rusqlite::Error::InvalidParameterName(
                    "insufficient permissions".into(),
                ));
            }

            let mut channel = get_channel_for_team(conn, &cid, &tid)?;
            apply_channel_updates(&mut channel, &body);
            db::update_channel(conn, &channel)?;
            Ok(channel)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(channel) => Ok(Json(json!(channel))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(AppError::NotFound("channel not found".into()))
        }
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

/// Fetch a channel by ID and verify it belongs to the given team.
fn get_channel_for_team(
    conn: &rusqlite::Connection,
    channel_id: &str,
    team_id: &str,
) -> Result<db::Channel, rusqlite::Error> {
    let channel = db::get_channel_by_id(conn, channel_id)?
        .ok_or(rusqlite::Error::QueryReturnedNoRows)?;

    if channel.team_id != team_id {
        return Err(rusqlite::Error::InvalidParameterName(
            "channel does not belong to this team".into(),
        ));
    }
    Ok(channel)
}

/// Apply optional update fields to a channel.
fn apply_channel_updates(channel: &mut db::Channel, body: &UpdateChannelRequest) {
    if let Some(ref name) = body.name {
        channel.name = name.clone();
    }
    if let Some(ref topic) = body.topic {
        channel.topic = topic.clone();
    }
    if let Some(pos) = body.position {
        channel.position = pos;
    }
    if let Some(ref cat) = body.category {
        channel.category = cat.clone();
    }
}

pub async fn delete_channel(
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
            if !db::user_has_permission(conn, &uid, &tid, db::PERM_MANAGE_CHANNELS)? {
                return Err(rusqlite::Error::InvalidParameterName(
                    "insufficient permissions".into(),
                ));
            }

            let channel = db::get_channel_by_id(conn, &cid)?;
            match channel {
                Some(ch) if ch.team_id == tid => {
                    db::delete_channel(conn, &cid)?;
                    Ok(())
                }
                Some(_) => Err(rusqlite::Error::InvalidParameterName(
                    "channel does not belong to this team".into(),
                )),
                None => Err(rusqlite::Error::QueryReturnedNoRows),
            }
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(()) => Ok(Json(json!({ "ok": true }))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(AppError::NotFound("channel not found".into()))
        }
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}
