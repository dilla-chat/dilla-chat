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
pub struct CreateInviteRequest {
    #[serde(default)]
    pub max_uses: Option<i32>,
    #[serde(default)]
    pub expires_in_hours: Option<i64>,
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
            db::get_active_invites_by_team(conn, &tid)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(invites) => Ok(Json(json!(invites))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

pub async fn create(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
    Json(body): Json<CreateInviteRequest>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let tid = team_id.clone();
    let uid = user_id.clone();
    let auth = state.auth.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            if !db::user_has_permission(conn, &uid, &tid, db::PERM_CREATE_INVITES)? {
                return Err(rusqlite::Error::InvalidParameterName(
                    "insufficient permissions".into(),
                ));
            }

            let now = db::now_str();
            let token = auth.generate_invite_token();

            let expires_at = body.expires_in_hours.map(|hours| {
                let expires = chrono::Utc::now() + chrono::Duration::hours(hours);
                expires.format("%Y-%m-%d %H:%M:%S").to_string()
            });

            let invite = db::Invite {
                id: db::new_id(),
                team_id: tid.clone(),
                created_by: uid.clone(),
                token,
                max_uses: body.max_uses,
                uses: 0,
                expires_at,
                revoked: false,
                created_at: now,
            };
            db::create_invite(conn, &invite)?;
            Ok(invite)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(invite) => Ok(Json(json!(invite))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

pub async fn revoke(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, invite_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let tid = team_id.clone();
    let iid = invite_id.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            if !db::user_has_permission(conn, &uid, &tid, db::PERM_CREATE_INVITES)? {
                return Err(rusqlite::Error::InvalidParameterName(
                    "insufficient permissions".into(),
                ));
            }

            let invite = db::get_invite_by_id(conn, &iid)?
                .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;

            if invite.team_id != tid {
                return Err(rusqlite::Error::InvalidParameterName(
                    "invite does not belong to this team".into(),
                ));
            }

            db::revoke_invite(conn, &iid)?;
            Ok(())
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(()) => Ok(Json(json!({ "ok": true }))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(AppError::NotFound("invite not found".into()))
        }
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

/// Public endpoint (no auth required) — returns invite info for a token.
pub async fn get_invite_info(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let invite = db::get_invite_by_token(conn, &token)?
                .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;

            if invite.revoked {
                return Err(rusqlite::Error::InvalidParameterName(
                    "invite has been revoked".into(),
                ));
            }

            if let Some(max) = invite.max_uses {
                if invite.uses >= max {
                    return Err(rusqlite::Error::InvalidParameterName(
                        "invite max uses reached".into(),
                    ));
                }
            }

            if let Some(ref expires) = invite.expires_at {
                let now = db::now_str();
                if now > *expires {
                    return Err(rusqlite::Error::InvalidParameterName(
                        "invite has expired".into(),
                    ));
                }
            }

            // Get team info.
            let team = db::get_team(conn, &invite.team_id)?;

            Ok(json!({
                "team_id": invite.team_id,
                "team_name": team.map(|t| t.name).unwrap_or_default(),
                "token": invite.token,
            }))
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(info) => Ok(Json(info)),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::BadRequest(msg)),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(AppError::NotFound("invite not found".into()))
        }
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}
