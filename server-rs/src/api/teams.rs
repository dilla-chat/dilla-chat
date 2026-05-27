use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use std::sync::Arc;

use crate::api::helpers::{json_ok, json_ok_true, map_not_found, spawn_db};
use crate::api::AppState;
use crate::auth::UserId;
use crate::db;
use crate::error::AppError;
// A6: REST authz routes through the central policy module so every
// deny flows through one place. Same semantics as the prior
// helpers::require_* call sites.
use crate::policy::{require_permission, require_team_member};
use crate::ws::Hub;

#[derive(Deserialize)]
pub struct CreateTeamRequest {
    pub name: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Deserialize)]
pub struct UpdateTeamRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub icon_url: Option<String>,
    /// SFU-IP-1 mitigation. When true, the client must apply
    /// `iceTransportPolicy = "relay"` to its voice
    /// RTCPeerConnections so host/srflx ICE candidates are filtered
    /// out. Server-side opt-in; client-side enforcement is a
    /// follow-up diff per HANDOVER.md H-3.
    pub force_turn_relay: Option<bool>,
}

#[derive(Deserialize)]
pub struct UpdateMemberRequest {
    pub nickname: Option<String>,
    pub role_ids: Option<Vec<String>>,
}

#[derive(Deserialize)]
pub struct BanRequest {
    #[serde(default)]
    pub reason: String,
}

pub async fn list(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
) -> Result<Json<Value>, AppError> {
    let teams = spawn_db(state.db.clone(), move |conn| {
        db::get_teams_by_user(conn, &user_id)
    })
    .await?;

    json_ok(teams)
}

pub async fn create(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Json(body): Json<CreateTeamRequest>,
) -> Result<Json<Value>, AppError> {
    if body.name.is_empty() {
        return Err(AppError::BadRequest("name is required".into()));
    }

    if body.name.len() > 100 {
        return Err(AppError::BadRequest("name too long (max 100 chars)".into()));
    }

    if body.description.len() > 1024 {
        return Err(AppError::BadRequest("description too long (max 1024 chars)".into()));
    }

    // Phase 3: a newly-created team's authoritative node is THIS
    // node. Any future federation peer that tries to forge writes
    // into this team will be denied by authority::check. Pre-existing
    // teams that predate migration 030 stay as LegacyTeam — they get
    // backfilled via a future operator command, not here.
    let this_node_id = match crate::federation::identity::ensure(&state.db) {
        Ok(id) => id.node_id,
        Err(e) => {
            tracing::error!("federation: ensure node identity failed: {}", e);
            String::new()
        }
    };

    let team = spawn_db(state.db.clone(), move |conn| {
        let now = db::now_str();
        let team_id = db::new_id();

        let team = db::Team {
            id: team_id.clone(),
            name: body.name.clone(),
            description: body.description.clone(),
            icon_url: String::new(),
            created_by: user_id.clone(),
            max_file_size: 25 * 1024 * 1024,
            allow_member_invites: true,
            federated: false,
            force_turn_relay: false,
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        db::create_team(conn, &team)?;

        // Stamp ourselves as the authoritative node for this team.
        // Skipped only when identity::ensure failed above (logged); in
        // that case the team will be LegacyTeam until an operator
        // backfills via the admin API.
        if !this_node_id.is_empty() {
            let _ = crate::federation::authority::record_team_owner(
                conn,
                &team_id,
                &this_node_id,
            );
        }

        // Add creator as member.
        let member = db::Member {
            id: db::new_id(),
            team_id: team_id.clone(),
            user_id: user_id.clone(),
            nickname: String::new(),
            joined_at: now.clone(),
            invited_by: String::new(),
            updated_at: String::new(),
        };
        db::create_member(conn, &member)?;

        // Bootstrap only the minimum: an Admin role so the creator has full
        // perms, and `everyone` as the implicit default. Any further ladder
        // (Maintainer, Member, etc.) is user-defined via the role editor.
        let mut admin_role_id: Option<String> = None;
        for (name, color, position, permissions, is_default) in [
            ("Admin", "#5eebab", 1, db::PERM_ADMIN, false),
            (
                "everyone",
                "#99AAB5",
                0,
                db::PERM_SEND_MESSAGES | db::PERM_CREATE_INVITES,
                true,
            ),
        ] {
            let role = db::Role {
                id: db::new_id(),
                team_id: team_id.clone(),
                name: name.into(),
                color: color.into(),
                position,
                permissions,
                is_default,
                created_at: now.clone(),
                updated_at: String::new(),
            };
            db::create_role(conn, &role)?;
            if name == "Admin" {
                admin_role_id = Some(role.id.clone());
            }
        }

        // Give the team creator the Admin role so role-based perms work
        // without leaning on the old global is_admin shortcut.
        if let Some(rid) = admin_role_id {
            db::assign_role_to_member(conn, &member.id, &rid)?;
        }

        // Create #general channel.
        let channel = db::Channel {
            id: db::new_id(),
            team_id: team_id.clone(),
            name: "general".into(),
            topic: "General discussion".into(),
            channel_type: "text".into(),
            position: 0,
            category: String::new(),
            created_by: user_id.clone(),
            created_at: now.clone(),
            updated_at: now.clone(),
            locked: false, hidden_if_restricted: false, slow_mode_seconds: 0, group_id: None,
        };
        db::create_channel(conn, &channel)?;

        Ok(team)
    })
    .await?;

    json_ok(team)
}

pub async fn get_team(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let team = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id, &team_id)?;
        db::get_team(conn, &team_id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    })
    .await
    .map_err(map_not_found("team"))?;

    json_ok(team)
}

pub async fn update(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
    Json(body): Json<UpdateTeamRequest>,
) -> Result<Json<Value>, AppError> {
    if let Some(ref name) = body.name {
        if name.len() > 100 {
            return Err(AppError::BadRequest("name too long (max 100 chars)".into()));
        }
    }
    if let Some(ref desc) = body.description {
        if desc.len() > 1024 {
            return Err(AppError::BadRequest("description too long (max 1024 chars)".into()));
        }
    }

    let team = spawn_db(state.db.clone(), move |conn| {
        require_permission(conn, &user_id, &team_id, db::PERM_MANAGE_TEAM)?;

        let mut team = db::get_team(conn, &team_id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;

        if let Some(ref name) = body.name {
            team.name = name.clone();
        }
        if let Some(ref desc) = body.description {
            team.description = desc.clone();
        }
        if let Some(ref icon) = body.icon_url {
            team.icon_url = icon.clone();
        }
        if let Some(force_relay) = body.force_turn_relay {
            team.force_turn_relay = force_relay;
        }

        db::update_team(conn, &team)?;
        let _ = db::insert_audit_event(
            conn,
            &team_id,
            Some(&user_id),
            "team.update",
            Some("team"),
            Some(&team_id),
            Some(&serde_json::json!({
                "name": team.name,
                "force_turn_relay": team.force_turn_relay,
            })),
        );
        Ok(team)
    })
    .await
    .map_err(map_not_found("team"))?;

    json_ok(team)
}

pub async fn list_members(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let members = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id, &team_id)?;

        let members = db::get_members_by_team(conn, &team_id)?;
        let result: Vec<Value> = members
            .into_iter()
            .map(|(m, u)| {
                json!({
                    "member": m,
                    "user": u,
                })
            })
            .collect();
        Ok(result)
    })
    .await?;

    json_ok(members)
}

pub async fn update_member(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, target_user_id)): Path<(String, String)>,
    Json(body): Json<UpdateMemberRequest>,
) -> Result<Json<Value>, AppError> {
    let actor_user_id = user_id.clone();
    let team_id_for_broadcast = team_id.clone();
    let target_user_id_for_broadcast = target_user_id.clone();
    let roles_changed = body.role_ids.is_some();
    let role_ids_for_broadcast = body.role_ids.clone();
    let member = spawn_db(state.db.clone(), move |conn| {
        // Users can update their own nickname; admins can update anyone's.
        if user_id != target_user_id {
            require_permission(conn, &user_id, &team_id, db::PERM_MANAGE_MEMBERS)?;
        }

        // Role assignment always needs manage-members regardless of self vs
        // other — otherwise any member could self-promote.
        if body.role_ids.is_some() {
            require_permission(conn, &user_id, &team_id, db::PERM_MANAGE_MEMBERS)?;
        }

        let mut member = db::get_member_by_user_and_team(conn, &target_user_id, &team_id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;

        if let Some(ref nick) = body.nickname {
            member.nickname = nick.clone();
        }

        db::update_member(conn, &member)?;

        if let Some(ref role_ids) = body.role_ids {
            // Validate every role belongs to this team before touching the
            // member_roles table, so a partial failure can't half-apply.
            // OR the role bitmasks while we have them so the privilege
            // check below doesn't repeat the DB read.
            let mut assigned_bits: i64 = 0;
            for rid in role_ids {
                let role = db::get_role_by_id(conn, rid)?
                    .ok_or_else(|| rusqlite::Error::InvalidParameterName(format!("role {rid} not found")))?;
                if role.team_id != team_id {
                    return Err(rusqlite::Error::InvalidParameterName(
                        "role does not belong to this team".into(),
                    ));
                }
                assigned_bits |= role.permissions;
                if role.permissions & db::PERM_ADMIN != 0 {
                    assigned_bits = !0;
                }
            }
            // Privilege-escalation guard: assigning a role that would
            // grant the target a permission the actor doesn't hold is
            // a no. Only newly-added bits are checked — losing bits is
            // always fine. Compare against the union of the target's
            // CURRENT bits and what they'd hold after.
            let prev = db::get_member_roles(conn, &member.id)?;
            let mut prev_bits: i64 = 0;
            for r in &prev {
                prev_bits |= r.permissions;
                if r.permissions & db::PERM_ADMIN != 0 { prev_bits = !0; break; }
            }
            let added = assigned_bits & !prev_bits;
            if added != 0 {
                let my_bits = db::user_permissions_bits(conn, &user_id, &team_id)?;
                if added & !my_bits != 0 {
                    return Err(rusqlite::Error::InvalidParameterName(
                        "escalation".into(),
                    ));
                }
            }

            // Replace the full assignment set: drop existing, then re-add.
            let existing = db::get_member_roles(conn, &member.id)?;
            for r in existing {
                db::remove_role_from_member(conn, &member.id, &r.id)?;
            }
            for rid in role_ids {
                db::assign_role_to_member(conn, &member.id, rid)?;
            }

            let _ = db::insert_audit_event(
                conn,
                &team_id,
                Some(&user_id),
                "member.roles.update",
                Some("user"),
                Some(&target_user_id),
                Some(&serde_json::json!({ "role_ids": role_ids })),
            );

            // A4 / AUTH-FORCE-LOGOUT-1: invalidate every existing JWT
            // for the target user so their in-flight access tokens
            // can't keep operating with stale permission bits. The
            // client's refresh path will mint a new token with the
            // updated claims on the next call.
            let _ = db::invalidate_user_tokens_now(conn, &target_user_id);
        }

        Ok(member)
    })
    .await
    .map_err(|e| match e {
        AppError::Forbidden(msg) if msg == "escalation" => AppError::Forbidden(
            "you can't grant a permission you don't hold yourself".into(),
        ),
        other => map_not_found("member")(other),
    })?;

    if roles_changed {
        // Broadcast so other clients (including the affected user) refresh
        // member state and surface a notification — see the client's
        // `member:roles-updated` handler in useTeamSync.
        if let Ok(evt) = crate::ws::events::Event::new(
            "member:roles-updated",
            serde_json::json!({
                "team_id": team_id_for_broadcast,
                "user_id": target_user_id_for_broadcast,
                "actor_user_id": actor_user_id,
                "role_ids": role_ids_for_broadcast.unwrap_or_default(),
            }),
        ) {
            if let Ok(data) = evt.to_bytes() {
                state.hub.broadcast_to_all(data).await;
            }
        }
    }

    json_ok(member)
}

pub async fn kick_member(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, target_user_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    if user_id == target_user_id {
        return Err(AppError::BadRequest("cannot kick yourself".into()));
    }

    let tid = team_id.clone();
    let tuid = target_user_id.clone();

    spawn_db(state.db.clone(), move |conn| {
        require_permission(conn, &user_id, &tid, db::PERM_MANAGE_MEMBERS)?;

        // Check target is actually a member.
        let member = db::get_member_by_user_and_team(conn, &tuid, &tid)?;
        if member.is_none() {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }

        // Clear roles and remove member.
        if let Some(m) = member {
            db::clear_member_roles(conn, &m.id)?;
        }
        db::delete_member(conn, &tuid, &tid)?;
        let _ = db::insert_audit_event(
            conn,
            &tid,
            Some(&user_id),
            "member.kick",
            Some("user"),
            Some(&tuid),
            None,
        );
        Ok(())
    })
    .await
    .map_err(map_not_found("member"))?;

    // Broadcast member:left so clients can rotate encryption keys.
    broadcast_member_left(&state.hub, &team_id, &target_user_id).await;

    json_ok_true()
}

/// The caller voluntarily leaves a team. Sole-admin check borrows the
/// same rule delete_user uses — if the caller is the only PERM_ADMIN
/// member, the team would be ungovernable, so we refuse with 409
/// Conflict and ask the user to transfer ownership first.
pub async fn leave_team(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let tid = team_id.clone();
    let uid = user_id.clone();

    spawn_db(state.db.clone(), move |conn| {
        // Must be a member to leave.
        let member = db::get_member_by_user_and_team(conn, &uid, &tid)?;
        let Some(m) = member else {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        };
        // Sole-admin guard. Counts other members holding any PERM_ADMIN
        // role; if zero, this user is the only governor and can't leave.
        let other_admins: i32 = conn.query_row(
            "SELECT COUNT(DISTINCT m.user_id)
             FROM members m
             JOIN member_roles mr ON mr.member_id = m.id
             JOIN roles r ON r.id = mr.role_id
             WHERE m.team_id = ?1 AND m.user_id != ?2 AND r.permissions & 1 != 0",
            rusqlite::params![tid, uid],
            |row| row.get(0),
        )?;
        // Did this user have admin themselves? If yes and there are no
        // other admins, fail loudly.
        let i_am_admin: bool = conn.query_row(
            "SELECT EXISTS (
                SELECT 1 FROM member_roles mr
                JOIN roles r ON r.id = mr.role_id
                WHERE mr.member_id = ?1 AND r.permissions & 1 != 0
             )",
            rusqlite::params![m.id],
            |row| row.get(0),
        )?;
        if i_am_admin && other_admins == 0 {
            return Err(rusqlite::Error::InvalidParameterName(
                "sole_admin".into(),
            ));
        }

        db::clear_member_roles(conn, &m.id)?;
        db::delete_member(conn, &uid, &tid)?;
        let _ = db::insert_audit_event(
            conn,
            &tid,
            Some(&uid),
            "member.leave",
            Some("user"),
            Some(&uid),
            None,
        );
        Ok(())
    })
    .await
    .map_err(|e| match e {
        AppError::NotFound(_) => AppError::NotFound("not a member of this team".into()),
        AppError::Forbidden(msg) if msg == "sole_admin" => AppError::Conflict(
            "you're the only admin — promote someone else before leaving".into(),
        ),
        other => other,
    })?;

    // Same broadcast the kick path uses so remaining members rotate keys.
    broadcast_member_left(&state.hub, &team_id, &user_id).await;

    json_ok_true()
}

pub async fn ban_member(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, target_user_id)): Path<(String, String)>,
    Json(body): Json<BanRequest>,
) -> Result<Json<Value>, AppError> {
    if user_id == target_user_id {
        return Err(AppError::BadRequest("cannot ban yourself".into()));
    }

    let tid = team_id.clone();
    let tuid = target_user_id.clone();

    let ban = spawn_db(state.db.clone(), move |conn| {
        require_permission(conn, &user_id, &tid, db::PERM_MANAGE_MEMBERS)?;

        // Check if already banned.
        if db::get_ban(conn, &tid, &tuid)?.is_some() {
            return Err(rusqlite::Error::InvalidParameterName(
                "user is already banned".into(),
            ));
        }

        // Create ban.
        let ban = db::Ban {
            team_id: tid.clone(),
            user_id: tuid.clone(),
            banned_by: user_id.clone(),
            reason: body.reason.clone(),
            created_at: db::now_str(),
        };
        db::create_ban(conn, &ban)?;

        // Remove from team.
        if let Some(m) = db::get_member_by_user_and_team(conn, &tuid, &tid)? {
            db::clear_member_roles(conn, &m.id)?;
        }
        db::delete_member(conn, &tuid, &tid)?;

        let _ = db::insert_audit_event(
            conn,
            &tid,
            Some(&user_id),
            "member.ban",
            Some("user"),
            Some(&tuid),
            Some(&serde_json::json!({ "reason": body.reason })),
        );

        Ok(ban)
    })
    .await?;

    // Broadcast member:left so clients can rotate encryption keys.
    broadcast_member_left(&state.hub, &team_id, &target_user_id).await;

    json_ok(ban)
}

pub async fn unban_member(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, target_user_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    spawn_db(state.db.clone(), move |conn| {
        require_permission(conn, &user_id, &team_id, db::PERM_MANAGE_MEMBERS)?;

        if db::get_ban(conn, &team_id, &target_user_id)?.is_none() {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }

        db::delete_ban(conn, &team_id, &target_user_id)
    })
    .await
    .map_err(map_not_found("ban"))?;

    json_ok_true()
}

/// Broadcast a `member:left` event to all connected clients so they can
/// rotate channel encryption keys for the removed member.
async fn broadcast_member_left(hub: &Arc<Hub>, team_id: &str, user_id: &str) {
    use crate::ws::events::Event;

    let evt = Event::new(
        "member:left",
        serde_json::json!({
            "team_id": team_id,
            "user_id": user_id,
        }),
    );
    if let Ok(evt) = evt {
        if let Ok(data) = evt.to_bytes() {
            hub.broadcast_to_all(data).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_team_request_requires_name_but_description_defaults_empty() {
        let r: CreateTeamRequest = serde_json::from_str(r#"{"name":"T"}"#).unwrap();
        assert_eq!(r.name, "T");
        assert_eq!(r.description, "");
        assert!(serde_json::from_str::<CreateTeamRequest>("{}").is_err());
    }

    #[test]
    fn update_team_request_treats_all_fields_as_optional() {
        let r: UpdateTeamRequest = serde_json::from_str("{}").unwrap();
        assert!(r.name.is_none());
        assert!(r.description.is_none());
        assert!(r.icon_url.is_none());
        assert!(r.force_turn_relay.is_none());
    }

    #[test]
    fn update_team_request_force_turn_relay_parses_true_and_false() {
        let r: UpdateTeamRequest = serde_json::from_str(r#"{"force_turn_relay":true}"#).unwrap();
        assert_eq!(r.force_turn_relay, Some(true));
        let r: UpdateTeamRequest = serde_json::from_str(r#"{"force_turn_relay":false}"#).unwrap();
        assert_eq!(r.force_turn_relay, Some(false));
    }

    #[test]
    fn update_member_request_role_ids_is_optional_vec() {
        let r: UpdateMemberRequest =
            serde_json::from_str(r#"{"role_ids":["r1","r2"]}"#).unwrap();
        assert_eq!(r.role_ids.as_deref(), Some(["r1".to_string(), "r2".to_string()].as_slice()));
    }

    #[test]
    fn ban_request_reason_defaults_empty() {
        let r: BanRequest = serde_json::from_str("{}").unwrap();
        assert_eq!(r.reason, "");
        let r: BanRequest = serde_json::from_str(r#"{"reason":"spam"}"#).unwrap();
        assert_eq!(r.reason, "spam");
    }

    // ── axum integration tests ──────────────────────────────────────

    use crate::auth::AuthService;
    use crate::config::Config;
    use crate::db::Database;
    use crate::presence::PresenceManager;
    use crate::ws::Hub;
    use axum::body::Body;
    use axum::http::Request;
    use axum::routing::{get, patch, post};
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

    fn seed_user_and_team(db: &Database, user_id: &str, team_id: &str) {
        let now = db::now_str();
        db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: user_id.into(),
                username: user_id.into(),
                display_name: user_id.into(),
                public_key: vec![1u8; 32],
                status_type: "online".into(),
                created_at: now.clone(),
                updated_at: now.clone(),
                ..Default::default()
            })?;
            db::create_team(conn, &db::Team {
                id: team_id.into(),
                name: "Test Team".into(),
                description: String::new(),
                icon_url: String::new(),
                created_by: user_id.into(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                federated: false,
                created_at: now.clone(),
                updated_at: now,
                ..Default::default()
            })
        })
        .unwrap();
    }

    fn router(state: AppState, user_id: &'static str) -> Router {
        Router::new()
            .route("/teams", get(list).post(create))
            .route("/teams/{id}", get(get_team).patch(update))
            .route("/teams/{id}/members", get(list_members))
            .route("/teams/{id}/leave", post(leave_team))
            .layer(axum::Extension(UserId(user_id.to_string())))
            .with_state(state)
    }

    #[tokio::test]
    async fn list_teams_returns_empty_for_user_with_no_memberships() {
        let (state, _tmp) = make_state();
        let app = router(state, "alice");
        let resp = app
            .oneshot(Request::get("/teams").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn create_team_rejects_empty_name() {
        let (state, _tmp) = make_state();
        seed_user_and_team(&state.db, "alice", "t-exists");
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::post("/teams")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"name":""}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn create_team_rejects_oversized_name() {
        let (state, _tmp) = make_state();
        seed_user_and_team(&state.db, "alice", "t1");
        let app = router(state, "alice");
        let oversized = "n".repeat(101);
        let body = format!(r#"{{"name":"{}"}}"#, oversized);
        let resp = app
            .oneshot(
                Request::post("/teams")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn create_team_rejects_oversized_description() {
        let (state, _tmp) = make_state();
        seed_user_and_team(&state.db, "alice", "t1");
        let app = router(state, "alice");
        let oversized = "d".repeat(1025);
        let body = format!(r#"{{"name":"ok","description":"{}"}}"#, oversized);
        let resp = app
            .oneshot(
                Request::post("/teams")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn get_team_rejects_non_member() {
        let (state, _tmp) = make_state();
        seed_user_and_team(&state.db, "alice", "t-private");
        // user_id 'ghost' is not a member of t-private.
        let app = router(state, "ghost");
        let resp = app
            .oneshot(Request::get("/teams/t-private").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert!(resp.status() == 404 || resp.status() == 403);
    }

    #[tokio::test]
    async fn update_team_rejects_oversized_fields() {
        let (state, _tmp) = make_state();
        seed_user_and_team(&state.db, "alice", "t-up");
        let app = router(state, "alice");
        let oversized = "n".repeat(101);
        let body = format!(r#"{{"name":"{}"}}"#, oversized);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/teams/t-up")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    fn router_full(state: AppState, user_id: &'static str) -> Router {
        use axum::routing::delete as axum_delete;
        Router::new()
            .route("/teams", get(list).post(create))
            .route("/teams/{id}", get(get_team).patch(update))
            .route("/teams/{id}/members", get(list_members))
            .route("/teams/{id}/members/{user_id}", patch(update_member).delete(axum_delete(kick_member)))
            .route("/teams/{id}/leave", post(leave_team))
            .route("/teams/{id}/bans/{user_id}", post(ban_member).delete(axum_delete(unban_member)))
            .layer(axum::Extension(UserId(user_id.to_string())))
            .with_state(state)
    }

    #[tokio::test]
    async fn kick_member_rejects_self_kick() {
        let (state, _tmp) = make_state();
        seed_user_and_team(&state.db, "alice", "t-kick");
        let app = router_full(state, "alice");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/teams/t-kick/members/alice")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn kick_member_404s_for_unknown_target() {
        let (state, _tmp) = make_state();
        seed_user_and_team(&state.db, "alice", "t-kick");
        let app = router_full(state, "alice");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/teams/t-kick/members/ghost")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn leave_team_4xx_for_non_member() {
        let (state, _tmp) = make_state();
        seed_user_and_team(&state.db, "alice", "t-leave");
        let app = router_full(state, "ghost");
        let resp = app
            .oneshot(
                Request::post("/teams/t-leave/leave").body(Body::empty()).unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn ban_member_rejects_self_ban() {
        let (state, _tmp) = make_state();
        seed_user_and_team(&state.db, "alice", "t-ban");
        let app = router_full(state, "alice");
        let resp = app
            .oneshot(
                Request::post("/teams/t-ban/bans/alice")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"reason":""}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn list_members_returns_200_for_member() {
        let (state, _tmp) = make_state();
        seed_user_and_team(&state.db, "alice", "t-list");
        // Add a member row so alice is a team member.
        let now = db::now_str();
        state.db.with_conn(|conn| {
            db::create_member(conn, &db::Member {
                id: "m-alice".into(),
                team_id: "t-list".into(),
                user_id: "alice".into(),
                nickname: String::new(),
                invited_by: String::new(),
                joined_at: now.clone(),
                updated_at: now,
            })
        }).unwrap();
        let app = router_full(state, "alice");
        let resp = app
            .oneshot(Request::get("/teams/t-list/members").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    fn seed_team_with_member(state: &AppState, team_id: &str, owner_id: &str, member_id: &str) {
        let now = db::now_str();
        let team_id = team_id.to_string();
        let owner_id = owner_id.to_string();
        let member_id = member_id.to_string();
        state.db.with_conn(|conn| {
            let mut pk_o = vec![0u8; 32];
            for (i, b) in owner_id.bytes().enumerate().take(32) { pk_o[i] = b; }
            let mut pk_m = vec![0u8; 32];
            for (i, b) in member_id.bytes().enumerate().take(32) { pk_m[i] = b; }
            db::create_user(conn, &db::User {
                id: owner_id.clone(),
                username: owner_id.clone(),
                display_name: owner_id.clone(),
                public_key: pk_o,
                status_type: "online".into(),
                created_at: now.clone(),
                updated_at: now.clone(),
                ..Default::default()
            })?;
            db::create_user(conn, &db::User {
                id: member_id.clone(),
                username: member_id.clone(),
                display_name: member_id.clone(),
                public_key: pk_m,
                status_type: "online".into(),
                created_at: now.clone(),
                updated_at: now.clone(),
                ..Default::default()
            })?;
            db::create_team(conn, &db::Team {
                id: team_id.clone(),
                name: "T".into(),
                created_by: owner_id.clone(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                created_at: now.clone(),
                updated_at: now.clone(),
                ..Default::default()
            })?;
            db::create_member(conn, &db::Member {
                id: format!("m-{}", owner_id),
                team_id: team_id.clone(),
                user_id: owner_id,
                nickname: String::new(),
                invited_by: String::new(),
                joined_at: now.clone(),
                updated_at: now.clone(),
            })?;
            db::create_member(conn, &db::Member {
                id: format!("m-{}", member_id),
                team_id,
                user_id: member_id,
                nickname: String::new(),
                invited_by: String::new(),
                joined_at: now.clone(),
                updated_at: now,
            })
        }).unwrap();
    }

    #[tokio::test]
    async fn update_team_happy_path_as_owner() {
        let (state, _tmp) = make_state();
        seed_user_and_team(&state.db, "alice", "t-up");
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/teams/t-up")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"name":"renamed","description":"d"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn update_member_role_assignment_as_owner_succeeds() {
        let (state, _tmp) = make_state();
        seed_team_with_member(&state, "t1", "alice", "bob");
        // Seed a role bob can be assigned.
        let now = db::now_str();
        state.db.with_conn(|conn| {
            db::create_role(conn, &db::Role {
                id: "r-mod".into(),
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
        let app = router_full(state, "alice");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/teams/t1/members/bob")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"role_ids":["r-mod"]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn update_member_rejects_unknown_role_id() {
        let (state, _tmp) = make_state();
        seed_team_with_member(&state, "t1", "alice", "bob");
        let app = router_full(state, "alice");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/teams/t1/members/bob")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"role_ids":["ghost-role"]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn update_member_rejects_role_from_different_team() {
        let (state, _tmp) = make_state();
        seed_team_with_member(&state, "t1", "alice", "bob");
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
                name: "Other Role".into(),
                color: String::new(),
                position: 1,
                permissions: 0,
                is_default: false,
                created_at: now.clone(),
                updated_at: now,
            })
        }).unwrap();
        let app = router_full(state, "alice");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/teams/t1/members/bob")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"role_ids":["r-other"]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn update_member_nickname_as_owner_succeeds() {
        let (state, _tmp) = make_state();
        seed_team_with_member(&state, "t1", "alice", "bob");
        let app = router_full(state, "alice");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/teams/t1/members/bob")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"nickname":"Bobby"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn kick_member_happy_path() {
        let (state, _tmp) = make_state();
        seed_team_with_member(&state, "t1", "alice", "bob");
        let app = router_full(state, "alice");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/teams/t1/members/bob")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    fn router_with_bans(state: AppState, user_id: &'static str) -> Router {
        use axum::routing::delete as axum_delete;
        Router::new()
            .route("/teams/{id}/members/{user_id}", patch(update_member).delete(axum_delete(kick_member)))
            .route("/teams/{id}/bans/{user_id}", post(ban_member).delete(axum_delete(unban_member)))
            .layer(axum::Extension(UserId(user_id.to_string())))
            .with_state(state)
    }

    #[tokio::test]
    async fn ban_member_happy_path() {
        let (state, _tmp) = make_state();
        seed_team_with_member(&state, "t1", "alice", "bob");
        let app = router_with_bans(state, "alice");
        let resp = app
            .oneshot(
                Request::post("/teams/t1/bans/bob")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"reason":"spam"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn ban_member_rejects_double_ban() {
        let (state, _tmp) = make_state();
        seed_team_with_member(&state, "t1", "alice", "bob");
        let app1 = router_with_bans(state.clone(), "alice");
        let r1 = app1
            .oneshot(
                Request::post("/teams/t1/bans/bob")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"reason":""}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r1.status(), 200);
        let app2 = router_with_bans(state, "alice");
        let r2 = app2
            .oneshot(
                Request::post("/teams/t1/bans/bob")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"reason":""}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        // Second ban is rejected — already banned.
        assert!(r2.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn unban_member_404_for_unbanned_user() {
        let (state, _tmp) = make_state();
        seed_team_with_member(&state, "t1", "alice", "bob");
        let app = router_with_bans(state, "alice");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/teams/t1/bans/bob")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 404);
    }

    #[tokio::test]
    async fn unban_member_happy_path_after_ban() {
        let (state, _tmp) = make_state();
        seed_team_with_member(&state, "t1", "alice", "bob");
        // First ban bob.
        let app1 = router_with_bans(state.clone(), "alice");
        let r1 = app1
            .oneshot(
                Request::post("/teams/t1/bans/bob")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"reason":""}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r1.status(), 200);
        // Now unban.
        let app2 = router_with_bans(state, "alice");
        let r2 = app2
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/teams/t1/bans/bob")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r2.status(), 200);
    }

    #[tokio::test]
    async fn leave_team_happy_path_for_non_admin_member() {
        let (state, _tmp) = make_state();
        seed_team_with_member(&state, "t1", "alice", "bob");
        // bob has no admin role, alice is owner — bob can leave.
        let app = router_full(state, "bob");
        let resp = app
            .oneshot(
                Request::post("/teams/t1/leave").body(Body::empty()).unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }
}
