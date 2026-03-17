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
