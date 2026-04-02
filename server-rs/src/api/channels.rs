use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::Value;

use rusqlite::OptionalExtension;

use crate::api::helpers::{json_ok, json_ok_true, require_permission, require_team_member, spawn_db};
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
    let channels = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id, &team_id)?;
        db::get_channels_by_team(conn, &team_id)
    })
    .await?;

    json_ok(channels)
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

    if body.name.len() > 100 {
        return Err(AppError::BadRequest("name too long (max 100 chars)".into()));
    }

    if body.topic.len() > 1024 {
        return Err(AppError::BadRequest("topic too long (max 1024 chars)".into()));
    }

    let channel = spawn_db(state.db.clone(), move |conn| {
        require_permission(conn, &user_id, &team_id, db::PERM_MANAGE_CHANNELS)?;

        let now = db::now_str();
        let channel = db::Channel {
            id: db::new_id(),
            team_id: team_id.clone(),
            name: body.name.clone(),
            topic: body.topic.clone(),
            channel_type: body.channel_type.clone(),
            position: 0,
            category: body.category.clone(),
            created_by: user_id.clone(),
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        db::create_channel(conn, &channel)?;
        Ok(channel)
    })
    .await?;

    json_ok(channel)
}

pub async fn get_channel(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, channel_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let channel = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id, &team_id)?;
        get_channel_for_team(conn, &channel_id, &team_id)
    })
    .await
    .map_err(|e| match e {
        AppError::NotFound(_) => AppError::NotFound("channel not found".into()),
        other => other,
    })?;

    json_ok(channel)
}

pub async fn update(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, channel_id)): Path<(String, String)>,
    Json(body): Json<UpdateChannelRequest>,
) -> Result<Json<Value>, AppError> {
    if let Some(ref name) = body.name {
        if name.len() > 100 {
            return Err(AppError::BadRequest("name too long (max 100 chars)".into()));
        }
    }
    if let Some(ref topic) = body.topic {
        if topic.len() > 1024 {
            return Err(AppError::BadRequest("topic too long (max 1024 chars)".into()));
        }
    }

    let channel = spawn_db(state.db.clone(), move |conn| {
        require_permission(conn, &user_id, &team_id, db::PERM_MANAGE_CHANNELS)?;

        let mut channel = get_channel_for_team(conn, &channel_id, &team_id)?;
        apply_channel_updates(&mut channel, &body);
        db::update_channel(conn, &channel)?;
        Ok(channel)
    })
    .await
    .map_err(|e| match e {
        AppError::NotFound(_) => AppError::NotFound("channel not found".into()),
        other => other,
    })?;

    json_ok(channel)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{self, Database};

    fn test_db() -> (Database, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
        db.run_migrations().unwrap();
        (db, tmp)
    }

    fn make_channel(id: &str, team_id: &str) -> db::Channel {
        let now = db::now_str();
        db::Channel {
            id: id.into(),
            team_id: team_id.into(),
            name: "general".into(),
            topic: "General chat".into(),
            channel_type: "text".into(),
            position: 0,
            category: String::new(),
            created_by: "u1".into(),
            created_at: now.clone(),
            updated_at: now,
        }
    }

    fn seed_team_and_channel(db: &Database) {
        let now = db::now_str();
        db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: "u1".into(),
                username: "alice".into(),
                display_name: "Alice".into(),
                public_key: vec![1u8; 32],
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            })?;
            db::create_team(conn, &db::Team {
                id: "t1".into(),
                name: "Team".into(),
                description: String::new(),
                icon_url: String::new(),
                created_by: "u1".into(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                created_at: now.clone(),
                updated_at: now.clone(),
            })?;
            db::create_channel(conn, &make_channel("c1", "t1"))
        })
        .unwrap();
    }

    // ── get_channel_for_team tests ──────────────────────────────────────

    #[test]
    fn get_channel_for_team_success() {
        let (db, _tmp) = test_db();
        seed_team_and_channel(&db);

        let channel = db
            .with_conn(|conn| get_channel_for_team(conn, "c1", "t1"))
            .unwrap();
        assert_eq!(channel.id, "c1");
        assert_eq!(channel.team_id, "t1");
    }

    #[test]
    fn get_channel_for_team_wrong_team() {
        let (db, _tmp) = test_db();
        seed_team_and_channel(&db);

        let result = db.with_conn(|conn| get_channel_for_team(conn, "c1", "other_team"));
        assert!(result.is_err());
        match result.unwrap_err() {
            rusqlite::Error::InvalidParameterName(msg) => {
                assert!(msg.contains("does not belong"));
            }
            other => panic!("expected InvalidParameterName, got {:?}", other),
        }
    }

    #[test]
    fn get_channel_for_team_not_found() {
        let (db, _tmp) = test_db();
        seed_team_and_channel(&db);

        let result = db.with_conn(|conn| get_channel_for_team(conn, "nonexistent", "t1"));
        assert!(result.is_err());
        match result.unwrap_err() {
            rusqlite::Error::QueryReturnedNoRows => {}
            other => panic!("expected QueryReturnedNoRows, got {:?}", other),
        }
    }

    // ── apply_channel_updates tests ─────────────────────────────────────

    #[test]
    fn apply_channel_updates_all_fields() {
        let mut channel = make_channel("c1", "t1");

        let body = UpdateChannelRequest {
            name: Some("renamed".into()),
            topic: Some("new topic".into()),
            position: Some(5),
            category: Some("voice".into()),
        };

        apply_channel_updates(&mut channel, &body);

        assert_eq!(channel.name, "renamed");
        assert_eq!(channel.topic, "new topic");
        assert_eq!(channel.position, 5);
        assert_eq!(channel.category, "voice");
    }

    #[test]
    fn apply_channel_updates_no_fields() {
        let mut channel = make_channel("c1", "t1");
        let original_name = channel.name.clone();
        let original_topic = channel.topic.clone();
        let original_pos = channel.position;

        let body = UpdateChannelRequest {
            name: None,
            topic: None,
            position: None,
            category: None,
        };

        apply_channel_updates(&mut channel, &body);

        assert_eq!(channel.name, original_name);
        assert_eq!(channel.topic, original_topic);
        assert_eq!(channel.position, original_pos);
    }

    #[test]
    fn apply_channel_updates_partial() {
        let mut channel = make_channel("c1", "t1");

        let body = UpdateChannelRequest {
            name: Some("new-name".into()),
            topic: None,
            position: None,
            category: None,
        };

        apply_channel_updates(&mut channel, &body);

        assert_eq!(channel.name, "new-name");
        assert_eq!(channel.topic, "General chat");
    }
}

pub async fn mark_read(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, channel_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let result = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id, &team_id)?;

        // Verify channel belongs to the team
        let channel = db::get_channel_by_id(conn, &channel_id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        if channel.team_id != team_id {
            return Err(rusqlite::Error::InvalidParameterName(
                "channel does not belong to this team".into(),
            ));
        }

        // Get the latest message in the channel
        let latest_msg_id: Option<String> = conn
            .query_row(
                "SELECT id FROM messages WHERE channel_id = ?1 AND deleted = 0
                 ORDER BY created_at DESC LIMIT 1",
                [&channel_id],
                |row| row.get(0),
            )
            .optional()?;

        let message_id = latest_msg_id.unwrap_or_default();
        db::mark_channel_read(conn, &user_id, &channel_id, &message_id)?;

        let last_read_at = conn
            .query_row(
                "SELECT last_read_at FROM channel_reads WHERE user_id = ?1 AND channel_id = ?2",
                rusqlite::params![user_id, channel_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_default();

        Ok(serde_json::json!({
            "last_read_message_id": message_id,
            "last_read_at": last_read_at,
        }))
    })
    .await?;

    json_ok(result)
}

pub async fn delete_channel(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, channel_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    spawn_db(state.db.clone(), move |conn| {
        require_permission(conn, &user_id, &team_id, db::PERM_MANAGE_CHANNELS)?;

        let channel = db::get_channel_by_id(conn, &channel_id)?;
        match channel {
            Some(ch) if ch.team_id == team_id => {
                db::delete_channel(conn, &channel_id)?;
                Ok(())
            }
            Some(_) => Err(rusqlite::Error::InvalidParameterName(
                "channel does not belong to this team".into(),
            )),
            None => Err(rusqlite::Error::QueryReturnedNoRows),
        }
    })
    .await
    .map_err(|e| match e {
        AppError::NotFound(_) => AppError::NotFound("channel not found".into()),
        other => other,
    })?;

    json_ok_true()
}
