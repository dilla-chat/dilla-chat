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
    let db = state.db.clone();
    let uid = user_id.clone();

    let teams = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| db::get_teams_by_user(conn, &uid))
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?
    .map_err(|e| AppError::Internal(format!("db: {}", e)))?;

    Ok(Json(json!(teams)))
}

pub async fn create(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Json(body): Json<CreateTeamRequest>,
) -> Result<Json<Value>, AppError> {
    if body.name.is_empty() {
        return Err(AppError::BadRequest("name is required".into()));
    }

    let db = state.db.clone();
    let uid = user_id.clone();

    let team = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let now = db::now_str();
            let team_id = db::new_id();

            let team = db::Team {
                id: team_id.clone(),
                name: body.name.clone(),
                description: body.description.clone(),
                icon_url: String::new(),
                created_by: uid.clone(),
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
                user_id: uid.clone(),
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
                created_by: uid.clone(),
                created_at: now.clone(),
                updated_at: now.clone(),
            };
            db::create_channel(conn, &channel)?;

            Ok(team)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?
    .map_err(|e| AppError::Internal(format!("db: {}", e)))?;

    Ok(Json(json!(team)))
}

pub async fn get_team(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let tid = team_id.clone();
    let uid = user_id.clone();

    let team = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            // Verify membership.
            let member = db::get_member_by_user_and_team(conn, &uid, &tid)?;
            if member.is_none() {
                return Err(rusqlite::Error::InvalidParameterName(
                    "not a member of this team".into(),
                ));
            }
            db::get_team(conn, &tid)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    let team = match team {
        Ok(Some(t)) => t,
        Ok(None) => return Err(AppError::NotFound("team not found".into())),
        Err(rusqlite::Error::InvalidParameterName(msg)) => {
            return Err(AppError::Forbidden(msg));
        }
        Err(e) => return Err(AppError::Internal(format!("db: {}", e))),
    };

    Ok(Json(json!(team)))
}

pub async fn update(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
    Json(body): Json<UpdateTeamRequest>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let tid = team_id.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            if !db::user_has_permission(conn, &uid, &tid, db::PERM_MANAGE_TEAM)? {
                return Err(rusqlite::Error::InvalidParameterName(
                    "insufficient permissions".into(),
                ));
            }

            let mut team = db::get_team(conn, &tid)?
                .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;

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
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(team) => Ok(Json(json!(team))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Err(AppError::NotFound("team not found".into())),
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

pub async fn list_members(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let tid = team_id.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            // Verify membership.
            let member = db::get_member_by_user_and_team(conn, &uid, &tid)?;
            if member.is_none() {
                return Err(rusqlite::Error::InvalidParameterName(
                    "not a member of this team".into(),
                ));
            }

            let members = db::get_members_by_team(conn, &tid)?;
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
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(members) => Ok(Json(json!(members))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

pub async fn update_member(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, target_user_id)): Path<(String, String)>,
    Json(body): Json<UpdateMemberRequest>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let tid = team_id.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            // Users can update their own nickname; admins can update anyone's.
            if uid != target_user_id
                && !db::user_has_permission(conn, &uid, &tid, db::PERM_MANAGE_MEMBERS)?
            {
                return Err(rusqlite::Error::InvalidParameterName(
                    "insufficient permissions".into(),
                ));
            }

            let mut member = db::get_member_by_user_and_team(conn, &target_user_id, &tid)?
                .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;

            if let Some(ref nick) = body.nickname {
                member.nickname = nick.clone();
            }

            db::update_member(conn, &member)?;
            Ok(member)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(member) => Ok(Json(json!(member))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(AppError::NotFound("member not found".into()))
        }
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

pub async fn kick_member(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, target_user_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    if user_id == target_user_id {
        return Err(AppError::BadRequest("cannot kick yourself".into()));
    }

    let db = state.db.clone();
    let tid = team_id.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            if !db::user_has_permission(conn, &uid, &tid, db::PERM_MANAGE_MEMBERS)? {
                return Err(rusqlite::Error::InvalidParameterName(
                    "insufficient permissions".into(),
                ));
            }

            // Check target is actually a member.
            let member = db::get_member_by_user_and_team(conn, &target_user_id, &tid)?;
            if member.is_none() {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }

            // Clear roles and remove member.
            if let Some(m) = member {
                db::clear_member_roles(conn, &m.id)?;
            }
            db::delete_member(conn, &target_user_id, &tid)?;
            Ok(())
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(()) => Ok(Json(json!({ "ok": true }))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(AppError::NotFound("member not found".into()))
        }
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
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

    let db = state.db.clone();
    let tid = team_id.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            if !db::user_has_permission(conn, &uid, &tid, db::PERM_MANAGE_MEMBERS)? {
                return Err(rusqlite::Error::InvalidParameterName(
                    "insufficient permissions".into(),
                ));
            }

            // Check if already banned.
            if db::get_ban(conn, &tid, &target_user_id)?.is_some() {
                return Err(rusqlite::Error::InvalidParameterName(
                    "user is already banned".into(),
                ));
            }

            // Create ban.
            let ban = db::Ban {
                team_id: tid.clone(),
                user_id: target_user_id.clone(),
                banned_by: uid.clone(),
                reason: body.reason.clone(),
                created_at: db::now_str(),
            };
            db::create_ban(conn, &ban)?;

            // Remove from team.
            if let Some(m) = db::get_member_by_user_and_team(conn, &target_user_id, &tid)? {
                db::clear_member_roles(conn, &m.id)?;
            }
            db::delete_member(conn, &target_user_id, &tid)?;

            Ok(ban)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(ban) => Ok(Json(json!(ban))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

pub async fn unban_member(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, target_user_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let tid = team_id.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            if !db::user_has_permission(conn, &uid, &tid, db::PERM_MANAGE_MEMBERS)? {
                return Err(rusqlite::Error::InvalidParameterName(
                    "insufficient permissions".into(),
                ));
            }

            let ban = db::get_ban(conn, &tid, &target_user_id)?;
            if ban.is_none() {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }

            db::delete_ban(conn, &tid, &target_user_id)?;
            Ok(())
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(()) => Ok(Json(json!({ "ok": true }))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(AppError::NotFound("ban not found".into()))
        }
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}
