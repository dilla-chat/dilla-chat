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
pub struct CreateRoleRequest {
    pub name: String,
    #[serde(default = "default_color")]
    pub color: String,
    #[serde(default)]
    pub permissions: i64,
}

fn default_color() -> String {
    "#99AAB5".into()
}

#[derive(Deserialize)]
pub struct UpdateRoleRequest {
    pub name: Option<String>,
    pub color: Option<String>,
    pub permissions: Option<i64>,
    pub position: Option<i32>,
}

#[derive(Deserialize)]
pub struct ReorderRequest {
    pub role_ids: Vec<String>,
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
            db::get_roles_by_team(conn, &tid)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(roles) => Ok(Json(json!(roles))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

pub async fn create(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
    Json(body): Json<CreateRoleRequest>,
) -> Result<Json<Value>, AppError> {
    if body.name.is_empty() {
        return Err(AppError::BadRequest("name is required".into()));
    }

    let db = state.db.clone();
    let tid = team_id.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            if !db::user_has_permission(conn, &uid, &tid, db::PERM_MANAGE_ROLES)? {
                return Err(rusqlite::Error::InvalidParameterName(
                    "insufficient permissions".into(),
                ));
            }

            // Get current max position.
            let roles = db::get_roles_by_team(conn, &tid)?;
            let max_pos = roles.iter().map(|r| r.position).max().unwrap_or(0);

            let role = db::Role {
                id: db::new_id(),
                team_id: tid.clone(),
                name: body.name.clone(),
                color: body.color.clone(),
                position: max_pos + 1,
                permissions: body.permissions,
                is_default: false,
                created_at: db::now_str(),
                updated_at: String::new(),
            };
            db::create_role(conn, &role)?;
            Ok(role)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(role) => Ok(Json(json!(role))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

pub async fn update(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, role_id)): Path<(String, String)>,
    Json(body): Json<UpdateRoleRequest>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let tid = team_id.clone();
    let rid = role_id.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            if !db::user_has_permission(conn, &uid, &tid, db::PERM_MANAGE_ROLES)? {
                return Err(rusqlite::Error::InvalidParameterName(
                    "insufficient permissions".into(),
                ));
            }

            let mut role = db::get_role_by_id(conn, &rid)?
                .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;

            if role.team_id != tid {
                return Err(rusqlite::Error::InvalidParameterName(
                    "role does not belong to this team".into(),
                ));
            }

            if let Some(ref name) = body.name {
                role.name = name.clone();
            }
            if let Some(ref color) = body.color {
                role.color = color.clone();
            }
            if let Some(perms) = body.permissions {
                role.permissions = perms;
            }
            if let Some(pos) = body.position {
                role.position = pos;
            }

            db::update_role(conn, &role)?;
            Ok(role)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(role) => Ok(Json(json!(role))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(AppError::NotFound("role not found".into()))
        }
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

pub async fn delete_role(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, role_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let tid = team_id.clone();
    let rid = role_id.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            if !db::user_has_permission(conn, &uid, &tid, db::PERM_MANAGE_ROLES)? {
                return Err(rusqlite::Error::InvalidParameterName(
                    "insufficient permissions".into(),
                ));
            }

            let role = db::get_role_by_id(conn, &rid)?
                .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;

            if role.team_id != tid {
                return Err(rusqlite::Error::InvalidParameterName(
                    "role does not belong to this team".into(),
                ));
            }

            if role.is_default {
                return Err(rusqlite::Error::InvalidParameterName(
                    "cannot delete the default role".into(),
                ));
            }

            db::delete_role(conn, &rid)?;
            Ok(())
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(()) => Ok(Json(json!({ "ok": true }))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(AppError::NotFound("role not found".into()))
        }
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

pub async fn reorder(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
    Json(body): Json<ReorderRequest>,
) -> Result<Json<Value>, AppError> {
    if body.role_ids.is_empty() {
        return Err(AppError::BadRequest("role_ids is required".into()));
    }

    let db = state.db.clone();
    let tid = team_id.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            if !db::user_has_permission(conn, &uid, &tid, db::PERM_MANAGE_ROLES)? {
                return Err(rusqlite::Error::InvalidParameterName(
                    "insufficient permissions".into(),
                ));
            }

            for (i, role_id) in body.role_ids.iter().enumerate() {
                if let Some(mut role) = db::get_role_by_id(conn, role_id)? {
                    if role.team_id == tid {
                        role.position = i as i32;
                        db::update_role(conn, &role)?;
                    }
                }
            }

            db::get_roles_by_team(conn, &tid)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(roles) => Ok(Json(json!(roles))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}
