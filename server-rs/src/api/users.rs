use axum::{extract::State, Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::api::AppState;
use crate::auth::UserId;
use crate::db;
use crate::error::AppError;

#[derive(Deserialize)]
pub struct UpdateMeRequest {
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub status_text: Option<String>,
    pub status_type: Option<String>,
    pub quiet_hours_enabled: Option<bool>,
    pub quiet_hours_from: Option<String>,
    pub quiet_hours_to: Option<String>,
}

#[derive(Deserialize)]
pub struct IdentityBlobRequest {
    pub blob: String,
}

pub async fn get_me(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let uid = user_id.clone();

    let user = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| db::get_user_by_id(conn, &uid))
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?
    .map_err(|e| AppError::Internal(format!("db: {}", e)))?
    .ok_or_else(|| AppError::NotFound("user not found".into()))?;

    Ok(Json(json!(user)))
}

pub async fn update_me(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Json(body): Json<UpdateMeRequest>,
) -> Result<Json<Value>, AppError> {
    if let Some(ref dn) = body.display_name {
        if dn.len() > 64 {
            return Err(AppError::BadRequest("display_name too long (max 64 chars)".into()));
        }
    }
    if let Some(ref st) = body.status_text {
        if st.len() > 128 {
            return Err(AppError::BadRequest("status_text too long (max 128 chars)".into()));
        }
    }

    let db = state.db.clone();
    let uid = user_id.clone();

    let user = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let mut user = db::get_user_by_id(conn, &uid)?
                .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;

            if let Some(ref dn) = body.display_name {
                user.display_name = dn.clone();
            }
            if let Some(ref av) = body.avatar_url {
                user.avatar_url = av.clone();
            }
            if let Some(ref st) = body.status_text {
                user.status_text = st.clone();
            }
            if let Some(ref st) = body.status_type {
                user.status_type = st.clone();
            }
            if let Some(en) = body.quiet_hours_enabled {
                user.quiet_hours_enabled = en;
            }
            if let Some(ref from) = body.quiet_hours_from {
                // Cheap HH:MM validation — rejects empty + obviously off-shape
                // values without pulling in a full chrono parse.
                if !is_valid_hh_mm(from) {
                    return Err(rusqlite::Error::InvalidParameterName(
                        "quiet_hours_from must be HH:MM".into(),
                    ));
                }
                user.quiet_hours_from = from.clone();
            }
            if let Some(ref to) = body.quiet_hours_to {
                if !is_valid_hh_mm(to) {
                    return Err(rusqlite::Error::InvalidParameterName(
                        "quiet_hours_to must be HH:MM".into(),
                    ));
                }
                user.quiet_hours_to = to.clone();
            }

            db::update_user(conn, &user)?;
            Ok(user)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?
    .map_err(|e| AppError::Internal(format!("db: {}", e)))?;

    Ok(Json(json!(user)))
}

pub async fn get_identity_blob(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let uid = user_id.clone();

    let blob = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| db::get_identity_blob(conn, &uid))
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?
    .map_err(|e| AppError::Internal(format!("db: {}", e)))?;

    Ok(Json(json!({
        "blob": blob.unwrap_or_default(),
    })))
}

pub async fn delete_me(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| db::delete_user(conn, &uid))
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(()) => Ok(Json(json!({ "ok": true }))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::BadRequest(msg)),
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

/// Cheap "HH:MM" check — accepts 00:00..23:59, no whitespace, exact width.
/// Avoids pulling chrono just to validate two two-digit fields.
fn is_valid_hh_mm(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' { return false; }
    let h: u8 = match s[0..2].parse() { Ok(n) => n, Err(_) => return false };
    let m: u8 = match s[3..5].parse() { Ok(n) => n, Err(_) => return false };
    h < 24 && m < 60
}

pub async fn put_identity_blob(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Json(body): Json<IdentityBlobRequest>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let uid = user_id.clone();
    let blob = body.blob.clone();

    tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| db::upsert_identity_blob(conn, &uid, &blob))
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?
    .map_err(|e| AppError::Internal(format!("db: {}", e)))?;

    Ok(Json(json!({ "ok": true })))
}
