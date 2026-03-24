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

/// GET /api/v1/federation/status
///
/// Returns the federation node status including node name, peer count,
/// and current Lamport timestamp.
pub async fn get_status(
    Extension(UserId(_user_id)): Extension<UserId>,
    State(state): State<AppState>,
) -> Result<Json<Value>, AppError> {
    let mesh = state.mesh.as_ref().ok_or_else(|| {
        AppError::BadRequest("federation is not enabled".into())
    })?;

    let peers = mesh.get_peers().await;
    let lamport_ts = mesh.sync_manager().current();

    Ok(Json(json!({
        "node_name": mesh.node_name,
        "peers": peers,
        "peer_count": peers.len(),
        "lamport_ts": lamport_ts,
    })))
}

/// GET /api/v1/federation/peers
///
/// Returns the list of federation peers and their connection statuses.
pub async fn get_peers(
    Extension(UserId(_user_id)): Extension<UserId>,
    State(state): State<AppState>,
) -> Result<Json<Value>, AppError> {
    let mesh = state.mesh.as_ref().ok_or_else(|| {
        AppError::BadRequest("federation is not enabled".into())
    })?;

    let peers = mesh.get_peers().await;

    Ok(Json(json!(peers)))
}

#[derive(Deserialize)]
#[allow(dead_code)]
pub struct CreateJoinTokenRequest {
    // No additional fields needed; creator is extracted from auth.
}

/// POST /api/v1/federation/join-token
///
/// Generate a federation join token. Only admins may call this endpoint.
pub async fn create_join_token(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
) -> Result<Json<Value>, AppError> {
    let mesh = state.mesh.as_ref().ok_or_else(|| {
        AppError::BadRequest("federation is not enabled".into())
    })?;

    // Check that the user is an admin.
    let db = state.db.clone();
    let uid = user_id.clone();
    let is_admin = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let user = db::get_user_by_id(conn, &uid)?;
            Ok(user.map(|u| u.is_admin).unwrap_or(false))
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?
    .map_err(|e: rusqlite::Error| AppError::Internal(format!("db: {}", e)))?;

    if !is_admin {
        return Err(AppError::Forbidden(
            "only admins can create federation join tokens".into(),
        ));
    }

    // Collect current peer addresses.
    let peers = mesh.get_peers().await;
    let peer_addrs: Vec<String> = peers.iter().map(|p| p.address.clone()).collect();

    let join_mgr = mesh.join_manager().clone();
    let uid = user_id.clone();
    let token = tokio::task::spawn_blocking(move || {
        join_mgr.generate_join_token_with_peers(&uid, peer_addrs)
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?
    .map_err(AppError::Internal)?;

    Ok(Json(json!({
        "token": token,
    })))
}

/// GET /api/v1/federation/join/:token
///
/// Validate a federation join token and return the embedded join information.
/// This is a public endpoint (no auth required).
pub async fn get_join_info(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<Value>, AppError> {
    let mesh = state.mesh.as_ref().ok_or_else(|| {
        AppError::BadRequest("federation is not enabled".into())
    })?;

    let join_mgr = mesh.join_manager().clone();
    let info = join_mgr
        .validate_join_token(&token)
        .map_err(AppError::BadRequest)?;

    Ok(Json(json!(info)))
}
