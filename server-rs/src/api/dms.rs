use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::api::helpers::{json_ok, json_ok_true, require_team_member, spawn_db};
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

/// Verify that a user is a member of the given DM channel, returning `Err` if not.
fn require_dm_member(
    conn: &rusqlite::Connection,
    dm_id: &str,
    user_id: &str,
) -> Result<(), rusqlite::Error> {
    if !db::is_dm_member(conn, dm_id, user_id)? {
        return Err(rusqlite::Error::InvalidParameterName(
            "not a member of this DM".into(),
        ));
    }
    Ok(())
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

    let dm = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id, &team_id)?;

        // For 1:1 DMs, check if one already exists.
        if body.user_ids.len() == 1 {
            if let Some(existing) = db::get_dm_channel_by_members(conn, &team_id, &user_id, &body.user_ids[0])? {
                return Ok(existing);
            }
        }

        create_new_dm_channel(conn, &team_id, &user_id, &body)
    })
    .await?;

    json_ok(dm)
}

pub async fn list(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let dms = spawn_db(state.db.clone(), move |conn| {
        db::get_user_dm_channels(conn, &team_id, &user_id)
    })
    .await?;

    json_ok(dms)
}

pub async fn get_dm(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((_team_id, dm_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let data = spawn_db(state.db.clone(), move |conn| {
        require_dm_member(conn, &dm_id, &user_id)?;

        let dm = db::get_dm_channel(conn, &dm_id)?
            .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;

        let members = db::get_dm_members(conn, &dm_id)?;

        Ok(json!({
            "channel": dm,
            "members": members,
        }))
    })
    .await
    .map_err(|e| match e {
        AppError::NotFound(_) => AppError::NotFound("DM channel not found".into()),
        other => other,
    })?;

    Ok(Json(data))
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

    let (msg, member_ids) = spawn_db(state.db.clone(), move |conn| {
        require_dm_member(conn, &dm_id, &user_id)?;

        let now = db::now_str();
        let msg = db::Message {
            id: db::new_id(),
            channel_id: String::new(),
            dm_channel_id: dm_id.clone(),
            author_id: user_id.clone(),
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
        let members = db::get_dm_members(conn, &dm_id)?;
        let member_ids: Vec<String> = members.into_iter().map(|m| m.user_id).collect();

        Ok((msg, member_ids))
    })
    .await?;

    // Notify all DM members via WebSocket.
    let event_data = serde_json::to_vec(&json!({
        "type": "dm:message:new",
        "payload": msg,
    }))
    .unwrap_or_default();
    for member_id in &member_ids {
        state.hub.send_to_user(member_id, event_data.clone()).await;
    }

    json_ok(&msg)
}

pub async fn list_messages(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((_team_id, dm_id)): Path<(String, String)>,
    Query(query): Query<ListMessagesQuery>,
) -> Result<Json<Value>, AppError> {
    let limit = query.limit.clamp(1, 100);

    let messages = spawn_db(state.db.clone(), move |conn| {
        require_dm_member(conn, &dm_id, &user_id)?;
        db::get_dm_messages(conn, &dm_id, &query.before, limit)
    })
    .await?;

    json_ok(messages)
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

    let (msg, member_ids) = spawn_db(state.db.clone(), move |conn| {
        require_dm_member(conn, &dm_id, &user_id)?;

        let msg = db::get_message_by_id(conn, &message_id)?
            .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;

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

        let updated = db::get_message_by_id(conn, &message_id)?
            .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;

        let members = db::get_dm_members(conn, &dm_id)?;
        let member_ids: Vec<String> = members.into_iter().map(|m| m.user_id).collect();

        Ok((updated, member_ids))
    })
    .await
    .map_err(|e| match e {
        AppError::NotFound(_) => AppError::NotFound("message not found".into()),
        other => other,
    })?;

    let event_data = serde_json::to_vec(&json!({
        "type": "dm:message:updated",
        "payload": msg,
    }))
    .unwrap_or_default();
    for member_id in &member_ids {
        state.hub.send_to_user(member_id, event_data.clone()).await;
    }

    json_ok(&msg)
}

pub async fn delete_message(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((_team_id, dm_id, message_id)): Path<(String, String, String)>,
) -> Result<Json<Value>, AppError> {
    let member_ids = spawn_db(state.db.clone(), {
        let dm_id = dm_id.clone();
        let message_id = message_id.clone();
        move |conn| {
            require_dm_member(conn, &dm_id, &user_id)?;

            let msg = db::get_message_by_id(conn, &message_id)?
                .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;

            if msg.author_id != user_id {
                return Err(rusqlite::Error::InvalidParameterName(
                    "can only delete your own messages".into(),
                ));
            }

            db::soft_delete_message(conn, &message_id)?;

            let members = db::get_dm_members(conn, &dm_id)?;
            let member_ids: Vec<String> = members.into_iter().map(|m| m.user_id).collect();

            Ok(member_ids)
        }
    })
    .await
    .map_err(|e| match e {
        AppError::NotFound(_) => AppError::NotFound("message not found".into()),
        other => other,
    })?;

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

    json_ok_true()
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

    let members = spawn_db(state.db.clone(), move |conn| {
        require_dm_member(conn, &dm_id, &user_id)?;

        db::add_dm_members(conn, &dm_id, &body.user_ids)?;

        let members = db::get_dm_members(conn, &dm_id)?;
        Ok(members)
    })
    .await?;

    json_ok(members)
}

pub async fn remove_member(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((_team_id, dm_id, target_user_id)): Path<(String, String, String)>,
) -> Result<Json<Value>, AppError> {
    spawn_db(state.db.clone(), move |conn| {
        require_dm_member(conn, &dm_id, &user_id)?;

        db::remove_dm_member(conn, &dm_id, &target_user_id)?;
        Ok(())
    })
    .await?;

    json_ok_true()
}

/// Create a new DM channel and add all members.
fn create_new_dm_channel(
    conn: &rusqlite::Connection,
    team_id: &str,
    creator_id: &str,
    body: &CreateDMRequest,
) -> Result<db::DMChannel, rusqlite::Error> {
    let dm_type = if body.user_ids.len() > 1 { "group_dm" } else { "dm" };

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

    fn seed_team_and_users(db: &Database) {
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
            db::create_user(conn, &db::User {
                id: "u2".into(),
                username: "bob".into(),
                display_name: "Bob".into(),
                public_key: vec![2u8; 32],
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            })?;
            db::create_user(conn, &db::User {
                id: "u3".into(),
                username: "charlie".into(),
                display_name: "Charlie".into(),
                public_key: vec![3u8; 32],
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
                updated_at: now,
            })
        })
        .unwrap();
    }

    // ── require_dm_member tests ─────────────────────────────────────────

    #[test]
    fn require_dm_member_success() {
        let (db, _tmp) = test_db();
        seed_team_and_users(&db);

        db.with_conn(|conn| {
            let dm = db::DMChannel {
                id: "dm1".into(),
                team_id: "t1".into(),
                dm_type: "dm".into(),
                name: String::new(),
                created_at: db::now_str(),
            };
            db::create_dm_channel(conn, &dm)?;
            db::add_dm_members(conn, "dm1", &["u1".to_string()])?;
            require_dm_member(conn, "dm1", "u1")
        })
        .unwrap();
    }

    #[test]
    fn require_dm_member_not_member_fails() {
        let (db, _tmp) = test_db();
        seed_team_and_users(&db);

        let result = db.with_conn(|conn| {
            let dm = db::DMChannel {
                id: "dm1".into(),
                team_id: "t1".into(),
                dm_type: "dm".into(),
                name: String::new(),
                created_at: db::now_str(),
            };
            db::create_dm_channel(conn, &dm)?;
            db::add_dm_members(conn, "dm1", &["u1".to_string()])?;
            require_dm_member(conn, "dm1", "u2")
        });
        assert!(result.is_err());
        match result.unwrap_err() {
            rusqlite::Error::InvalidParameterName(msg) => {
                assert!(msg.contains("not a member"));
            }
            other => panic!("expected InvalidParameterName, got {:?}", other),
        }
    }

    // ── create_new_dm_channel tests ─────────────────────────────────────

    #[test]
    fn create_new_dm_channel_1on1() {
        let (db, _tmp) = test_db();
        seed_team_and_users(&db);

        let dm = db
            .with_conn(|conn| {
                let body = CreateDMRequest {
                    user_ids: vec!["u2".into()],
                    name: String::new(),
                };
                create_new_dm_channel(conn, "t1", "u1", &body)
            })
            .unwrap();

        assert_eq!(dm.team_id, "t1");
        assert_eq!(dm.dm_type, "dm");

        // Verify members were added.
        let members = db
            .with_conn(|conn| db::get_dm_members(conn, &dm.id))
            .unwrap();
        assert_eq!(members.len(), 2);
        let member_ids: Vec<&str> = members.iter().map(|m| m.user_id.as_str()).collect();
        assert!(member_ids.contains(&"u1"));
        assert!(member_ids.contains(&"u2"));
    }

    #[test]
    fn create_new_dm_channel_group() {
        let (db, _tmp) = test_db();
        seed_team_and_users(&db);

        let dm = db
            .with_conn(|conn| {
                let body = CreateDMRequest {
                    user_ids: vec!["u2".into(), "u3".into()],
                    name: "group chat".into(),
                };
                create_new_dm_channel(conn, "t1", "u1", &body)
            })
            .unwrap();

        assert_eq!(dm.dm_type, "group_dm");
        assert_eq!(dm.name, "group chat");

        let members = db
            .with_conn(|conn| db::get_dm_members(conn, &dm.id))
            .unwrap();
        assert_eq!(members.len(), 3);
    }

    #[test]
    fn create_new_dm_channel_creator_in_user_ids_no_duplicate() {
        let (db, _tmp) = test_db();
        seed_team_and_users(&db);

        let dm = db
            .with_conn(|conn| {
                let body = CreateDMRequest {
                    user_ids: vec!["u1".into(), "u2".into()],
                    name: String::new(),
                };
                create_new_dm_channel(conn, "t1", "u1", &body)
            })
            .unwrap();

        // Creator u1 should not be duplicated even though it's in user_ids.
        let members = db
            .with_conn(|conn| db::get_dm_members(conn, &dm.id))
            .unwrap();
        assert_eq!(members.len(), 2);
    }

    // ── default_msg_type test ─────────────────────────────────────────────

    #[test]
    fn default_msg_type_returns_text() {
        assert_eq!(default_msg_type(), "text");
    }

    // ── default_limit test ────────────────────────────────────────────────

    #[test]
    fn default_limit_returns_50() {
        assert_eq!(default_limit(), 50);
    }

    // ── create_new_dm_channel edge cases ──────────────────────────────────

    #[test]
    fn create_new_dm_channel_with_name() {
        let (db, _tmp) = test_db();
        seed_team_and_users(&db);

        let dm = db
            .with_conn(|conn| {
                let body = CreateDMRequest {
                    user_ids: vec!["u2".into()],
                    name: "Custom DM Name".into(),
                };
                create_new_dm_channel(conn, "t1", "u1", &body)
            })
            .unwrap();

        assert_eq!(dm.name, "Custom DM Name");
        assert_eq!(dm.dm_type, "dm");
    }

    #[test]
    fn create_new_dm_channel_group_has_correct_type() {
        let (db, _tmp) = test_db();
        seed_team_and_users(&db);

        let dm = db
            .with_conn(|conn| {
                let body = CreateDMRequest {
                    user_ids: vec!["u2".into(), "u3".into()],
                    name: String::new(),
                };
                create_new_dm_channel(conn, "t1", "u1", &body)
            })
            .unwrap();

        assert_eq!(dm.dm_type, "group_dm");
    }

    #[test]
    fn require_dm_member_for_nonexistent_dm() {
        let (db, _tmp) = test_db();
        seed_team_and_users(&db);

        let result = db.with_conn(|conn| require_dm_member(conn, "nonexistent-dm", "u1"));
        assert!(result.is_err());
    }
}
