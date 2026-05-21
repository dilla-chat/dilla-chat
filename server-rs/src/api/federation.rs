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
/// Generate a federation join token. Caller must hold
/// `PERM_MANAGE_FEDERATION` in at least one team they own
/// (server-operator privilege class — see architecture review §6.2 / A3).
/// `PERM_ADMIN` implies this bit via the bitmask short-circuit in
/// `user_has_permission`.
pub async fn create_join_token(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
) -> Result<Json<Value>, AppError> {
    let mesh = state.mesh.as_ref().ok_or_else(|| {
        AppError::BadRequest("federation is not enabled".into())
    })?;

    // A3: federation gating uses PERM_MANAGE_FEDERATION across any team
    // the caller owns or holds the bit in. We can't tie this to a single
    // team (federation is node-wide), so we sweep the user's memberships
    // and pass if any one of them grants the perm.
    let db = state.db.clone();
    let uid = user_id.clone();
    let permitted = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            // `users.is_admin = true` continues to grant federation
            // management to the bootstrap user so the dev pattern keeps
            // working without a per-team role.
            if let Some(u) = db::get_user_by_id(conn, &uid)? {
                if u.is_admin {
                    return Ok(true);
                }
            }
            let memberships = db::list_user_teams(conn, &uid)?;
            for team_id in memberships {
                if db::user_has_permission(conn, &uid, &team_id, db::PERM_MANAGE_FEDERATION)? {
                    return Ok(true);
                }
            }
            Ok(false)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?
    .map_err(|e: rusqlite::Error| AppError::Internal(format!("db: {}", e)))?;

    if !permitted {
        return Err(AppError::Forbidden(
            "PERM_MANAGE_FEDERATION required to mint a federation join token".into(),
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
