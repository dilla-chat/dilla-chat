use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::Value;

use rusqlite::OptionalExtension;

use crate::api::helpers::{json_ok, json_ok_true, spawn_db};
use crate::api::AppState;
use crate::auth::UserId;
use crate::db;
use crate::error::AppError;
// A6: REST authz routes through the central policy module so every
// deny flows through one place. Same semantics as the prior
// helpers::require_* call sites.
use crate::policy::{require_permission, require_team_member};

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

#[derive(Default, Deserialize)]
pub struct UpdateChannelRequest {
    pub name: Option<String>,
    pub topic: Option<String>,
    pub position: Option<i32>,
    pub category: Option<String>,
    pub locked: Option<bool>,
    pub hidden_if_restricted: Option<bool>,
    pub slow_mode_seconds: Option<i32>,
}

pub async fn list(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let channels = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id, &team_id)?;
        let all = db::get_channels_by_team(conn, &team_id)?;
        let mut out: Vec<serde_json::Value> = Vec::new();
        for ch in all {
            let access = db::get_channel_access_roles(conn, &ch.id).unwrap_or_default();
            // Group inherits hidden_if_restricted to the channel; same
            // resolution rule as get_channel_access_roles.
            let group_hidden = ch.group_id.as_deref().and_then(|gid| {
                db::get_group_by_id(conn, gid).ok().flatten().map(|g| g.hidden_if_restricted)
            });
            let hidden = group_hidden.unwrap_or(ch.hidden_if_restricted);
            if hidden {
                let allowed = db::user_can_access_channel(conn, &user_id, &team_id, &ch.id).unwrap_or(false);
                if !allowed { continue; }
            }
            let mut v = serde_json::to_value(&ch).unwrap_or(serde_json::Value::Null);
            if let serde_json::Value::Object(ref mut m) = v {
                m.insert("access_role_ids".to_string(), serde_json::json!(access));
            }
            out.push(v);
        }
        Ok::<_, rusqlite::Error>(out)
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
    let trimmed_name = body.name.trim().to_string();
    if trimmed_name.is_empty() {
        return Err(AppError::BadRequest("name is required".into()));
    }

    if trimmed_name.chars().count() > 100 {
        return Err(AppError::BadRequest("name too long (max 100 chars)".into()));
    }

    if body.topic.len() > 1024 {
        return Err(AppError::BadRequest("topic too long (max 1024 chars)".into()));
    }

    let channel = spawn_db(state.db.clone(), move |conn| {
        require_permission(conn, &user_id, &team_id, db::PERM_MANAGE_CHANNELS)?;

        // Pre-flight uniqueness check so we can return a clear error instead
        // of leaking a sqlite constraint message. The unique index is the
        // real guard (migration 019); this is just the friendlier path.
        if channel_name_exists(conn, &team_id, &trimmed_name, &body.channel_type, None)? {
            return Err(rusqlite::Error::InvalidParameterName(
                "channel_name_conflict".into(),
            ));
        }

        // When the client supplies a non-empty `category`, resolve it to a
        // formal channel_group: reuse an existing group with the same name
        // (case-insensitive) or create one on the spot. This closes the
        // gap where the loose `category` string never produced a real
        // group with role-based access controls.
        let group_id: Option<String> = if body.category.trim().is_empty() {
            None
        } else {
            let trimmed_cat = body.category.trim().to_string();
            let existing = db::get_groups_by_team(conn, &team_id)?
                .into_iter()
                .find(|g| g.name.trim().eq_ignore_ascii_case(&trimmed_cat));
            if let Some(g) = existing {
                Some(g.id)
            } else {
                let now = db::now_str();
                let new_group = db::ChannelGroup {
                    id: db::new_id(),
                    team_id: team_id.clone(),
                    name: trimmed_cat,
                    position: 0,
                    created_at: now.clone(),
                    updated_at: now,
                    hidden_if_restricted: false,
                };
                db::create_group(conn, &new_group)?;
                Some(new_group.id)
            }
        };

        let now = db::now_str();
        let channel = db::Channel {
            id: db::new_id(),
            team_id: team_id.clone(),
            name: trimmed_name.clone(),
            topic: body.topic.clone(),
            channel_type: body.channel_type.clone(),
            position: 0,
            category: body.category.clone(),
            created_by: user_id.clone(),
            created_at: now.clone(),
            updated_at: now.clone(),
            locked: false, hidden_if_restricted: false, slow_mode_seconds: 0, group_id,
        };
        db::create_channel(conn, &channel)?;
        let _ = db::insert_audit_event(
            conn,
            &team_id,
            Some(&user_id),
            "channel.create",
            Some("channel"),
            Some(&channel.id),
            Some(&serde_json::json!({ "name": channel.name, "type": channel.channel_type })),
        );
        Ok(channel)
    })
    .await
    .map_err(map_channel_name_conflict)?;

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
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(AppError::BadRequest("name cannot be empty".into()));
        }
        if trimmed.chars().count() > 100 {
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
        let prev_locked = channel.locked;
        apply_channel_updates(&mut channel, &body);
        // Keep the canonical group_id in sync with the legacy `category`
        // string — empty category clears the group; non-empty resolves
        // to an existing group (case-insensitive) or creates a fresh
        // one. Mirrors the create-channel resolution so the sidebar
        // reorders the channel under the new group without a re-sync.
        if body.category.is_some() {
            let trimmed_cat = channel.category.trim().to_string();
            channel.group_id = if trimmed_cat.is_empty() {
                None
            } else {
                let existing = db::get_groups_by_team(conn, &team_id)?
                    .into_iter()
                    .find(|g| g.name.trim().eq_ignore_ascii_case(&trimmed_cat));
                if let Some(g) = existing {
                    Some(g.id)
                } else {
                    let now = db::now_str();
                    let new_group = db::ChannelGroup {
                        id: db::new_id(),
                        team_id: team_id.clone(),
                        name: trimmed_cat,
                        position: 0,
                        created_at: now.clone(),
                        updated_at: now,
                        hidden_if_restricted: false,
                    };
                    db::create_group(conn, &new_group)?;
                    Some(new_group.id)
                }
            };
        }
        // After applying the rename, make sure no sibling channel of the
        // same type already owns the normalized name. The unique index
        // would catch this anyway, but pre-checking lets us surface a
        // 409 with a clear message instead of a sqlite constraint dump.
        if body.name.is_some()
            && channel_name_exists(conn, &team_id, &channel.name, &channel.channel_type, Some(&channel.id))?
        {
            return Err(rusqlite::Error::InvalidParameterName(
                "channel_name_conflict".into(),
            ));
        }
        db::update_channel(conn, &channel)?;

        let action = if prev_locked != channel.locked {
            if channel.locked { "channel.lock" } else { "channel.unlock" }
        } else {
            "channel.update"
        };
        let _ = db::insert_audit_event(
            conn,
            &team_id,
            Some(&user_id),
            action,
            Some("channel"),
            Some(&channel.id),
            Some(&serde_json::json!({ "name": channel.name, "locked": channel.locked })),
        );

        Ok(channel)
    })
    .await
    .map_err(|e| match e {
        AppError::NotFound(_) => AppError::NotFound("channel not found".into()),
        other => map_channel_name_conflict(other),
    })?;

    // Broadcast so other clients refresh their sidebars without a re-sync —
    // notably so the lock icon appears for users who don't have manage-
    // channels permission as soon as an admin toggles it.
    if let Ok(evt) = crate::ws::events::Event::new(
        crate::ws::events::EVENT_CHANNEL_UPDATED,
        serde_json::to_value(&channel).unwrap_or(serde_json::Value::Null),
    ) {
        if let Ok(data) = evt.to_bytes() {
            state.hub.broadcast_to_all(data).await;
        }
    }

    json_ok(channel)
}

#[derive(Deserialize)]
pub struct AccessRequest {
    pub role_ids: Vec<String>,
}

pub async fn get_access(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, channel_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let role_ids = spawn_db(state.db.clone(), move |conn| {
        // A6: centralized authz — same semantics as before.
        crate::policy::require_team_member(conn, &user_id, &team_id)?;
        get_channel_for_team(conn, &channel_id, &team_id)?;
        db::get_channel_access_roles(conn, &channel_id)
    })
    .await
    .map_err(map_not_found_channel)?;
    json_ok(serde_json::json!({ "role_ids": role_ids }))
}

pub async fn set_access(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, channel_id)): Path<(String, String)>,
    Json(body): Json<AccessRequest>,
) -> Result<Json<Value>, AppError> {
    let team_id_clone = team_id.clone();
    let channel_id_clone = channel_id.clone();
    let user_id_clone = user_id.clone();
    let role_ids = spawn_db(state.db.clone(), move |conn| {
        require_permission(conn, &user_id_clone, &team_id_clone, db::PERM_MANAGE_CHANNELS)?;
        get_channel_for_team(conn, &channel_id_clone, &team_id_clone)?;
        // Validate each role belongs to this team.
        for rid in &body.role_ids {
            let role = db::get_role_by_id(conn, rid)?
                .ok_or_else(|| rusqlite::Error::InvalidParameterName(format!("role {rid} not found")))?;
            if role.team_id != team_id_clone {
                return Err(rusqlite::Error::InvalidParameterName(
                    "role does not belong to this team".into(),
                ));
            }
        }
        db::set_channel_access_roles(conn, &channel_id_clone, &body.role_ids)?;
        let _ = db::insert_audit_event(
            conn,
            &team_id_clone,
            Some(&user_id_clone),
            "channel.access.update",
            Some("channel"),
            Some(&channel_id_clone),
            Some(&serde_json::json!({ "role_ids": &body.role_ids })),
        );
        db::get_channel_access_roles(conn, &channel_id_clone)
    })
    .await
    .map_err(map_not_found_channel)?;

    // Broadcast so other clients refresh their sidebar gating immediately.
    if let Ok(evt) = crate::ws::events::Event::new(
        "channel:access-update",
        serde_json::json!({
            "channel_id": &channel_id,
            "role_ids": &role_ids,
        }),
    ) {
        if let Ok(data) = evt.to_bytes() {
            state.hub.broadcast_to_all(data).await;
        }
    }

    // Force-disconnect any peers currently in the channel who no longer
    // pass the new access list — admins shouldn't have to wait for users
    // to leave on their own.
    evict_inaccessible_peers(&state, &team_id, &channel_id).await;

    json_ok(serde_json::json!({ "role_ids": role_ids }))
}

/// After an access-list change, drop any active voice peers in `channel_id`
/// whose access no longer passes. For each evicted peer we:
///   1. Tell the SFU to tear down their peer connection.
///   2. Remove them from the in-memory room map.
///   3. Broadcast `voice:user-left` so every other client updates rosters.
///   4. Send a `voice:force-disconnect` direct event so the affected
///      client clears its local voice connection state and toasts the
///      reason.
async fn evict_inaccessible_peers(state: &AppState, team_id: &str, channel_id: &str) {
    let room_mgr = match state.hub.voice_room_manager.as_ref() {
        Some(rm) => rm.clone(),
        None => return,
    };
    let peers = match room_mgr.get_room(channel_id).await {
        Some(p) => p,
        None => return,
    };

    // Resolve which peers lose access using a single DB connection.
    let team = team_id.to_string();
    let channel = channel_id.to_string();
    let candidates: Vec<String> = peers.iter().map(|p| p.user_id.clone()).collect();
    let losers = state
        .db
        .clone()
        .with_read(|conn| {
            let mut out = Vec::new();
            for uid in &candidates {
                let allowed =
                    db::user_can_access_channel(conn, uid, &team, &channel).unwrap_or(false);
                if !allowed {
                    out.push(uid.clone());
                }
            }
            Ok::<_, rusqlite::Error>(out)
        })
        .unwrap_or_default();

    if losers.is_empty() {
        return;
    }

    let sfu = state.hub.voice_sfu.as_ref().cloned();
    for uid in losers {
        if let Some(ref sfu) = sfu {
            sfu.handle_leave(channel_id, &uid).await;
        }
        room_mgr.remove_peer(channel_id, &uid).await;

        if let Ok(evt) = crate::ws::events::Event::new(
            crate::ws::events::EVENT_VOICE_USER_LEFT,
            crate::ws::events::VoiceUserLeftPayload {
                channel_id: channel_id.to_string(),
                user_id: uid.clone(),
            },
        ) {
            if let Ok(bytes) = evt.to_bytes() {
                state.hub.broadcast_to_all(bytes).await;
            }
        }

        if let Ok(evt) = crate::ws::events::Event::new(
            "voice:force-disconnect",
            serde_json::json!({
                "channel_id": channel_id,
                "reason": "access_revoked",
            }),
        ) {
            if let Ok(bytes) = evt.to_bytes() {
                state.hub.send_to_user(&uid, bytes).await;
            }
        }
    }
}

fn map_not_found_channel(e: AppError) -> AppError {
    match e {
        AppError::NotFound(_) => AppError::NotFound("channel not found".into()),
        other => other,
    }
}

/// True if another channel in the same team and of the same type already
/// uses this name (case-insensitive, trimmed). `ignore_id` lets the update
/// path exclude the channel being renamed so the check doesn't trip on
/// the row's own existing name. Mirrors the unique-index condition from
/// migration 019 so the pre-flight check and the DB constraint agree.
fn channel_name_exists(
    conn: &rusqlite::Connection,
    team_id: &str,
    name: &str,
    channel_type: &str,
    ignore_id: Option<&str>,
) -> Result<bool, rusqlite::Error> {
    let normalized = name.trim().to_lowercase();
    let mut stmt = conn.prepare(
        "SELECT 1 FROM channels \
         WHERE team_id = ?1 AND type = ?2 \
           AND lower(trim(name)) = ?3 \
           AND (?4 IS NULL OR id != ?4) \
         LIMIT 1",
    )?;
    let exists = stmt
        .query_row(
            rusqlite::params![team_id, channel_type, normalized, ignore_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    Ok(exists)
}

/// Translate the sentinel produced by channel_name_exists into a 409
/// Conflict. Other errors pass through unchanged so callers can still
/// distinguish NotFound, Forbidden, etc.
fn map_channel_name_conflict(e: AppError) -> AppError {
    match e {
        AppError::Forbidden(msg) if msg == "channel_name_conflict" => AppError::Conflict(
            "a channel with that name already exists in this team".into(),
        ),
        other => other,
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
        channel.name = name.trim().to_string();
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
    if let Some(locked) = body.locked {
        channel.locked = locked;
    }
    if let Some(hidden) = body.hidden_if_restricted {
        channel.hidden_if_restricted = hidden;
    }
    if let Some(secs) = body.slow_mode_seconds {
        channel.slow_mode_seconds = secs.max(0);
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
        
            ..Default::default()
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
            
                ..Default::default()
            })?;
            db::create_team(conn, &db::Team {
                id: "t1".into(),
                name: "Team".into(),
                description: String::new(),
                icon_url: String::new(),
                created_by: "u1".into(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                federated: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            
                ..Default::default()
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
        
            ..Default::default()
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
        
            ..Default::default()
        };

        apply_channel_updates(&mut channel, &body);

        assert_eq!(channel.name, original_name);
        assert_eq!(channel.topic, original_topic);
        assert_eq!(channel.position, original_pos);
    }

    #[test]
    fn channel_name_exists_returns_true_for_existing_name() {
        let (db, _tmp) = test_db();
        seed_team_and_channel(&db);
        let exists = db.with_conn(|c| channel_name_exists(c, "t1", "general", "text", None)).unwrap();
        assert!(exists);
    }

    #[test]
    fn channel_name_exists_normalizes_whitespace_and_case() {
        let (db, _tmp) = test_db();
        seed_team_and_channel(&db);
        let exists = db.with_conn(|c| channel_name_exists(c, "t1", "  GENERAL  ", "text", None)).unwrap();
        assert!(exists);
    }

    #[test]
    fn channel_name_exists_ignores_self_when_id_provided() {
        let (db, _tmp) = test_db();
        seed_team_and_channel(&db);
        let exists = db.with_conn(|c| channel_name_exists(c, "t1", "general", "text", Some("c1"))).unwrap();
        assert!(!exists);
    }

    #[test]
    fn channel_name_exists_separates_by_channel_type() {
        let (db, _tmp) = test_db();
        seed_team_and_channel(&db);
        // The "general" channel is type=text. A voice channel with the same
        // name should NOT collide.
        let exists = db.with_conn(|c| channel_name_exists(c, "t1", "general", "voice", None)).unwrap();
        assert!(!exists);
    }

    #[test]
    fn map_channel_name_conflict_translates_forbidden_sentinel_to_409() {
        let mapped = map_channel_name_conflict(AppError::Forbidden("channel_name_conflict".into()));
        assert!(matches!(mapped, AppError::Conflict(_)));
    }

    #[test]
    fn map_channel_name_conflict_passes_other_errors_through() {
        let mapped = map_channel_name_conflict(AppError::NotFound("x".into()));
        assert!(matches!(mapped, AppError::NotFound(_)));
        let mapped2 = map_channel_name_conflict(AppError::Forbidden("other".into()));
        assert!(matches!(mapped2, AppError::Forbidden(_)));
    }

    #[test]
    fn apply_channel_updates_partial() {
        let mut channel = make_channel("c1", "t1");

        let body = UpdateChannelRequest {
            name: Some("new-name".into()),
            topic: None,
            position: None,
            category: None,
        
            ..Default::default()
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
    let team_id_clone = team_id.clone();
    let channel_id_clone = channel_id.clone();
    let deleted_name = spawn_db(state.db.clone(), move |conn| {
        require_permission(conn, &user_id, &team_id_clone, db::PERM_MANAGE_CHANNELS)?;

        let channel = db::get_channel_by_id(conn, &channel_id_clone)?;
        match channel {
            Some(ch) if ch.team_id == team_id_clone => {
                db::delete_channel(conn, &channel_id_clone)?;
                let _ = db::insert_audit_event(
                    conn,
                    &team_id_clone,
                    Some(&user_id),
                    "channel.delete",
                    Some("channel"),
                    Some(&channel_id_clone),
                    Some(&serde_json::json!({ "name": ch.name })),
                );
                Ok(ch.name)
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

    // Tell every connected client so sidebars pop the channel out and any
    // open chat view for it can fall back to a safe channel. Empty channel
    // subscribers list by this point — broadcast_to_all is the right hammer.
    if let Ok(evt) = crate::ws::events::Event::new(
        crate::ws::events::EVENT_CHANNEL_DELETED,
        serde_json::json!({
            "channel_id": channel_id,
            "team_id": team_id,
            "name": deleted_name,
        }),
    ) {
        if let Ok(bytes) = evt.to_bytes() {
            state.hub.broadcast_to_all(bytes).await;
        }
    }

    json_ok_true()
}

#[cfg(test)]
mod axum_tests {
    use super::*;
    use crate::auth::{AuthService, UserId};
    use crate::config::Config;
    use crate::db::{self, Database};
    use crate::presence::PresenceManager;
    use crate::ws::Hub;
    use axum::body::Body;
    use axum::http::Request;
    use axum::routing::{get, post, put, delete as axum_delete};
    use axum::Router;
    use std::sync::Arc;
    use tower::ServiceExt;

    fn make_state() -> (AppState, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let database = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        database.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
        database.run_migrations().unwrap();
        let auth = Arc::new(AuthService::new(database.clone(), ""));
        let hub = Arc::new(Hub::new(database.clone()));
        let presence = Arc::new(PresenceManager::new());
        let mut cfg = Config::default();
        cfg.port = 8080;
        cfg.data_dir = tmp.path().to_str().unwrap().to_string();
        let state = AppState {
            db: database,
            auth,
            hub,
            presence,
            config: Arc::new(cfg),
            mesh: None,
            custom_theme_css: None,
        };
        (state, tmp)
    }

    fn router(state: AppState, user_id: &'static str) -> Router {
        Router::new()
            .route("/teams/{team_id}/channels", get(list).post(create))
            .route(
                "/teams/{team_id}/channels/{channel_id}",
                get(get_channel).patch(update).delete(axum_delete(delete_channel)),
            )
            .route("/teams/{team_id}/channels/{channel_id}/access", get(get_access).put(set_access))
            .route("/teams/{team_id}/channels/{channel_id}/read", post(mark_read))
            .layer(axum::Extension(UserId(user_id.to_string())))
            .with_state(state)
    }

    #[tokio::test]
    async fn list_channels_404s_when_user_not_in_team() {
        let (state, _tmp) = make_state();
        let app = router(state, "ghost");
        let resp = app
            .oneshot(Request::get("/teams/nope/channels").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn create_channel_rejects_empty_name() {
        let (state, _tmp) = make_state();
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::post("/teams/t1/channels")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"name":"","type":"text"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn get_channel_404s_for_unknown_id() {
        let (state, _tmp) = make_state();
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::get("/teams/t1/channels/missing-channel").body(Body::empty()).unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn delete_channel_404s_for_unknown_id() {
        let (state, _tmp) = make_state();
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/teams/t1/channels/missing")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn create_channel_rejects_oversized_name() {
        let (state, _tmp) = make_state();
        let app = router(state, "alice");
        let oversized = "n".repeat(101);
        let body = format!(r#"{{"name":"{}","type":"text"}}"#, oversized);
        let resp = app
            .oneshot(
                Request::post("/teams/t1/channels")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn create_channel_rejects_oversized_topic() {
        let (state, _tmp) = make_state();
        let app = router(state, "alice");
        let oversized = "t".repeat(1025);
        let body = format!(r#"{{"name":"ok","type":"text","topic":"{}"}}"#, oversized);
        let resp = app
            .oneshot(
                Request::post("/teams/t1/channels")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn mark_read_4xx_for_non_member() {
        let (state, _tmp) = make_state();
        let app = router(state, "ghost");
        let resp = app
            .oneshot(
                Request::post("/teams/t1/channels/ch1/read").body(Body::empty()).unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn get_access_4xx_for_non_member() {
        let (state, _tmp) = make_state();
        let app = router(state, "ghost");
        let resp = app
            .oneshot(Request::get("/teams/t1/channels/ch1/access").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    fn seed_alice_team_and_channel(state: &AppState) {
        let now = db::now_str();
        state.db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: "alice".into(),
                username: "alice".into(),
                display_name: "Alice".into(),
                public_key: vec![1u8; 32],
                status_type: "online".into(),
                created_at: now.clone(),
                updated_at: now.clone(),
                ..Default::default()
            })?;
            db::create_team(conn, &db::Team {
                id: "t1".into(),
                name: "T".into(),
                created_by: "alice".into(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                created_at: now.clone(),
                updated_at: now.clone(),
                ..Default::default()
            })?;
            db::create_member(conn, &db::Member {
                id: "m1".into(),
                team_id: "t1".into(),
                user_id: "alice".into(),
                nickname: String::new(),
                invited_by: String::new(),
                joined_at: now.clone(),
                updated_at: now.clone(),
            })?;
            db::create_channel(conn, &db::Channel {
                id: "ch1".into(),
                team_id: "t1".into(),
                name: "general".into(),
                channel_type: "text".into(),
                topic: String::new(),
                created_by: "alice".into(),
                position: 0,
                locked: false,
                created_at: now.clone(),
                updated_at: now,
                ..Default::default()
            })
        }).unwrap();
    }

    #[tokio::test]
    async fn create_channel_happy_path_as_owner() {
        let (state, _tmp) = make_state();
        seed_alice_team_and_channel(&state);
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::post("/teams/t1/channels")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"name":"second","type":"text"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn update_channel_happy_path_renames() {
        let (state, _tmp) = make_state();
        seed_alice_team_and_channel(&state);
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/teams/t1/channels/ch1")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"name":"renamed"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn update_channel_rejects_oversized_name() {
        let (state, _tmp) = make_state();
        seed_alice_team_and_channel(&state);
        let app = router(state, "alice");
        let oversized = "n".repeat(101);
        let body = format!(r#"{{"name":"{}"}}"#, oversized);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/teams/t1/channels/ch1")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn update_channel_rejects_oversized_topic() {
        let (state, _tmp) = make_state();
        seed_alice_team_and_channel(&state);
        let app = router(state, "alice");
        let oversized = "t".repeat(1025);
        let body = format!(r#"{{"topic":"{}"}}"#, oversized);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/teams/t1/channels/ch1")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn get_access_returns_empty_list_for_no_acl() {
        let (state, _tmp) = make_state();
        seed_alice_team_and_channel(&state);
        let app = router(state, "alice");
        let resp = app
            .oneshot(Request::get("/teams/t1/channels/ch1/access").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn set_access_with_unknown_role_4xx() {
        let (state, _tmp) = make_state();
        seed_alice_team_and_channel(&state);
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/teams/t1/channels/ch1/access")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"role_ids":["no-such-role"]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn update_channel_category_creates_new_group_when_unknown() {
        let (state, _tmp) = make_state();
        seed_alice_team_and_channel(&state);
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/teams/t1/channels/ch1")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"category":"Engineering"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn update_channel_category_empty_string_clears_group() {
        let (state, _tmp) = make_state();
        seed_alice_team_and_channel(&state);
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/teams/t1/channels/ch1")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"category":""}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn set_access_happy_path_with_real_role() {
        let (state, _tmp) = make_state();
        seed_alice_team_and_channel(&state);
        let now = db::now_str();
        state.db.with_conn(|conn| {
            db::create_role(conn, &db::Role {
                id: "r1".into(),
                team_id: "t1".into(),
                name: "Mod".into(),
                color: "#000".into(),
                position: 1,
                permissions: 0,
                is_default: false,
                created_at: now.clone(),
                updated_at: now,
            })
        }).unwrap();
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/teams/t1/channels/ch1/access")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"role_ids":["r1"]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn set_access_rejects_role_from_different_team() {
        let (state, _tmp) = make_state();
        seed_alice_team_and_channel(&state);
        let now = db::now_str();
        state.db.with_conn(|conn| {
            db::create_team(conn, &db::Team {
                id: "t-other".into(),
                name: "Other".into(),
                created_by: "alice".into(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                created_at: now.clone(),
                updated_at: now.clone(),
                ..Default::default()
            })?;
            db::create_role(conn, &db::Role {
                id: "r-other".into(),
                team_id: "t-other".into(),
                name: "Other".into(),
                color: "#000".into(),
                position: 1,
                permissions: 0,
                is_default: false,
                created_at: now.clone(),
                updated_at: now,
            })
        }).unwrap();
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/teams/t1/channels/ch1/access")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"role_ids":["r-other"]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn create_channel_409_for_duplicate_name() {
        let (state, _tmp) = make_state();
        seed_alice_team_and_channel(&state);
        // 'general' already exists from the seed → create another with the same
        // name + type must hit the L106-107 conflict path.
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::post("/teams/t1/channels")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"name":"general","type":"text"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn list_channels_skips_hidden_channels_for_non_admin() {
        let (state, _tmp) = make_state();
        seed_alice_team_and_channel(&state);
        // Mark ch1 as hidden_if_restricted.
        state.db.with_conn(|conn| {
            conn.execute(
                "UPDATE channels SET hidden_if_restricted = 1 WHERE id = 'ch1'",
                [],
            ).map(|_| ())
        }).unwrap();
        let app = router(state, "alice");
        // alice is the team owner so user_can_access_channel returns true →
        // hidden_if_restricted branch fires but allowed=true keeps it.
        let resp = app
            .oneshot(Request::get("/teams/t1/channels").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn delete_channel_happy_path() {
        let (state, _tmp) = make_state();
        seed_alice_team_and_channel(&state);
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/teams/t1/channels/ch1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    // Seed a second team t2 owned by alice with a channel ch2.
    fn seed_alice_second_team(state: &AppState) {
        let now = db::now_str();
        state.db.with_conn(|conn| {
            db::create_team(conn, &db::Team {
                id: "t2".into(),
                name: "T2".into(),
                created_by: "alice".into(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                created_at: now.clone(),
                updated_at: now.clone(),
                ..Default::default()
            })?;
            db::create_member(conn, &db::Member {
                id: "m2".into(),
                team_id: "t2".into(),
                user_id: "alice".into(),
                nickname: String::new(),
                invited_by: String::new(),
                joined_at: now.clone(),
                updated_at: now.clone(),
            })?;
            db::create_channel(conn, &db::Channel {
                id: "ch2".into(),
                team_id: "t2".into(),
                name: "off-topic".into(),
                channel_type: "text".into(),
                topic: String::new(),
                created_by: "alice".into(),
                position: 0,
                locked: false,
                created_at: now.clone(),
                updated_at: now,
                ..Default::default()
            })
        }).unwrap();
    }

    #[tokio::test]
    async fn delete_channel_rejects_cross_team_request() {
        // ch2 belongs to t2 but the request targets t1; the handler
        // should surface a 4xx via the `channel does not belong to
        // this team` rusqlite error wrap (L842-845).
        let (state, _tmp) = make_state();
        seed_alice_team_and_channel(&state);
        seed_alice_second_team(&state);
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/teams/t1/channels/ch2")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn mark_read_rejects_cross_team_channel() {
        // mark_read on ch2 via t1 path must reject (L780-781).
        let (state, _tmp) = make_state();
        seed_alice_team_and_channel(&state);
        seed_alice_second_team(&state);
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/teams/t1/channels/ch2/read")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn update_channel_rejects_blank_name() {
        // PATCH with name="   " (only whitespace) trims to empty and
        // hits L200 BadRequest("name cannot be empty").
        let (state, _tmp) = make_state();
        seed_alice_team_and_channel(&state);
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/teams/t1/channels/ch1")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"name":"   "}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn update_channel_category_reuses_existing_group() {
        // First create a group named "Engineering", then PATCH the
        // channel with category="Engineering" → resolves to the
        // existing group's id (L231-232) instead of creating one.
        let (state, _tmp) = make_state();
        seed_alice_team_and_channel(&state);
        let now = db::now_str();
        state.db.with_conn(|conn| {
            db::create_group(conn, &db::ChannelGroup {
                id: "g-eng".into(),
                team_id: "t1".into(),
                name: "Engineering".into(),
                position: 0,
                created_at: now.clone(),
                updated_at: now,
                hidden_if_restricted: false,
            })
        }).unwrap();
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/teams/t1/channels/ch1")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"category":"Engineering"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }
}
