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

// ── Phase 3 peer-management endpoints ─────────────────────────────
//
// All four endpoints require PERM_MANAGE_FEDERATION (same gate as the
// existing join-token mint). Federation is node-wide, so we sweep
// the caller's memberships and pass if any one of them grants the
// bit — identical pattern to create_join_token above.

async fn require_manage_federation(
    state: &AppState,
    user_id: &str,
) -> Result<(), AppError> {
    let db = state.db.clone();
    let uid = user_id.to_string();
    let permitted = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            if let Some(u) = db::get_user_by_id(conn, &uid)? {
                if u.is_admin {
                    return Ok(true);
                }
            }
            for team_id in db::list_user_teams(conn, &uid)? {
                if db::user_has_permission(conn, &uid, &team_id, db::PERM_MANAGE_FEDERATION)? {
                    return Ok(true);
                }
            }
            Ok::<bool, rusqlite::Error>(false)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?
    .map_err(|e| AppError::Internal(format!("db: {}", e)))?;
    if !permitted {
        return Err(AppError::Forbidden(
            "PERM_MANAGE_FEDERATION required".into(),
        ));
    }
    Ok(())
}

/// GET /api/v1/federation/identity
///
/// Returns this node's stable Ed25519 identity (node_id + public key)
/// so an operator can copy the public material to a remote node and
/// pin it via `POST /api/v1/federation/pinned-peers` there. The
/// private key never crosses this boundary.
pub async fn get_node_identity(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
) -> Result<Json<Value>, AppError> {
    require_manage_federation(&state, &user_id).await?;
    let db = state.db.clone();
    let identity = tokio::task::spawn_blocking(move || {
        crate::federation::identity::ensure(&db)
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?
    .map_err(|e| AppError::Internal(format!("db: {}", e)))?;
    use base64::Engine as _;
    Ok(Json(json!({
        "node_id": identity.node_id,
        "public_key_b64": base64::engine::general_purpose::STANDARD
            .encode(identity.public_key_bytes()),
        "public_key_hex": identity
            .public_key_bytes()
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>(),
    })))
}

/// GET /api/v1/federation/pinned-peers
///
/// List the pinned-peer registry (different from
/// `/api/v1/federation/peers`, which reflects the live MeshNode
/// connection state). Revoked peers are included with `revoked_at`
/// set so the operator can see who used to be in.
pub async fn list_pinned_peers(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
) -> Result<Json<Value>, AppError> {
    require_manage_federation(&state, &user_id).await?;
    let db = state.db.clone();
    let rows = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| crate::federation::peers::list_all(conn))
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?
    .map_err(|e| AppError::Internal(format!("db: {}", e)))?;
    use base64::Engine as _;
    let view: Vec<Value> = rows
        .into_iter()
        .map(|p| {
            json!({
                "node_id": p.node_id,
                "public_key_b64": base64::engine::general_purpose::STANDARD
                    .encode(p.public_key.to_bytes()),
                "hostname": p.hostname,
                "pinned_at": p.pinned_at,
                "revoked_at": p.revoked_at,
                "active": p.is_active(),
            })
        })
        .collect();
    Ok(Json(json!(view)))
}

#[derive(Deserialize)]
pub struct PinPeerRequest {
    pub node_id: String,
    pub public_key_b64: String,
    pub hostname: String,
}

/// POST /api/v1/federation/pinned-peers
///
/// Pin (or re-pin) a remote peer. Body carries the peer's node_id,
/// base64 Ed25519 public key, and hostname — values an operator
/// copies out-of-band from `GET /api/v1/federation/identity` on the
/// remote node. Re-pinning a revoked peer un-revokes it.
pub async fn pin_peer(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Json(body): Json<PinPeerRequest>,
) -> Result<Json<Value>, AppError> {
    require_manage_federation(&state, &user_id).await?;

    // Trim+sanity-check inputs before touching the DB.
    let node_id = body.node_id.trim().to_string();
    let hostname = body.hostname.trim().to_string();
    if node_id.is_empty() {
        return Err(AppError::BadRequest("node_id is required".into()));
    }
    if hostname.is_empty() {
        return Err(AppError::BadRequest("hostname is required".into()));
    }
    if node_id.len() > 128 || hostname.len() > 253 {
        return Err(AppError::BadRequest("node_id or hostname too long".into()));
    }

    use base64::Engine as _;
    let pk_bytes = base64::engine::general_purpose::STANDARD
        .decode(body.public_key_b64.trim())
        .map_err(|e| AppError::BadRequest(format!("public_key_b64 not valid base64: {e}")))?;
    let pk_arr: [u8; 32] = pk_bytes
        .as_slice()
        .try_into()
        .map_err(|_| AppError::BadRequest("public_key_b64 must decode to 32 bytes".into()))?;
    let public_key = ed25519_dalek::VerifyingKey::from_bytes(&pk_arr)
        .map_err(|e| AppError::BadRequest(format!("public_key not a valid Ed25519 key: {e}")))?;

    let db = state.db.clone();
    let nid_log = node_id.clone();
    let host_log = hostname.clone();
    let pinned = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let peer = crate::federation::peers::pin(conn, &node_id, &public_key, &hostname)?;
            // Audit-log the federation-level action. No team_id (this
            // is node-scoped), so route through every team the actor
            // is in — same pattern as the device-revoke audit hook.
            let actor_teams = db::list_user_teams(conn, &user_id).unwrap_or_default();
            for tid in actor_teams {
                let _ = db::insert_audit_event(
                    conn,
                    &tid,
                    Some(&user_id),
                    "federation.peer.pinned",
                    Some("federation_peer"),
                    Some(&peer.node_id),
                    Some(&json!({
                        "hostname": peer.hostname,
                    })),
                );
            }
            Ok::<_, rusqlite::Error>(peer)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?
    .map_err(|e| AppError::Internal(format!("db: {}", e)))?;

    tracing::info!(
        node_id = %nid_log,
        hostname = %host_log,
        "FEDERATION: peer pinned"
    );

    Ok(Json(json!({
        "node_id": pinned.node_id,
        "hostname": pinned.hostname,
        "pinned_at": pinned.pinned_at,
        "active": pinned.is_active(),
    })))
}

/// PUT /api/v1/federation/team-authority/{team_id}
///
/// Backfill (or transfer) the authoritative node for a team. Used
/// during the Phase 3 rolling upgrade so operators can stamp
/// pre-existing teams (which predate migration 030 and otherwise
/// fall through to `LegacyTeam`) with a real owner. Body carries the
/// target `owner_node_id`, which must be either this node's id
/// (from `GET /api/v1/federation/identity`) or a currently-active
/// pinned peer (from `GET /api/v1/federation/pinned-peers`).
#[derive(Deserialize)]
pub struct SetTeamAuthorityRequest {
    pub owner_node_id: String,
}

pub async fn set_team_authority(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
    Json(body): Json<SetTeamAuthorityRequest>,
) -> Result<Json<Value>, AppError> {
    require_manage_federation(&state, &user_id).await?;

    let owner_node_id = body.owner_node_id.trim().to_string();
    if owner_node_id.is_empty() {
        return Err(AppError::BadRequest("owner_node_id is required".into()));
    }
    if owner_node_id.len() > 128 {
        return Err(AppError::BadRequest("owner_node_id too long".into()));
    }

    let db = state.db.clone();
    let tid = team_id.clone();
    let owner = owner_node_id.clone();
    let uid = user_id.clone();
    tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            // (a) Team must exist locally.
            if db::get_team(conn, &tid)?.is_none() {
                return Err(rusqlite::Error::InvalidParameterName(
                    "team not found".into(),
                ));
            }
            // (b) owner_node_id must be either us or a currently-
            // active pinned peer. This prevents an operator from
            // accidentally handing authority to an unpinned (and
            // therefore not-yet-trusted) node, which the
            // authority::check would then accept but wire::verify
            // would reject — confusing state. Read the local
            // node_id directly via the same connection.
            let local_node_id: Option<String> = conn
                .query_row(
                    "SELECT node_id FROM node_identity WHERE id = 1",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .ok();
            let is_self = local_node_id.as_deref() == Some(owner.as_str());
            let is_pinned_peer = crate::federation::peers::active_public_key(conn, &owner)
                .map(|opt| opt.is_some())
                .unwrap_or(false);
            if !is_self && !is_pinned_peer {
                return Err(rusqlite::Error::InvalidParameterName(
                    "owner_node_id is not this node and not a pinned peer".into(),
                ));
            }

            crate::federation::authority::record_team_owner(conn, &tid, &owner)?;
            let _ = db::insert_audit_event(
                conn,
                &tid,
                Some(&uid),
                "federation.team_authority.set",
                Some("team"),
                Some(&tid),
                Some(&json!({ "owner_node_id": owner })),
            );
            Ok::<_, rusqlite::Error>(())
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?
    .map_err(|e| match e {
        rusqlite::Error::InvalidParameterName(s) if s == "team not found" => AppError::NotFound(s),
        rusqlite::Error::InvalidParameterName(s) => AppError::BadRequest(s),
        other => AppError::Internal(format!("db: {}", other)),
    })?;

    tracing::info!(
        team_id = %team_id,
        owner_node_id = %owner_node_id,
        "FEDERATION: team authority set"
    );
    Ok(Json(json!({
        "team_id": team_id,
        "owner_node_id": owner_node_id,
    })))
}

/// DELETE /api/v1/federation/pinned-peers/:node_id
///
/// Revoke a pinned peer. Future inbound `SignedFederationEvent`s from
/// this `node_id` are dropped at the verify step. The row stays in
/// `federation_peers` for forensics; re-pinning un-revokes.
pub async fn revoke_peer(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(node_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    require_manage_federation(&state, &user_id).await?;
    let db = state.db.clone();
    let nid = node_id.clone();
    let uid = user_id.clone();
    tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            crate::federation::peers::revoke(conn, &nid)?;
            let actor_teams = db::list_user_teams(conn, &uid).unwrap_or_default();
            for tid in actor_teams {
                let _ = db::insert_audit_event(
                    conn,
                    &tid,
                    Some(&uid),
                    "federation.peer.revoked",
                    Some("federation_peer"),
                    Some(&nid),
                    None,
                );
            }
            Ok::<_, rusqlite::Error>(())
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?
    .map_err(|e| match e {
        rusqlite::Error::InvalidParameterName(s) if s.contains("not found") => {
            AppError::NotFound(s)
        }
        other => AppError::Internal(format!("db: {}", other)),
    })?;

    tracing::info!(node_id = %node_id, "FEDERATION: peer revoked");
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_join_token_request_accepts_empty_body() {
        // The struct is empty by design — creator comes from auth.
        let _r: CreateJoinTokenRequest = serde_json::from_str("{}").unwrap();
    }

    #[test]
    fn pin_peer_request_requires_all_three_fields() {
        let r: PinPeerRequest = serde_json::from_str(r#"{
            "node_id":"n1","public_key_b64":"abc","hostname":"peer.example"
        }"#).unwrap();
        assert_eq!(r.node_id, "n1");
        assert_eq!(r.public_key_b64, "abc");
        assert_eq!(r.hostname, "peer.example");
    }

    #[test]
    fn pin_peer_request_rejects_missing_fields() {
        assert!(serde_json::from_str::<PinPeerRequest>(r#"{"node_id":"n"}"#).is_err());
        assert!(serde_json::from_str::<PinPeerRequest>(r#"{"public_key_b64":"x"}"#).is_err());
        assert!(serde_json::from_str::<PinPeerRequest>(r#"{"hostname":"h"}"#).is_err());
    }

    #[test]
    fn set_team_authority_request_requires_owner_node_id() {
        let r: SetTeamAuthorityRequest =
            serde_json::from_str(r#"{"owner_node_id":"node-1"}"#).unwrap();
        assert_eq!(r.owner_node_id, "node-1");
        assert!(serde_json::from_str::<SetTeamAuthorityRequest>("{}").is_err());
    }
}
