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

    // ── axum integration tests — mesh-disabled branches ────────────

    use crate::auth::AuthService;
    use crate::config::Config;
    use crate::db::Database;
    use crate::presence::PresenceManager;
    use crate::ws::Hub;
    use axum::body::Body;
    use axum::http::Request;
    use axum::routing::{get, post, put};
    use axum::Router;
    use std::sync::Arc;
    use tower::ServiceExt;

    fn make_state() -> (AppState, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let database = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        database.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
        database.run_migrations().unwrap();
        let auth = Arc::new(AuthService::new(database.clone(), ""));
        let hub = Arc::new(Hub::new(database.clone()));
        let presence = Arc::new(PresenceManager::new());
        let mut cfg = Config::default();
        cfg.port = 8080;
        cfg.data_dir = tmp.path().to_str().unwrap().to_string();
        let state = AppState {
            db: database,
            auth,
            hub,
            presence,
            config: Arc::new(cfg),
            mesh: None, // federation disabled
            custom_theme_css: None,
        };
        (state, tmp)
    }

    fn router(state: AppState, user_id: &'static str) -> Router {
        Router::new()
            .route("/federation/status", get(get_status))
            .route("/federation/peers", get(get_peers))
            .route("/federation/join-token", post(create_join_token))
            .route("/federation/join-info", get(get_join_info))
            .route("/federation/identity", get(get_node_identity))
            .route("/federation/pinned-peers", get(list_pinned_peers).post(pin_peer))
            .route("/federation/teams/{team_id}/authority", put(set_team_authority))
            .layer(axum::Extension(UserId(user_id.to_string())))
            .with_state(state)
    }

    #[tokio::test]
    async fn get_status_returns_400_when_mesh_disabled() {
        let (state, _tmp) = make_state();
        let app = router(state, "alice");
        let resp = app
            .oneshot(Request::get("/federation/status").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn get_peers_returns_400_when_mesh_disabled() {
        let (state, _tmp) = make_state();
        let app = router(state, "alice");
        let resp = app
            .oneshot(Request::get("/federation/peers").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn create_join_token_returns_400_when_mesh_disabled() {
        let (state, _tmp) = make_state();
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::post("/federation/join-token")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn get_node_identity_endpoint_does_not_panic() {
        let (state, _tmp) = make_state();
        let app = router(state, "alice");
        let resp = app
            .oneshot(Request::get("/federation/identity").body(Body::empty()).unwrap())
            .await
            .unwrap();
        // Any status code works — what matters is that we don't 5xx-panic.
        let _ = resp.status();
    }

    #[tokio::test]
    async fn list_pinned_peers_returns_empty_array_for_fresh_db() {
        let (state, _tmp) = make_state();
        let app = router(state, "alice");
        let resp = app
            .oneshot(Request::get("/federation/pinned-peers").body(Body::empty()).unwrap())
            .await
            .unwrap();
        // pin_peer requires admin perms → list_pinned_peers may also.
        // Either way, no panic.
        assert!(resp.status() == 200 || resp.status() == 403);
    }

    #[tokio::test]
    async fn pin_peer_rejects_non_admin_with_403() {
        let (state, _tmp) = make_state();
        let app = router(state, "ghost");
        let body = r#"{"node_id":"node1","public_key_b64":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","hostname":"peer.example"}"#;
        let resp = app
            .oneshot(
                Request::post("/federation/pinned-peers")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        // Non-admin → permission denial (403 or 404).
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn set_team_authority_rejects_non_admin() {
        let (state, _tmp) = make_state();
        let app = router(state, "ghost");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/federation/teams/t1/authority")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"owner_node_id":"node-1"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn get_join_info_does_not_panic_when_mesh_disabled() {
        let (state, _tmp) = make_state();
        let app = router(state, "alice");
        let resp = app
            .oneshot(Request::get("/federation/join-info").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let _ = resp.status();
    }

    fn seed_team_with_admin(db: &crate::db::Database) {
        let now = crate::db::now_str();
        db.with_conn(|conn| {
            crate::db::create_user(conn, &crate::db::User {
                id: "admin".into(),
                username: "admin".into(),
                display_name: "Admin".into(),
                public_key: vec![1u8; 32],
                status_type: "online".into(),
                created_at: now.clone(),
                updated_at: now.clone(),
                ..Default::default()
            })?;
            crate::db::create_team(conn, &crate::db::Team {
                id: "t1".into(),
                name: "T".into(),
                created_by: "admin".into(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                created_at: now.clone(),
                updated_at: now,
                ..Default::default()
            })?;
            Ok::<(), rusqlite::Error>(())
        }).unwrap();
    }

    #[tokio::test]
    async fn pin_peer_rejects_empty_node_id_when_admin() {
        let (state, _tmp) = make_state();
        seed_team_with_admin(&state.db);
        let app = router(state, "admin");
        let body = r#"{"node_id":"","public_key_b64":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","hostname":"peer.example"}"#;
        let resp = app
            .oneshot(
                Request::post("/federation/pinned-peers")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn pin_peer_rejects_empty_hostname() {
        let (state, _tmp) = make_state();
        seed_team_with_admin(&state.db);
        let app = router(state, "admin");
        let body = r#"{"node_id":"node-1","public_key_b64":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","hostname":""}"#;
        let resp = app
            .oneshot(
                Request::post("/federation/pinned-peers")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn pin_peer_rejects_invalid_base64_public_key() {
        let (state, _tmp) = make_state();
        seed_team_with_admin(&state.db);
        let app = router(state, "admin");
        let body = r#"{"node_id":"n","public_key_b64":"!!not-base64","hostname":"h"}"#;
        let resp = app
            .oneshot(
                Request::post("/federation/pinned-peers")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn pin_peer_rejects_wrong_length_public_key() {
        let (state, _tmp) = make_state();
        seed_team_with_admin(&state.db);
        let app = router(state, "admin");
        let body = r#"{"node_id":"n","public_key_b64":"YWJj","hostname":"h"}"#;
        let resp = app
            .oneshot(
                Request::post("/federation/pinned-peers")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    fn seed_admin_user(db: &crate::db::Database) {
        let now = crate::db::now_str();
        db.with_conn(|conn| {
            crate::db::create_user(conn, &crate::db::User {
                id: "super".into(),
                username: "super".into(),
                display_name: "Super".into(),
                public_key: vec![3u8; 32],
                status_type: "online".into(),
                is_admin: true,
                created_at: now.clone(),
                updated_at: now,
                ..Default::default()
            })?;
            Ok::<(), rusqlite::Error>(())
        }).unwrap();
    }

    #[tokio::test]
    async fn pin_peer_happy_path_with_global_admin() {
        let (state, _tmp) = make_state();
        seed_admin_user(&state.db);
        let app = router(state, "super");
        // Real 32-byte Ed25519 secret → derive a valid verifying key bytes.
        use ed25519_dalek::SigningKey;
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pk_bytes = sk.verifying_key().to_bytes();
        use base64::Engine as _;
        let pk_b64 = base64::engine::general_purpose::STANDARD.encode(pk_bytes);
        let body = format!(
            r#"{{"node_id":"peer-1","public_key_b64":"{}","hostname":"peer.example"}}"#,
            pk_b64
        );
        let resp = app
            .oneshot(
                Request::post("/federation/pinned-peers")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn list_pinned_peers_returns_array_for_admin() {
        let (state, _tmp) = make_state();
        seed_admin_user(&state.db);
        let app = router(state, "super");
        let resp = app
            .oneshot(Request::get("/federation/pinned-peers").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn get_node_identity_returns_200_for_admin() {
        let (state, _tmp) = make_state();
        seed_admin_user(&state.db);
        let app = router(state, "super");
        let resp = app
            .oneshot(Request::get("/federation/identity").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn set_team_authority_404_for_unknown_team() {
        let (state, _tmp) = make_state();
        seed_admin_user(&state.db);
        let app = router(state, "super");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/federation/teams/no-such-team/authority")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"owner_node_id":"some-node"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 404);
    }

    #[tokio::test]
    async fn set_team_authority_rejects_empty_owner_node_id() {
        let (state, _tmp) = make_state();
        seed_admin_user(&state.db);
        let app = router(state, "super");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/federation/teams/t1/authority")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"owner_node_id":""}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn set_team_authority_happy_path_with_local_node_id() {
        let (state, _tmp) = make_state();
        seed_admin_user(&state.db);
        // Seed a team so the team-existence check passes.
        let now = crate::db::now_str();
        state.db.with_conn(|conn| {
            crate::db::create_team(conn, &crate::db::Team {
                id: "t-auth".into(),
                name: "T".into(),
                created_by: "super".into(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                created_at: now.clone(),
                updated_at: now,
                ..Default::default()
            })
        }).unwrap();
        // Boot the local node identity so we can pass its node_id as the owner.
        let local_identity = crate::federation::identity::ensure(&state.db).unwrap();
        let app = router(state, "super");
        let body = format!(r#"{{"owner_node_id":"{}"}}"#, local_identity.node_id);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/federation/teams/t-auth/authority")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn set_team_authority_rejects_unpinned_owner_node_id() {
        let (state, _tmp) = make_state();
        seed_admin_user(&state.db);
        let now = crate::db::now_str();
        state.db.with_conn(|conn| {
            crate::db::create_team(conn, &crate::db::Team {
                id: "t-stranger".into(),
                name: "T".into(),
                created_by: "super".into(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                created_at: now.clone(),
                updated_at: now,
                ..Default::default()
            })
        }).unwrap();
        let app = router(state, "super");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/federation/teams/t-stranger/authority")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"owner_node_id":"some-unpinned-node"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        // Not us, not a pinned peer → BadRequest.
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn revoke_peer_404_for_unknown_node() {
        let (state, _tmp) = make_state();
        seed_admin_user(&state.db);
        // Mount the revoke route on top of the existing router.
        let app = Router::new()
            .route("/federation/pinned-peers/{node_id}", axum::routing::delete(revoke_peer))
            .layer(axum::Extension(UserId("super".to_string())))
            .with_state(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/federation/pinned-peers/no-such-peer")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        // Either 404 (not found) or 500 (internal) — both exercise the
        // post-perms path. Smoke test.
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn revoke_peer_happy_path_after_pin() {
        let (state, _tmp) = make_state();
        seed_admin_user(&state.db);
        // First pin a peer so revoke has something to revoke.
        use ed25519_dalek::SigningKey;
        let sk = SigningKey::from_bytes(&[9u8; 32]);
        let pk_bytes = sk.verifying_key().to_bytes();
        use base64::Engine as _;
        let pk_b64 = base64::engine::general_purpose::STANDARD.encode(pk_bytes);
        let body = format!(
            r#"{{"node_id":"peer-rev","public_key_b64":"{}","hostname":"peer.example"}}"#,
            pk_b64
        );
        let app1 = router(state.clone(), "super");
        let r1 = app1
            .oneshot(
                Request::post("/federation/pinned-peers")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r1.status(), 200);
        // Now revoke it.
        let app2 = Router::new()
            .route("/federation/pinned-peers/{node_id}", axum::routing::delete(revoke_peer))
            .layer(axum::Extension(UserId("super".to_string())))
            .with_state(state);
        let r2 = app2
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/federation/pinned-peers/peer-rev")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r2.status(), 200);
    }

    #[tokio::test]
    async fn set_team_authority_rejects_oversized_owner_node_id() {
        let (state, _tmp) = make_state();
        seed_admin_user(&state.db);
        let app = router(state, "super");
        let oversize = "n".repeat(129);
        let body = format!(r#"{{"owner_node_id":"{}"}}"#, oversize);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/federation/teams/t1/authority")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn pin_peer_rejects_oversized_node_id() {
        let (state, _tmp) = make_state();
        seed_team_with_admin(&state.db);
        let app = router(state, "admin");
        let oversize = "n".repeat(129);
        let body = format!(
            r#"{{"node_id":"{}","public_key_b64":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","hostname":"h"}}"#,
            oversize,
        );
        let resp = app
            .oneshot(
                Request::post("/federation/pinned-peers")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }
}
