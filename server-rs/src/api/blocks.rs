// User block list. Block / unblock / list endpoints scoped to the
// caller — there's no admin-managed view. WS hub enforcement (filtering
// message:new broadcasts) lives in ws/hub.rs.

use axum::extract::{Path, State};
use axum::{Extension, Json};
use serde_json::Value;

use crate::api::helpers::{json_ok, json_ok_true, spawn_db};
use crate::api::AppState;
use crate::auth::UserId;
use crate::db;
use crate::error::AppError;

pub async fn list(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
) -> Result<Json<Value>, AppError> {
    let ids = spawn_db(state.db.clone(), move |conn| db::list_blocked(conn, &user_id)).await?;
    json_ok(serde_json::json!({ "user_ids": ids }))
}

pub async fn block(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(blocked_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    if user_id == blocked_id {
        return Err(AppError::BadRequest("you cannot block yourself".into()));
    }
    let blocker = user_id.clone();
    let blocked = blocked_id.clone();
    spawn_db(state.db.clone(), move |conn| {
        // Verify the target exists. Without this a typo'd id silently
        // succeeds because INSERT OR IGNORE swallows constraint errors.
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM users WHERE id = ?1 LIMIT 1",
                rusqlite::params![blocked],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if !exists {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        db::block_user(conn, &blocker, &blocked)
    })
    .await
    .map_err(|e| match e {
        AppError::NotFound(_) => AppError::NotFound("user not found".into()),
        other => other,
    })?;
    json_ok_true()
}

pub async fn unblock(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(blocked_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let blocker = user_id.clone();
    let blocked = blocked_id.clone();
    spawn_db(state.db.clone(), move |conn| {
        db::unblock_user(conn, &blocker, &blocked)
    })
    .await?;
    json_ok_true()
}
