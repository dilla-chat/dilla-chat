use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use std::sync::Arc;

use crate::api::helpers::{json_ok, json_ok_true, map_not_found, require_permission, require_team_member, spawn_db};
use crate::api::AppState;
use crate::auth::UserId;
use crate::db;
use crate::error::AppError;
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
}

#[derive(Deserialize)]
pub struct UpdateMemberRequest {
    pub nickname: Option<String>,
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
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        db::create_team(conn, &team)?;

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

        // Create default role.
        let role = db::Role {
            id: db::new_id(),
            team_id: team_id.clone(),
            name: "everyone".into(),
            color: "#99AAB5".into(),
            position: 0,
            permissions: db::PERM_SEND_MESSAGES | db::PERM_CREATE_INVITES,
            is_default: true,
            created_at: now.clone(),
            updated_at: String::new(),
        };
        db::create_role(conn, &role)?;

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

        db::update_team(conn, &team)?;
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
    let member = spawn_db(state.db.clone(), move |conn| {
        // Users can update their own nickname; admins can update anyone's.
        if user_id != target_user_id {
            require_permission(conn, &user_id, &team_id, db::PERM_MANAGE_MEMBERS)?;
        }

        let mut member = db::get_member_by_user_and_team(conn, &target_user_id, &team_id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;

        if let Some(ref nick) = body.nickname {
            member.nickname = nick.clone();
        }

        db::update_member(conn, &member)?;
        Ok(member)
    })
    .await
    .map_err(map_not_found("member"))?;

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
        Ok(())
    })
    .await
    .map_err(map_not_found("member"))?;

    // Broadcast member:left so clients can rotate encryption keys.
    broadcast_member_left(&state.hub, &team_id, &target_user_id).await;

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
