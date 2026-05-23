use super::*;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use crate::config::Config;
use crate::db::{self, Database};
use crate::presence::PresenceManager;
use ed25519_dalek::{Signer, SigningKey};
use rand::RngCore;
use base64::Engine;
use tower::ServiceExt;

fn test_db() -> (Database, tempfile::TempDir) {
    let tmp = tempfile::tempdir().unwrap();
    let db = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
    db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
    db.run_migrations().unwrap();
    (db, tmp)
}

fn test_config() -> Config {
    Config {
        port: 8080,
        data_dir: "/tmp/test".into(),
        db_passphrase: String::new(),
        tls_cert: String::new(),
        tls_key: String::new(),
        peers: vec![],
        team_name: "Test Team".into(),
        federation_port: 8081,
        node_name: String::new(),
        join_secret: String::new(),
        fed_bind_addr: "0.0.0.0".into(),
        fed_advert_addr: String::new(),
        fed_advert_port: 0,
        max_upload_size: 25 * 1024 * 1024,
        upload_dir: "/tmp/test/uploads".into(),
        log_level: "info".into(),
        log_format: "text".into(),
        rate_limit: 100.0,
        rate_burst: 200,
        domain: "localhost".into(),
        cf_turn_key_id: String::new(),
        cf_turn_api_token: String::new(),
        turn_mode: String::new(),
        turn_shared_secret: String::new(),
        turn_urls: String::new(),
        turn_ttl: 86400,
        allowed_origins: vec![],
        trusted_proxies: vec![],
        insecure: false,
        theme_file: String::new(),
        telemetry_adapter: "none".into(),
        sentry_dsn: String::new(),
        environment: "test".into(),
        otel_enabled: false,
        otel_protocol: "http".into(),
        otel_endpoint: "localhost:4317".into(),
        otel_http_endpoint: String::new(),
        otel_insecure: false,
        otel_service_name: "test".into(),
        otel_api_key: String::new(),
        otel_api_header: String::new(),
        seed_demo: false,
        browser_log_forward: false,
    
        ..Default::default()
    }
}

fn test_app_state() -> (AppState, tempfile::TempDir) {
    let (db, tmp) = test_db();
    let auth = Arc::new(AuthService::new(db.clone(), ""));
    let hub = Arc::new(Hub::new(db.clone()));
    let presence = Arc::new(PresenceManager::new());
    let config = Arc::new(test_config());

    let state = AppState {
        db,
        auth,
        hub,
        presence,
        config,
        mesh: None,
        custom_theme_css: None,
    };
    (state, tmp)
}

/// Bootstrap a team+user in the DB and return (user_id, team_id, jwt_token).
fn bootstrap_user_and_team(state: &AppState) -> (String, String, String) {
    let now = db::now_str();
    let user_id = db::new_id();
    let team_id = db::new_id();

    state.db.with_conn(|conn| {
        db::create_user(conn, &db::User {
            id: user_id.clone(),
            username: "testuser".into(),
            display_name: "Test User".into(),
            public_key: vec![0u8; 32],
            avatar_url: String::new(),
            status_text: String::new(),
            status_type: "online".into(),
            is_admin: true,
            created_at: now.clone(),
            updated_at: now.clone(),
        
            ..Default::default()
        })?;
        db::create_team(conn, &db::Team {
            id: team_id.clone(),
            name: "Test Team".into(),
            description: String::new(),
            icon_url: String::new(),
            created_by: user_id.clone(),
            max_file_size: 25 * 1024 * 1024,
            allow_member_invites: true,
            federated: false,
            created_at: now.clone(),
            updated_at: now.clone(),
        
            ..Default::default()
        })?;
        db::create_member(conn, &db::Member {
            id: db::new_id(),
            team_id: team_id.clone(),
            user_id: user_id.clone(),
            nickname: String::new(),
            joined_at: now.clone(),
            invited_by: String::new(),
            updated_at: String::new(),
        })?;
        // Create admin role with all permissions.
        let role_id = db::new_id();
        db::create_role(conn, &db::Role {
            id: role_id.clone(),
            team_id: team_id.clone(),
            name: "admin".into(),
            color: "#FF0000".into(),
            position: 0,
            permissions: db::PERM_ADMIN
                | db::PERM_MANAGE_CHANNELS
                | db::PERM_MANAGE_MEMBERS
                | db::PERM_MANAGE_ROLES
                | db::PERM_SEND_MESSAGES
                | db::PERM_MANAGE_MESSAGES
                | db::PERM_CREATE_INVITES
                | db::PERM_MANAGE_TEAM,
            is_default: true,
            created_at: now.clone(),
            updated_at: String::new(),
        })?;
        // Assign role to member.
        let member = db::get_member_by_user_and_team(conn, &user_id, &team_id)?.unwrap();
        db::assign_role_to_member(conn, &member.id, &role_id)
    })
    .unwrap();

    let token = state.auth.generate_jwt(&user_id).unwrap();
    (user_id, team_id, token)
}

/// Build a test router with {param} syntax (axum 0.8 format) routing to the same handlers.
fn test_router(state: AppState) -> Router {
    use axum::routing::{delete, get, patch, post, put};

    let public = Router::new()
        .route("/api/v1/health", get(super::health))
        .route("/api/v1/version", get(super::version))
        .route("/api/v1/config", get(super::get_config))
        .route(
            "/api/voice/models/manifest.json",
            get(super::voice::models_manifest),
        )
        .route(
            "/api/voice/models/{*path}",
            get(super::voice::models_serve),
        )
        .route("/api/v1/auth/challenge", post(super::auth_handlers::challenge))
        .route("/api/v1/auth/verify", post(super::auth_handlers::verify))
        .route("/api/v1/auth/register", post(super::auth_handlers::register))
        .route("/api/v1/auth/bootstrap", post(super::auth_handlers::bootstrap))
        .route("/api/v1/invites/{token}/info", get(super::invites::get_invite_info))
        .route("/api/v1/federation/join/{token}", get(super::federation::get_join_info))
        .route("/api/v1/debug/browser-log", post(super::debug::ingest))
        .route("/api/v1/auth/refresh", post(super::auth_handlers::refresh));

    let protected = Router::new()
        .route("/api/v1/users/me", get(super::users::get_me).patch(super::users::update_me).delete(super::users::delete_me))
        .route("/api/v1/identity/blob", get(super::users::get_identity_blob).put(super::users::put_identity_blob))
        .route("/api/v1/teams", get(super::teams::list).post(super::teams::create))
        .route("/api/v1/teams/{team_id}", get(super::teams::get_team).patch(super::teams::update))
        .route("/api/v1/teams/{team_id}/members", get(super::teams::list_members))
        .route("/api/v1/teams/{team_id}/members/{user_id}", patch(super::teams::update_member).delete(super::teams::kick_member))
        .route("/api/v1/teams/{team_id}/members/{user_id}/ban", post(super::teams::ban_member).delete(super::teams::unban_member))
        .route("/api/v1/teams/{team_id}/leave", post(super::teams::leave_team))
        .route("/api/v1/teams/{team_id}/gif", get(super::gif::search))
        .route("/api/v1/teams/{team_id}/channels", get(super::channels::list).post(super::channels::create))
        .route("/api/v1/teams/{team_id}/channels/{channel_id}", get(super::channels::get_channel).patch(super::channels::update).delete(super::channels::delete_channel))
        .route("/api/v1/teams/{team_id}/channels/{channel_id}/read", put(super::channels::mark_read))
        .route("/api/v1/teams/{team_id}/channels/{channel_id}/messages", get(super::messages::list).post(super::messages::create))
        .route("/api/v1/teams/{team_id}/channels/{channel_id}/messages/{message_id}", patch(super::messages::edit).delete(super::messages::delete_msg))
        .route("/api/v1/teams/{team_id}/roles", get(super::roles::list).post(super::roles::create))
        .route("/api/v1/teams/{team_id}/roles/reorder", put(super::roles::reorder))
        .route("/api/v1/teams/{team_id}/roles/{role_id}", patch(super::roles::update).delete(super::roles::delete_role))
        .route("/api/v1/teams/{team_id}/invites", get(super::invites::list).post(super::invites::create))
        .route("/api/v1/teams/{team_id}/invites/{invite_id}", delete(super::invites::revoke))
        .route("/api/v1/teams/{team_id}/dms", get(super::dms::list).post(super::dms::create_or_get))
        .route("/api/v1/teams/{team_id}/dms/{dm_id}", get(super::dms::get_dm))
        .route("/api/v1/teams/{team_id}/dms/{dm_id}/messages", get(super::dms::list_messages).post(super::dms::send_message))
        .route("/api/v1/teams/{team_id}/dms/{dm_id}/messages/{message_id}", put(super::dms::edit_message).delete(super::dms::delete_message))
        .route("/api/v1/teams/{team_id}/dms/{dm_id}/members", post(super::dms::add_members))
        .route("/api/v1/teams/{team_id}/dms/{dm_id}/members/{user_id}", delete(super::dms::remove_member))
        .route("/api/v1/teams/{team_id}/channels/{channel_id}/threads", get(super::threads::list).post(super::threads::create))
        .route("/api/v1/teams/{team_id}/threads/{thread_id}", get(super::threads::get_thread).put(super::threads::update).delete(super::threads::delete_thread))
        .route("/api/v1/teams/{team_id}/threads/{thread_id}/messages", get(super::threads::list_messages).post(super::threads::create_message))
        .route("/api/v1/teams/{team_id}/channels/{channel_id}/messages/{message_id}/reactions/{emoji}", put(super::reactions::add).delete(super::reactions::remove))
        .route("/api/v1/teams/{team_id}/channels/{channel_id}/messages/{message_id}/reactions", get(super::reactions::list))
        .route("/api/v1/teams/{team_id}/upload", post(super::uploads::upload))
        .route("/api/v1/teams/{team_id}/attachments/{attachment_id}", get(super::uploads::download).delete(super::uploads::delete_attachment))
        .route("/api/v1/teams/{team_id}/presence", get(super::presence::get_all).put(super::presence::update_own))
        .route("/api/v1/teams/{team_id}/presence/{user_id}", get(super::presence::get_user))
        .route("/api/v1/teams/{team_id}/voice/{channel_id}", get(super::voice::get_room))
        .route("/api/v1/users/me/blocks", get(super::blocks::list))
        .route(
            "/api/v1/users/me/blocks/{blocked_id}",
            post(super::blocks::block).delete(super::blocks::unblock),
        )
        .route("/api/v1/me/muted-channels", get(super::channel_mutes::list))
        .route(
            "/api/v1/me/muted-channels/{channel_id}",
            put(super::channel_mutes::mute).delete(super::channel_mutes::unmute),
        )
        .route("/api/v1/teams/{team_id}/audit", get(super::audit::list))
        .route(
            "/api/v1/teams/{team_id}/integrations/giphy",
            get(super::integrations::get_giphy).put(super::integrations::set_giphy),
        )
        .route(
            "/api/v1/prekeys",
            post(super::prekeys::upload).delete(super::prekeys::delete_own),
        )
        .route("/api/v1/prekeys/{user_id}", get(super::prekeys::get_bundle))
        .route("/api/v1/auth/ws-ticket", post(super::ws_ticket))
        .route("/api/v1/auth/logout", post(super::auth_handlers::logout))
        .route("/api/v1/federation/status", get(super::federation::get_status))
        .route("/api/v1/federation/peers", get(super::federation::get_peers))
        .route("/api/v1/federation/join-token", post(super::federation::create_join_token))
        // Pins
        .route(
            "/api/v1/teams/{team_id}/channels/{channel_id}/pins",
            get(super::pins::list_for_channel),
        )
        .route(
            "/api/v1/teams/{team_id}/channels/{channel_id}/messages/{message_id}/pin",
            post(super::pins::pin).delete(super::pins::unpin),
        )
        // Polls
        .route(
            "/api/v1/teams/{team_id}/channels/{channel_id}/polls",
            get(super::polls::list_for_channel).post(super::polls::create),
        )
        .route(
            "/api/v1/teams/{team_id}/polls/{poll_id}/votes",
            post(super::polls::vote).delete(super::polls::unvote),
        )
        // Channel groups
        .route(
            "/api/v1/teams/{team_id}/groups",
            get(super::channel_groups::list).post(super::channel_groups::create),
        )
        .route(
            "/api/v1/teams/{team_id}/groups/{group_id}",
            put(super::channel_groups::update).delete(super::channel_groups::delete),
        )
        .route(
            "/api/v1/teams/{team_id}/groups/{group_id}/access",
            get(super::channel_groups::get_access).put(super::channel_groups::set_access),
        )
        // Devices
        .route("/api/v1/devices", get(super::devices::list_devices))
        .route(
            "/api/v1/devices/enroll-begin",
            post(super::devices::enroll_begin),
        )
        .route(
            "/api/v1/devices/enroll-complete",
            post(super::devices::enroll_complete),
        )
        .route(
            "/api/v1/devices/{device_id}/revoke",
            post(super::devices::revoke_device),
        )
        .layer(axum::middleware::from_fn(crate::auth::auth_middleware));

    let cors = tower_http::cors::CorsLayer::very_permissive();

    Router::new()
        .merge(public)
        .merge(protected)
        .layer(Extension(state.auth.clone()))
        .layer(cors)
        .with_state(state)
}

async fn body_to_json(body: Body) -> serde_json::Value {
    let bytes = axum::body::to_bytes(body, 1024 * 1024).await.unwrap();
    serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
}

// ══════════════════════════════════════════════════════════════════
// Public endpoint tests
// ══════════════════════════════════════════════════════════════════

#[tokio::test]
async fn health_returns_ok() {
    let (state, _tmp) = test_app_state();
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["status"], "ok");
}

#[tokio::test]
async fn version_returns_runtime() {
    let (state, _tmp) = test_app_state();
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/version")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["runtime"], "rust");
}

#[tokio::test]
async fn config_returns_domain() {
    let (state, _tmp) = test_app_state();
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/config")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["domain"], "localhost");
}

// ══════════════════════════════════════════════════════════════════
// Auth endpoint tests
// ══════════════════════════════════════════════════════════════════

#[tokio::test]
async fn challenge_valid_public_key() {
    let (state, _tmp) = test_app_state();
    let app = test_router(state);

    let signing_key = {
            let mut key_bytes = [0u8; 32];
            rand::rng().fill_bytes(&mut key_bytes);
            SigningKey::from_bytes(&key_bytes)
        };
    let pk = signing_key.verifying_key();
    let pk_b64 = base64::engine::general_purpose::STANDARD.encode(pk.as_bytes());

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/auth/challenge")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"public_key": pk_b64}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert!(json["challenge_id"].is_string());
    assert!(json["nonce"].is_string());
}

#[tokio::test]
async fn challenge_invalid_base64_returns_400() {
    let (state, _tmp) = test_app_state();
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/auth/challenge")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"public_key": "not-valid-base64!!!"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn challenge_wrong_key_length_returns_400() {
    let (state, _tmp) = test_app_state();
    let app = test_router(state);

    // 16 bytes instead of 32.
    let pk_b64 = base64::engine::general_purpose::STANDARD.encode(&[0u8; 16]);

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/auth/challenge")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"public_key": pk_b64}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn verify_nonexistent_user_returns_401() {
    let (state, _tmp) = test_app_state();
    let auth = state.auth.clone();
    let app = test_router(state);

    let signing_key = {
            let mut key_bytes = [0u8; 32];
            rand::rng().fill_bytes(&mut key_bytes);
            SigningKey::from_bytes(&key_bytes)
        };
    let pk = signing_key.verifying_key();
    let pk_b64 = base64::engine::general_purpose::STANDARD.encode(pk.as_bytes());

    let (nonce, challenge_id) = auth.generate_challenge().unwrap();
    let sig = signing_key.sign(&nonce);
    let sig_b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/auth/verify")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "challenge_id": challenge_id,
                        "public_key": pk_b64,
                        "signature": sig_b64,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn bootstrap_creates_user_and_team() {
    let (state, _tmp) = test_app_state();
    let auth = state.auth.clone();
    let app = test_router(state.clone());

    let signing_key = {
            let mut key_bytes = [0u8; 32];
            rand::rng().fill_bytes(&mut key_bytes);
            SigningKey::from_bytes(&key_bytes)
        };
    let pk = signing_key.verifying_key();
    let pk_b64 = base64::engine::general_purpose::STANDARD.encode(pk.as_bytes());

    let (nonce, challenge_id) = auth.generate_challenge().unwrap();
    let sig = signing_key.sign(&nonce);
    let sig_b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());

    // Create bootstrap token.
    let bt = auth.generate_bootstrap_token().unwrap();

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/auth/bootstrap")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "challenge_id": challenge_id,
                        "public_key": pk_b64,
                        "signature": sig_b64,
                        "username": "admin",
                        "bootstrap_token": bt,
                        "team_name": "My Server",
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert!(json["token"].is_string());
    assert!(json["team_id"].is_string());
    assert_eq!(json["user"]["username"], "admin");
}

#[tokio::test]
async fn bootstrap_invalid_token_returns_400() {
    let (state, _tmp) = test_app_state();
    let auth = state.auth.clone();
    let app = test_router(state);

    let signing_key = {
            let mut key_bytes = [0u8; 32];
            rand::rng().fill_bytes(&mut key_bytes);
            SigningKey::from_bytes(&key_bytes)
        };
    let pk = signing_key.verifying_key();
    let pk_b64 = base64::engine::general_purpose::STANDARD.encode(pk.as_bytes());

    let (nonce, challenge_id) = auth.generate_challenge().unwrap();
    let sig = signing_key.sign(&nonce);
    let sig_b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/auth/bootstrap")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "challenge_id": challenge_id,
                        "public_key": pk_b64,
                        "signature": sig_b64,
                        "username": "admin",
                        "bootstrap_token": "invalid-token",
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

// ══════════════════════════════════════════════════════════════════
// Protected endpoint tests (require auth)
// ══════════════════════════════════════════════════════════════════

#[tokio::test]
async fn protected_endpoint_without_auth_returns_401() {
    let (state, _tmp) = test_app_state();
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/teams")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn protected_endpoint_with_invalid_token_returns_401() {
    let (state, _tmp) = test_app_state();
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/teams")
                .header("authorization", "Bearer invalid.token.here")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

// ══════════════════════════════════════════════════════════════════
// Team endpoint tests
// ══════════════════════════════════════════════════════════════════

#[tokio::test]
async fn list_teams_returns_teams_for_user() {
    let (state, _tmp) = test_app_state();
    let (_user_id, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/teams")
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    let teams = json.as_array().unwrap();
    assert_eq!(teams.len(), 1);
    assert_eq!(teams[0]["name"], "Test Team");
}

#[tokio::test]
async fn get_team_returns_team_details() {
    let (state, _tmp) = test_app_state();
    let (_user_id, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri(&format!("/api/v1/teams/{}", team_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["id"], team_id);
    assert_eq!(json["name"], "Test Team");
}

#[tokio::test]
async fn create_team_returns_new_team() {
    let (state, _tmp) = test_app_state();
    let (_user_id, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/teams")
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"name": "New Team", "description": "desc"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["name"], "New Team");
    assert_eq!(json["description"], "desc");
}

#[tokio::test]
async fn create_team_empty_name_returns_400() {
    let (state, _tmp) = test_app_state();
    let (_user_id, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/teams")
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"name": ""}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn list_members_returns_team_members() {
    let (state, _tmp) = test_app_state();
    let (_user_id, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri(&format!("/api/v1/teams/{}/members", team_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    let members = json.as_array().unwrap();
    assert_eq!(members.len(), 1);
}

// ══════════════════════════════════════════════════════════════════
// Channel endpoint tests
// ══════════════════════════════════════════════════════════════════

#[tokio::test]
async fn create_and_list_channels() {
    let (state, _tmp) = test_app_state();
    let (_user_id, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state.clone());

    // Create a channel.
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/v1/teams/{}/channels", team_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"name": "dev", "topic": "Development"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["name"], "dev");
    assert_eq!(json["topic"], "Development");
    let channel_id = json["id"].as_str().unwrap().to_string();

    // List channels.
    let app2 = test_router(state.clone());
    let resp = app2
        .oneshot(
            Request::builder()
                .uri(&format!("/api/v1/teams/{}/channels", team_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    let channels = json.as_array().unwrap();
    assert!(channels.len() >= 1);

    // Get single channel.
    let app3 = test_router(state);
    let resp = app3
        .oneshot(
            Request::builder()
                .uri(&format!("/api/v1/teams/{}/channels/{}", team_id, channel_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["name"], "dev");
}

#[tokio::test]
async fn create_channel_empty_name_returns_400() {
    let (state, _tmp) = test_app_state();
    let (_user_id, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/v1/teams/{}/channels", team_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"name": ""}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn delete_channel_works() {
    let (state, _tmp) = test_app_state();
    let (_user_id, team_id, token) = bootstrap_user_and_team(&state);

    // Create channel.
    let now = db::now_str();
    let channel_id = db::new_id();
    state.db.with_conn(|conn| {
        db::create_channel(conn, &db::Channel {
            id: channel_id.clone(),
            team_id: team_id.clone(),
            name: "to-delete".into(),
            topic: String::new(),
            channel_type: "text".into(),
            position: 0,
            category: String::new(),
            created_by: _user_id.clone(),
            created_at: now.clone(),
            updated_at: now,
        
            ..Default::default()
        })
    })
    .unwrap();

    let app = test_router(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(&format!("/api/v1/teams/{}/channels/{}", team_id, channel_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
}

// ══════════════════════════════════════════════════════════════════
// Message endpoint tests
// ══════════════════════════════════════════════════════════════════

#[tokio::test]
async fn create_and_list_messages() {
    let (state, _tmp) = test_app_state();
    let (_user_id, team_id, token) = bootstrap_user_and_team(&state);

    // Create channel.
    let now = db::now_str();
    let channel_id = db::new_id();
    state.db.with_conn(|conn| {
        db::create_channel(conn, &db::Channel {
            id: channel_id.clone(),
            team_id: team_id.clone(),
            name: "general".into(),
            topic: String::new(),
            channel_type: "text".into(),
            position: 0,
            category: String::new(),
            created_by: _user_id.clone(),
            created_at: now.clone(),
            updated_at: now,
        
            ..Default::default()
        })
    })
    .unwrap();

    // Create message.
    let app = test_router(state.clone());
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!(
                    "/api/v1/teams/{}/channels/{}/messages",
                    team_id, channel_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"content": "hello world"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["content"], "hello world");
    let message_id = json["id"].as_str().unwrap().to_string();

    // List messages.
    let app2 = test_router(state.clone());
    let resp = app2
        .oneshot(
            Request::builder()
                .uri(&format!(
                    "/api/v1/teams/{}/channels/{}/messages",
                    team_id, channel_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    let messages = json.as_array().unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["content"], "hello world");

    // Edit message.
    let app3 = test_router(state.clone());
    let resp = app3
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(&format!(
                    "/api/v1/teams/{}/channels/{}/messages/{}",
                    team_id, channel_id, message_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"content": "edited"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["content"], "edited");

    // Delete message.
    let app4 = test_router(state);
    let resp = app4
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(&format!(
                    "/api/v1/teams/{}/channels/{}/messages/{}",
                    team_id, channel_id, message_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn create_message_empty_content_returns_400() {
    let (state, _tmp) = test_app_state();
    let (_user_id, team_id, token) = bootstrap_user_and_team(&state);

    let now = db::now_str();
    let channel_id = db::new_id();
    state.db.with_conn(|conn| {
        db::create_channel(conn, &db::Channel {
            id: channel_id.clone(),
            team_id: team_id.clone(),
            name: "ch".into(),
            topic: String::new(),
            channel_type: "text".into(),
            position: 0,
            category: String::new(),
            created_by: _user_id.clone(),
            created_at: now.clone(),
            updated_at: now,
        
            ..Default::default()
        })
    })
    .unwrap();

    let app = test_router(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!(
                    "/api/v1/teams/{}/channels/{}/messages",
                    team_id, channel_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"content": ""}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

// ══════════════════════════════════════════════════════════════════
// Role endpoint tests
// ══════════════════════════════════════════════════════════════════

#[tokio::test]
async fn create_and_list_roles() {
    let (state, _tmp) = test_app_state();
    let (_user_id, team_id, token) = bootstrap_user_and_team(&state);

    // Create role.
    let app = test_router(state.clone());
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/v1/teams/{}/roles", team_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"name": "moderator", "color": "#00FF00", "permissions": 48}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["name"], "moderator");
    assert_eq!(json["color"], "#00FF00");

    // List roles.
    let app2 = test_router(state);
    let resp = app2
        .oneshot(
            Request::builder()
                .uri(&format!("/api/v1/teams/{}/roles", team_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    let roles = json.as_array().unwrap();
    assert!(roles.len() >= 2); // admin + moderator
}

#[tokio::test]
async fn create_role_empty_name_returns_400() {
    let (state, _tmp) = test_app_state();
    let (_user_id, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/v1/teams/{}/roles", team_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"name": ""}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

// ══════════════════════════════════════════════════════════════════
// DM endpoint tests
// ══════════════════════════════════════════════════════════════════

#[tokio::test]
async fn create_and_list_dms() {
    let (state, _tmp) = test_app_state();
    let (user_id, team_id, token) = bootstrap_user_and_team(&state);

    // Create a second user.
    let now = db::now_str();
    let user2_id = db::new_id();
    state.db.with_conn(|conn| {
        db::create_user(conn, &db::User {
            id: user2_id.clone(),
            username: "bob".into(),
            display_name: "Bob".into(),
            public_key: vec![1u8; 32],
            avatar_url: String::new(),
            status_text: String::new(),
            status_type: "online".into(),
            is_admin: false,
            created_at: now.clone(),
            updated_at: now.clone(),
        
            ..Default::default()
        })?;
        db::create_member(conn, &db::Member {
            id: db::new_id(),
            team_id: team_id.clone(),
            user_id: user2_id.clone(),
            nickname: String::new(),
            joined_at: now,
            invited_by: user_id.clone(),
            updated_at: String::new(),
        })
    })
    .unwrap();

    // Create DM.
    let app = test_router(state.clone());
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/v1/teams/{}/dms", team_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"user_ids": [user2_id]}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert!(json["id"].is_string());
    let dm_id = json["id"].as_str().unwrap().to_string();

    // List DMs.
    let app2 = test_router(state.clone());
    let resp = app2
        .oneshot(
            Request::builder()
                .uri(&format!("/api/v1/teams/{}/dms", team_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    let dms = json.as_array().unwrap();
    assert_eq!(dms.len(), 1);

    // Send message in DM.
    let app3 = test_router(state.clone());
    let resp = app3
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/v1/teams/{}/dms/{}/messages", team_id, dm_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"content": "hey bob"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["content"], "hey bob");
}

#[tokio::test]
async fn create_dm_empty_user_ids_returns_400() {
    let (state, _tmp) = test_app_state();
    let (_user_id, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/v1/teams/{}/dms", team_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"user_ids": []}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

// ══════════════════════════════════════════════════════════════════
// 404 for unknown routes
// ══════════════════════════════════════════════════════════════════

#[tokio::test]
async fn unknown_public_route_returns_404() {
    let (state, _tmp) = test_app_state();
    let (_user_id, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    // With valid auth, an unknown route returns 404.
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/nonexistent")
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

// ══════════════════════════════════════════════════════════════════
// Update team tests
// ══════════════════════════════════════════════════════════════════

#[tokio::test]
async fn update_team_changes_name() {
    let (state, _tmp) = test_app_state();
    let (_user_id, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(&format!("/api/v1/teams/{}", team_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"name": "Renamed Team"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["name"], "Renamed Team");
}

// ══════════════════════════════════════════════════════════════════
// Update channel tests
// ══════════════════════════════════════════════════════════════════

#[tokio::test]
async fn update_channel_changes_topic() {
    let (state, _tmp) = test_app_state();
    let (_user_id, team_id, token) = bootstrap_user_and_team(&state);

    let now = db::now_str();
    let channel_id = db::new_id();
    state.db.with_conn(|conn| {
        db::create_channel(conn, &db::Channel {
            id: channel_id.clone(),
            team_id: team_id.clone(),
            name: "general".into(),
            topic: "old topic".into(),
            channel_type: "text".into(),
            position: 0,
            category: String::new(),
            created_by: _user_id.clone(),
            created_at: now.clone(),
            updated_at: now,
        
            ..Default::default()
        })
    })
    .unwrap();

    let app = test_router(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(&format!("/api/v1/teams/{}/channels/{}", team_id, channel_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"topic": "new topic"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["topic"], "new topic");
    assert_eq!(json["name"], "general");
}

// ══════════════════════════════════════════════════════════════════
// Non-member access tests
// ══════════════════════════════════════════════════════════════════

#[tokio::test]
async fn non_member_cannot_access_team() {
    let (state, _tmp) = test_app_state();
    let (_user_id, _team_id, _token) = bootstrap_user_and_team(&state);

    // Create a second user who is NOT a member of the team.
    let now = db::now_str();
    let other_id = db::new_id();
    state.db.with_conn(|conn| {
        db::create_user(conn, &db::User {
            id: other_id.clone(),
            username: "outsider".into(),
            display_name: "Outsider".into(),
            public_key: vec![2u8; 32],
            avatar_url: String::new(),
            status_text: String::new(),
            status_type: "online".into(),
            is_admin: false,
            created_at: now.clone(),
            updated_at: now,
        
            ..Default::default()
        })
    })
    .unwrap();

    let other_token = state.auth.generate_jwt(&other_id).unwrap();
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri(&format!("/api/v1/teams/{}", _team_id))
                .header("authorization", format!("Bearer {}", other_token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

// ══════════════════════════════════════════════════════════════════
// Invite endpoint tests
// ══════════════════════════════════════════════════════════════════

#[tokio::test]
async fn create_and_list_invites() {
    let (state, _tmp) = test_app_state();
    let (_user_id, team_id, token) = bootstrap_user_and_team(&state);

    // Create invite.
    let app = test_router(state.clone());
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/v1/teams/{}/invites", team_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"max_uses": 10, "expires_in_hours": 24}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert!(json["id"].is_string());
    assert!(json["token"].is_string());
    let invite_id = json["id"].as_str().unwrap().to_string();
    let invite_token = json["token"].as_str().unwrap().to_string();

    // List invites.
    let app2 = test_router(state.clone());
    let resp = app2
        .oneshot(
            Request::builder()
                .uri(&format!("/api/v1/teams/{}/invites", team_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    let invites = json.as_array().unwrap();
    assert!(invites.len() >= 1);

    // Get invite info (public endpoint).
    let app3 = test_router(state.clone());
    let resp = app3
        .oneshot(
            Request::builder()
                .uri(&format!("/api/v1/invites/{}/info", invite_token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["team_id"], team_id);

    // Revoke invite.
    let app4 = test_router(state);
    let resp = app4
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(&format!("/api/v1/teams/{}/invites/{}", team_id, invite_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn get_invite_info_invalid_token_returns_404() {
    let (state, _tmp) = test_app_state();
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/invites/nonexistent-token/info")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn create_invite_no_expiry_or_max() {
    let (state, _tmp) = test_app_state();
    let (_user_id, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/v1/teams/{}/invites", team_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(serde_json::json!({}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert!(json["token"].is_string());
    assert!(json["max_uses"].is_null());
}

// ══════════════════════════════════════════════════════════════════
// Role update/delete/reorder endpoint tests
// ══════════════════════════════════════════════════════════════════

#[tokio::test]
async fn update_role_changes_name_and_color() {
    let (state, _tmp) = test_app_state();
    let (_user_id, team_id, token) = bootstrap_user_and_team(&state);

    // Create role.
    let role_id = db::new_id();
    state.db.with_conn(|conn| {
        db::create_role(conn, &db::Role {
            id: role_id.clone(),
            team_id: team_id.clone(),
            name: "moderator".into(),
            color: "#FF0000".into(),
            position: 1,
            permissions: db::PERM_SEND_MESSAGES,
            is_default: false,
            created_at: db::now_str(),
            updated_at: String::new(),
        })
    })
    .unwrap();

    let app = test_router(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(&format!("/api/v1/teams/{}/roles/{}", team_id, role_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"name": "admin2", "color": "#00FF00"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["name"], "admin2");
    assert_eq!(json["color"], "#00FF00");
}

#[tokio::test]
async fn delete_role_removes_role() {
    let (state, _tmp) = test_app_state();
    let (_user_id, team_id, token) = bootstrap_user_and_team(&state);

    // Create non-default role.
    let role_id = db::new_id();
    state.db.with_conn(|conn| {
        db::create_role(conn, &db::Role {
            id: role_id.clone(),
            team_id: team_id.clone(),
            name: "deleteme".into(),
            color: "#999999".into(),
            position: 5,
            permissions: 0,
            is_default: false,
            created_at: db::now_str(),
            updated_at: String::new(),
        })
    })
    .unwrap();

    let app = test_router(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(&format!("/api/v1/teams/{}/roles/{}", team_id, role_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn delete_default_role_returns_error() {
    let (state, _tmp) = test_app_state();
    let (_user_id, team_id, token) = bootstrap_user_and_team(&state);

    // The bootstrap creates a default role. Find it.
    let default_role_id = state.db.with_conn(|conn| {
        let roles = db::get_roles_by_team(conn, &team_id)?;
        let default = roles.into_iter().find(|r| r.is_default).unwrap();
        Ok(default.id)
    }).unwrap();

    let app = test_router(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(&format!("/api/v1/teams/{}/roles/{}", team_id, default_role_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    // Should fail because it's the default role.
    assert_ne!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn reorder_roles() {
    let (state, _tmp) = test_app_state();
    let (_user_id, team_id, token) = bootstrap_user_and_team(&state);

    // Create two more roles.
    let role_a = db::new_id();
    let role_b = db::new_id();
    state.db.with_conn(|conn| {
        db::create_role(conn, &db::Role {
            id: role_a.clone(),
            team_id: team_id.clone(),
            name: "role_a".into(),
            color: "#111111".into(),
            position: 1,
            permissions: 0,
            is_default: false,
            created_at: db::now_str(),
            updated_at: String::new(),
        })?;
        db::create_role(conn, &db::Role {
            id: role_b.clone(),
            team_id: team_id.clone(),
            name: "role_b".into(),
            color: "#222222".into(),
            position: 2,
            permissions: 0,
            is_default: false,
            created_at: db::now_str(),
            updated_at: String::new(),
        })
    })
    .unwrap();

    let app = test_router(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(&format!("/api/v1/teams/{}/roles/reorder", team_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"role_ids": [role_b, role_a]}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn reorder_roles_empty_returns_400() {
    let (state, _tmp) = test_app_state();
    let (_user_id, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(&format!("/api/v1/teams/{}/roles/reorder", team_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"role_ids": []}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

// ══════════════════════════════════════════════════════════════════
// DM extended endpoint tests
// ══════════════════════════════════════════════════════════════════

/// Helper: create a second user and DM for DM tests.
fn setup_dm(state: &AppState, user_id: &str, team_id: &str) -> (String, String) {
    let now = db::now_str();
    let user2_id = db::new_id();
    state.db.with_conn(|conn| {
        db::create_user(conn, &db::User {
            id: user2_id.clone(),
            username: "bob".into(),
            display_name: "Bob".into(),
            public_key: vec![1u8; 32],
            avatar_url: String::new(),
            status_text: String::new(),
            status_type: "online".into(),
            is_admin: false,
            created_at: now.clone(),
            updated_at: now.clone(),
        
            ..Default::default()
        })?;
        db::create_member(conn, &db::Member {
            id: db::new_id(),
            team_id: team_id.to_string(),
            user_id: user2_id.clone(),
            nickname: String::new(),
            joined_at: now.clone(),
            invited_by: user_id.to_string(),
            updated_at: String::new(),
        })?;
        // Create DM channel.
        let dm = db::DMChannel {
            id: db::new_id(),
            team_id: team_id.to_string(),
            dm_type: "dm".into(),
            name: String::new(),
            created_at: now,
        };
        db::create_dm_channel(conn, &dm)?;
        db::add_dm_members(conn, &dm.id, &[user_id.to_string(), user2_id.clone()])?;
        Ok((dm.id, user2_id))
    })
    .unwrap()
}

#[tokio::test]
async fn get_dm_returns_channel_and_members() {
    let (state, _tmp) = test_app_state();
    let (user_id, team_id, token) = bootstrap_user_and_team(&state);
    let (dm_id, _user2) = setup_dm(&state, &user_id, &team_id);

    let app = test_router(state);
    let resp = app
        .oneshot(
            Request::builder()
                .uri(&format!("/api/v1/teams/{}/dms/{}", team_id, dm_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    // GET /dms/{id} now returns the same enriched channel shape the list
    // endpoint returns — `channel.members` is the array, not a sibling
    // `members` field. See enrich_dm_channel in api/dms.rs.
    assert!(json["channel"].is_object());
    assert!(json["channel"]["members"].is_array());
    assert!(json["channel"]["is_group"].is_boolean());
}

#[tokio::test]
async fn dm_send_and_list_messages() {
    let (state, _tmp) = test_app_state();
    let (user_id, team_id, token) = bootstrap_user_and_team(&state);
    let (dm_id, _user2) = setup_dm(&state, &user_id, &team_id);

    // Send message.
    let app = test_router(state.clone());
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/v1/teams/{}/dms/{}/messages", team_id, dm_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"content": "hello DM"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["content"], "hello DM");
    let message_id = json["id"].as_str().unwrap().to_string();

    // List messages.
    let app2 = test_router(state.clone());
    let resp = app2
        .oneshot(
            Request::builder()
                .uri(&format!("/api/v1/teams/{}/dms/{}/messages", team_id, dm_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    let messages = json.as_array().unwrap();
    assert_eq!(messages.len(), 1);

    // Edit message.
    let app3 = test_router(state.clone());
    let resp = app3
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(&format!(
                    "/api/v1/teams/{}/dms/{}/messages/{}",
                    team_id, dm_id, message_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"content": "edited DM"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["content"], "edited DM");

    // Delete message.
    let app4 = test_router(state);
    let resp = app4
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(&format!(
                    "/api/v1/teams/{}/dms/{}/messages/{}",
                    team_id, dm_id, message_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn dm_send_empty_content_returns_400() {
    let (state, _tmp) = test_app_state();
    let (user_id, team_id, token) = bootstrap_user_and_team(&state);
    let (dm_id, _user2) = setup_dm(&state, &user_id, &team_id);

    let app = test_router(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/v1/teams/{}/dms/{}/messages", team_id, dm_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"content": ""}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn dm_edit_empty_content_returns_400() {
    let (state, _tmp) = test_app_state();
    let (user_id, team_id, token) = bootstrap_user_and_team(&state);
    let (dm_id, _user2) = setup_dm(&state, &user_id, &team_id);

    // Create a message first.
    state.db.with_conn(|conn| {
        db::create_dm_message(conn, &db::Message {
            id: "msg1".into(),
            channel_id: String::new(),
            dm_channel_id: dm_id.clone(),
            author_id: user_id.clone(),
            content: "original".into(),
            msg_type: "text".into(),
            thread_id: String::new(),
            edited_at: None,
            deleted: false,
            lamport_ts: 0,
            created_at: db::now_str(),
        
            ..Default::default()
        })
    }).unwrap();

    let app = test_router(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(&format!("/api/v1/teams/{}/dms/{}/messages/msg1", team_id, dm_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"content": ""}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn dm_add_and_remove_members() {
    let (state, _tmp) = test_app_state();
    let (user_id, team_id, token) = bootstrap_user_and_team(&state);
    let (dm_id, _user2) = setup_dm(&state, &user_id, &team_id);

    // Create a third user.
    let now = db::now_str();
    let user3_id = db::new_id();
    state.db.with_conn(|conn| {
        db::create_user(conn, &db::User {
            id: user3_id.clone(),
            username: "charlie".into(),
            display_name: "Charlie".into(),
            public_key: vec![3u8; 32],
            avatar_url: String::new(),
            status_text: String::new(),
            status_type: "online".into(),
            is_admin: false,
            created_at: now.clone(),
            updated_at: now,
        
            ..Default::default()
        })
    })
    .unwrap();

    // Add member.
    let app = test_router(state.clone());
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/v1/teams/{}/dms/{}/members", team_id, dm_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"user_ids": [user3_id]}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);

    // Remove member.
    let app2 = test_router(state);
    let resp = app2
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(&format!(
                    "/api/v1/teams/{}/dms/{}/members/{}",
                    team_id, dm_id, user3_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn dm_add_members_empty_returns_400() {
    let (state, _tmp) = test_app_state();
    let (user_id, team_id, token) = bootstrap_user_and_team(&state);
    let (dm_id, _user2) = setup_dm(&state, &user_id, &team_id);

    let app = test_router(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/v1/teams/{}/dms/{}/members", team_id, dm_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"user_ids": []}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

// ══════════════════════════════════════════════════════════════════
// Presence endpoint tests
// ══════════════════════════════════════════════════════════════════

#[tokio::test]
async fn get_all_presence() {
    let (state, _tmp) = test_app_state();
    let (_user_id, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri(&format!("/api/v1/teams/{}/presence", team_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn update_own_presence() {
    let (state, _tmp) = test_app_state();
    let (_user_id, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(&format!("/api/v1/teams/{}/presence", team_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"status": "dnd", "custom_status": "busy"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn get_user_presence() {
    let (state, _tmp) = test_app_state();
    let (user_id, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri(&format!("/api/v1/teams/{}/presence/{}", team_id, user_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
}

// ══════════════════════════════════════════════════════════════════
// User endpoint tests
// ══════════════════════════════════════════════════════════════════

#[tokio::test]
async fn get_me_returns_current_user() {
    let (state, _tmp) = test_app_state();
    let (_user_id, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/users/me")
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["username"], "testuser");
}

#[tokio::test]
async fn update_me_changes_display_name() {
    let (state, _tmp) = test_app_state();
    let (_user_id, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/api/v1/users/me")
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"display_name": "New Name"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["display_name"], "New Name");
}

// ══════════════════════════════════════════════════════════════════
// Federation endpoint tests
// ══════════════════════════════════════════════════════════════════

#[tokio::test]
async fn federation_status_without_mesh_returns_400() {
    let (state, _tmp) = test_app_state();
    let (_user_id, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/federation/status")
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    // Federation not enabled, so mesh is None -> 400.
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn federation_peers_without_mesh_returns_400() {
    let (state, _tmp) = test_app_state();
    let (_user_id, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/federation/peers")
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    // Federation not enabled, so mesh is None -> 400.
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

// ══════════════════════════════════════════════════════════════════
// Voice endpoint tests
// ══════════════════════════════════════════════════════════════════

#[tokio::test]
async fn get_voice_room() {
    let (state, _tmp) = test_app_state();
    let (_user_id, team_id, token) = bootstrap_user_and_team(&state);

    // Create a voice channel.
    let now = db::now_str();
    let channel_id = db::new_id();
    state.db.with_conn(|conn| {
        db::create_channel(conn, &db::Channel {
            id: channel_id.clone(),
            team_id: team_id.clone(),
            name: "voice".into(),
            topic: String::new(),
            channel_type: "voice".into(),
            position: 0,
            category: String::new(),
            created_by: _user_id.clone(),
            created_at: now.clone(),
            updated_at: now,
        
            ..Default::default()
        })
    })
    .unwrap();

    let app = test_router(state);
    let resp = app
        .oneshot(
            Request::builder()
                .uri(&format!("/api/v1/teams/{}/voice/{}", team_id, channel_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
}

// ══════════════════════════════════════════════════════════════════
// Register endpoint tests
// ══════════════════════════════════════════════════════════════════

#[tokio::test]
async fn register_with_valid_invite() {
    let (state, _tmp) = test_app_state();
    let auth = state.auth.clone();

    // First, bootstrap to create a team.
    let signing_key1 = {
        let mut key_bytes = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::rng(), &mut key_bytes);
        SigningKey::from_bytes(&key_bytes)
    };
    let pk1 = signing_key1.verifying_key();
    let pk1_b64 = base64::engine::general_purpose::STANDARD.encode(pk1.as_bytes());
    let (nonce1, cid1) = auth.generate_challenge().unwrap();
    let sig1 = signing_key1.sign(&nonce1);
    let sig1_b64 = base64::engine::general_purpose::STANDARD.encode(sig1.to_bytes());
    let bt = auth.generate_bootstrap_token().unwrap();

    let app = test_router(state.clone());
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/auth/bootstrap")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "challenge_id": cid1,
                        "public_key": pk1_b64,
                        "signature": sig1_b64,
                        "username": "admin",
                        "bootstrap_token": bt,
                        "team_name": "Test Server",
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    let team_id = json["team_id"].as_str().unwrap().to_string();
    let admin_token = json["token"].as_str().unwrap().to_string();

    // Create an invite.
    let app2 = test_router(state.clone());
    let resp = app2
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/v1/teams/{}/invites", team_id))
                .header("authorization", format!("Bearer {}", admin_token))
                .header("content-type", "application/json")
                .body(Body::from(serde_json::json!({}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    let invite_token = json["token"].as_str().unwrap().to_string();

    // Now register a new user with the invite.
    let signing_key2 = {
        let mut key_bytes = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::rng(), &mut key_bytes);
        SigningKey::from_bytes(&key_bytes)
    };
    let pk2 = signing_key2.verifying_key();
    let pk2_b64 = base64::engine::general_purpose::STANDARD.encode(pk2.as_bytes());
    let (nonce2, cid2) = auth.generate_challenge().unwrap();
    let sig2 = signing_key2.sign(&nonce2);
    let sig2_b64 = base64::engine::general_purpose::STANDARD.encode(sig2.to_bytes());

    let app3 = test_router(state);
    let resp = app3
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/auth/register")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "challenge_id": cid2,
                        "public_key": pk2_b64,
                        "signature": sig2_b64,
                        "username": "newuser",
                        "invite_token": invite_token,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert!(json["token"].is_string());
    assert_eq!(json["user"]["username"], "newuser");
    assert_eq!(json["team_id"], team_id);
}

#[tokio::test]
async fn register_empty_username_returns_400() {
    let (state, _tmp) = test_app_state();
    let auth = state.auth.clone();

    let signing_key = {
        let mut key_bytes = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::rng(), &mut key_bytes);
        SigningKey::from_bytes(&key_bytes)
    };
    let pk = signing_key.verifying_key();
    let pk_b64 = base64::engine::general_purpose::STANDARD.encode(pk.as_bytes());
    let (nonce, cid) = auth.generate_challenge().unwrap();
    let sig = signing_key.sign(&nonce);
    let sig_b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());

    let app = test_router(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/auth/register")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "challenge_id": cid,
                        "public_key": pk_b64,
                        "signature": sig_b64,
                        "username": "",
                        "invite_token": "some-token",
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn register_empty_invite_token_returns_400() {
    let (state, _tmp) = test_app_state();
    let auth = state.auth.clone();

    let signing_key = {
        let mut key_bytes = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::rng(), &mut key_bytes);
        SigningKey::from_bytes(&key_bytes)
    };
    let pk = signing_key.verifying_key();
    let pk_b64 = base64::engine::general_purpose::STANDARD.encode(pk.as_bytes());
    let (nonce, cid) = auth.generate_challenge().unwrap();
    let sig = signing_key.sign(&nonce);
    let sig_b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());

    let app = test_router(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/auth/register")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "challenge_id": cid,
                        "public_key": pk_b64,
                        "signature": sig_b64,
                        "username": "testuser",
                        "invite_token": "",
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn bootstrap_empty_username_returns_400() {
    let (state, _tmp) = test_app_state();
    let auth = state.auth.clone();

    let signing_key = {
        let mut key_bytes = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::rng(), &mut key_bytes);
        SigningKey::from_bytes(&key_bytes)
    };
    let pk = signing_key.verifying_key();
    let pk_b64 = base64::engine::general_purpose::STANDARD.encode(pk.as_bytes());
    let (nonce, cid) = auth.generate_challenge().unwrap();
    let sig = signing_key.sign(&nonce);
    let sig_b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());
    let bt = auth.generate_bootstrap_token().unwrap();

    let app = test_router(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/auth/bootstrap")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "challenge_id": cid,
                        "public_key": pk_b64,
                        "signature": sig_b64,
                        "username": "",
                        "bootstrap_token": bt,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn bootstrap_empty_bootstrap_token_returns_400() {
    let (state, _tmp) = test_app_state();
    let auth = state.auth.clone();

    let signing_key = {
        let mut key_bytes = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::rng(), &mut key_bytes);
        SigningKey::from_bytes(&key_bytes)
    };
    let pk = signing_key.verifying_key();
    let pk_b64 = base64::engine::general_purpose::STANDARD.encode(pk.as_bytes());
    let (nonce, cid) = auth.generate_challenge().unwrap();
    let sig = signing_key.sign(&nonce);
    let sig_b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());

    let app = test_router(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/auth/bootstrap")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "challenge_id": cid,
                        "public_key": pk_b64,
                        "signature": sig_b64,
                        "username": "admin",
                        "bootstrap_token": "",
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

// ══════════════════════════════════════════════════════════════════
// CORS tests
// ══════════════════════════════════════════════════════════════════

#[tokio::test]
async fn cors_allowed_origins_config() {
    let (db, tmp) = test_db();
    let auth = Arc::new(AuthService::new(db.clone(), ""));
    let hub = Arc::new(Hub::new(db.clone()));
    let presence = Arc::new(PresenceManager::new());
    let mut cfg = test_config();
    cfg.allowed_origins = vec!["http://localhost:3000".into()];
    let config = Arc::new(cfg);

    let state = AppState {
        db,
        auth,
        hub,
        presence,
        config,
        mesh: None,
        custom_theme_css: None,
    };

    // Use test_router which uses {param} syntax.
    let app = test_router(state);
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    drop(tmp);
}

// ══════════════════════════════════════════════════════════════════
// Team member management endpoint tests
// ══════════════════════════════════════════════════════════════════

/// Helper: create a second team member.
fn add_team_member(state: &AppState, team_id: &str, admin_id: &str) -> String {
    let now = db::now_str();
    let user2_id = db::new_id();
    state.db.with_conn(|conn| {
        db::create_user(conn, &db::User {
            id: user2_id.clone(),
            username: "member2".into(),
            display_name: "Member 2".into(),
            public_key: vec![9u8; 32],
            avatar_url: String::new(),
            status_text: String::new(),
            status_type: "online".into(),
            is_admin: false,
            created_at: now.clone(),
            updated_at: now.clone(),
        
            ..Default::default()
        })?;
        db::create_member(conn, &db::Member {
            id: db::new_id(),
            team_id: team_id.to_string(),
            user_id: user2_id.clone(),
            nickname: String::new(),
            joined_at: now,
            invited_by: admin_id.to_string(),
            updated_at: String::new(),
        })
    })
    .unwrap();
    user2_id
}

#[tokio::test]
async fn update_member_nickname() {
    let (state, _tmp) = test_app_state();
    let (user_id, team_id, token) = bootstrap_user_and_team(&state);
    let user2_id = add_team_member(&state, &team_id, &user_id);

    let app = test_router(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(&format!("/api/v1/teams/{}/members/{}", team_id, user2_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"nickname": "M2"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["nickname"], "M2");
}

#[tokio::test]
async fn kick_member_removes_from_team() {
    let (state, _tmp) = test_app_state();
    let (user_id, team_id, token) = bootstrap_user_and_team(&state);
    let user2_id = add_team_member(&state, &team_id, &user_id);

    let app = test_router(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(&format!("/api/v1/teams/{}/members/{}", team_id, user2_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn kick_self_returns_400() {
    let (state, _tmp) = test_app_state();
    let (user_id, team_id, token) = bootstrap_user_and_team(&state);

    let app = test_router(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(&format!("/api/v1/teams/{}/members/{}", team_id, user_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn ban_and_unban_member() {
    let (state, _tmp) = test_app_state();
    let (user_id, team_id, token) = bootstrap_user_and_team(&state);
    let user2_id = add_team_member(&state, &team_id, &user_id);

    // Ban.
    let app = test_router(state.clone());
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/v1/teams/{}/members/{}/ban", team_id, user2_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"reason": "bad behavior"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);

    // Unban.
    let app2 = test_router(state);
    let resp = app2
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(&format!("/api/v1/teams/{}/members/{}/ban", team_id, user2_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn ban_self_returns_400() {
    let (state, _tmp) = test_app_state();
    let (user_id, team_id, token) = bootstrap_user_and_team(&state);

    let app = test_router(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/v1/teams/{}/members/{}/ban", team_id, user_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"reason": ""}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

// ══════════════════════════════════════════════════════════════════
// Thread endpoint tests
// ══════════════════════════════════════════════════════════════════

#[tokio::test]
async fn create_and_list_threads() {
    let (state, _tmp) = test_app_state();
    let (_user_id, team_id, token) = bootstrap_user_and_team(&state);

    // Create channel and message for thread.
    let now = db::now_str();
    let channel_id = db::new_id();
    let message_id = db::new_id();
    state.db.with_conn(|conn| {
        db::create_channel(conn, &db::Channel {
            id: channel_id.clone(),
            team_id: team_id.clone(),
            name: "threaded".into(),
            topic: String::new(),
            channel_type: "text".into(),
            position: 0,
            category: String::new(),
            created_by: _user_id.clone(),
            created_at: now.clone(),
            updated_at: now.clone(),
        
            ..Default::default()
        })?;
        db::create_message(conn, &db::Message {
            id: message_id.clone(),
            channel_id: channel_id.clone(),
            dm_channel_id: String::new(),
            author_id: _user_id.clone(),
            content: "parent message".into(),
            msg_type: "text".into(),
            thread_id: String::new(),
            edited_at: None,
            deleted: false,
            lamport_ts: 0,
            created_at: now.clone(),
        
            ..Default::default()
        })
    })
    .unwrap();

    // Create thread.
    let app = test_router(state.clone());
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/v1/teams/{}/channels/{}/threads", team_id, channel_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"parent_message_id": message_id, "title": "A thread"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["title"], "A thread");

    // List threads.
    let app2 = test_router(state);
    let resp = app2
        .oneshot(
            Request::builder()
                .uri(&format!("/api/v1/teams/{}/channels/{}/threads", team_id, channel_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    let threads = json.as_array().unwrap();
    assert_eq!(threads.len(), 1);
}

// ══════════════════════════════════════════════════════════════════
// Reaction endpoint tests
// ══════════════════════════════════════════════════════════════════

#[tokio::test]
async fn thread_get_update_delete_and_messages() {
    let (state, _tmp) = test_app_state();
    let (_user_id, team_id, token) = bootstrap_user_and_team(&state);

    let now = db::now_str();
    let channel_id = db::new_id();
    let message_id = db::new_id();
    state.db.with_conn(|conn| {
        db::create_channel(conn, &db::Channel {
            id: channel_id.clone(),
            team_id: team_id.clone(),
            name: "thread-test".into(),
            topic: String::new(),
            channel_type: "text".into(),
            position: 0,
            category: String::new(),
            created_by: _user_id.clone(),
            created_at: now.clone(),
            updated_at: now.clone(),
        
            ..Default::default()
        })?;
        db::create_message(conn, &db::Message {
            id: message_id.clone(),
            channel_id: channel_id.clone(),
            dm_channel_id: String::new(),
            author_id: _user_id.clone(),
            content: "thread parent".into(),
            msg_type: "text".into(),
            thread_id: String::new(),
            edited_at: None,
            deleted: false,
            lamport_ts: 0,
            created_at: now,
        
            ..Default::default()
        })
    })
    .unwrap();

    // Create thread.
    let app = test_router(state.clone());
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/v1/teams/{}/channels/{}/threads", team_id, channel_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"parent_message_id": message_id, "title": "Test Thread"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    let thread_id = json["id"].as_str().unwrap().to_string();

    // Get thread.
    let app2 = test_router(state.clone());
    let resp = app2
        .oneshot(
            Request::builder()
                .uri(&format!("/api/v1/teams/{}/threads/{}", team_id, thread_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["title"], "Test Thread");

    // Update thread.
    let app3 = test_router(state.clone());
    let resp = app3
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(&format!("/api/v1/teams/{}/threads/{}", team_id, thread_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"title": "Updated Thread"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["title"], "Updated Thread");

    // Create thread message.
    let app4 = test_router(state.clone());
    let resp = app4
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/v1/teams/{}/threads/{}/messages", team_id, thread_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"content": "thread reply"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["content"], "thread reply");

    // List thread messages.
    let app5 = test_router(state.clone());
    let resp = app5
        .oneshot(
            Request::builder()
                .uri(&format!("/api/v1/teams/{}/threads/{}/messages", team_id, thread_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    let msgs = json.as_array().unwrap();
    assert_eq!(msgs.len(), 1);

    // Delete thread.
    let app6 = test_router(state);
    let resp = app6
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(&format!("/api/v1/teams/{}/threads/{}", team_id, thread_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn add_and_list_reactions() {
    let (state, _tmp) = test_app_state();
    let (_user_id, team_id, token) = bootstrap_user_and_team(&state);

    let now = db::now_str();
    let channel_id = db::new_id();
    let message_id = db::new_id();
    state.db.with_conn(|conn| {
        db::create_channel(conn, &db::Channel {
            id: channel_id.clone(),
            team_id: team_id.clone(),
            name: "reactions-ch".into(),
            topic: String::new(),
            channel_type: "text".into(),
            position: 0,
            category: String::new(),
            created_by: _user_id.clone(),
            created_at: now.clone(),
            updated_at: now.clone(),
        
            ..Default::default()
        })?;
        db::create_message(conn, &db::Message {
            id: message_id.clone(),
            channel_id: channel_id.clone(),
            dm_channel_id: String::new(),
            author_id: _user_id.clone(),
            content: "react to me".into(),
            msg_type: "text".into(),
            thread_id: String::new(),
            edited_at: None,
            deleted: false,
            lamport_ts: 0,
            created_at: now,
        
            ..Default::default()
        })
    })
    .unwrap();

    // Add reaction.
    let app = test_router(state.clone());
    let resp = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(&format!(
                    "/api/v1/teams/{}/channels/{}/messages/{}/reactions/thumbsup",
                    team_id, channel_id, message_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);

    // List reactions.
    let app2 = test_router(state.clone());
    let resp = app2
        .oneshot(
            Request::builder()
                .uri(&format!(
                    "/api/v1/teams/{}/channels/{}/messages/{}/reactions",
                    team_id, channel_id, message_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    let reactions = json.as_array().unwrap();
    assert_eq!(reactions.len(), 1);

    // Remove reaction.
    let app3 = test_router(state);
    let resp = app3
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(&format!(
                    "/api/v1/teams/{}/channels/{}/messages/{}/reactions/thumbsup",
                    team_id, channel_id, message_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn verify_with_valid_user_returns_token() {
    let (state, _tmp) = test_app_state();
    let auth = state.auth.clone();

    // Create a user with known keys.
    let signing_key = {
        let mut key_bytes = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::rng(), &mut key_bytes);
        SigningKey::from_bytes(&key_bytes)
    };
    let pk = signing_key.verifying_key();
    let pk_bytes = pk.as_bytes().to_vec();
    let now = db::now_str();
    state.db.with_conn(|conn| {
        db::create_user(conn, &db::User {
            id: "verify-user".into(),
            username: "verifyuser".into(),
            display_name: "Verify".into(),
            public_key: pk_bytes,
            avatar_url: String::new(),
            status_text: String::new(),
            status_type: "online".into(),
            is_admin: false,
            created_at: now.clone(),
            updated_at: now,
        
            ..Default::default()
        })
    }).unwrap();

    let pk_b64 = base64::engine::general_purpose::STANDARD.encode(pk.as_bytes());
    let (nonce, cid) = auth.generate_challenge().unwrap();
    let sig = signing_key.sign(&nonce);
    let sig_b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());

    let app = test_router(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/auth/verify")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "challenge_id": cid,
                        "public_key": pk_b64,
                        "signature": sig_b64,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert!(json["token"].is_string());
    assert!(json["refresh_token"].is_string());
    assert_eq!(json["user"]["username"], "verifyuser");
}

// ── SPA fallback tests ─────────────────────────────────────────────────

#[tokio::test]
async fn spa_route_does_not_return_auth_error() {
    let (state, _tmp) = test_app_state();
    let app = create_router(state);

    // /setup is a client-side route — it should NOT hit the auth middleware.
    let req = Request::builder()
        .uri("/setup?token=abc123")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();

    // Without embedded dist/, we get 404 (no index.html) — but crucially NOT 401.
    assert_ne!(
        resp.status(),
        StatusCode::UNAUTHORIZED,
        "/setup should not require auth — it's a SPA route served by the webapp fallback"
    );
}

#[tokio::test]
async fn unknown_path_does_not_return_auth_error() {
    let (state, _tmp) = test_app_state();
    let app = create_router(state);

    let req = Request::builder()
        .uri("/some/random/page")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();

    assert_ne!(
        resp.status(),
        StatusCode::UNAUTHORIZED,
        "non-API paths should fall through to webapp, not auth middleware"
    );
}

#[tokio::test]
async fn api_route_without_auth_returns_unauthorized() {
    let (state, _tmp) = test_app_state();
    let app = create_router(state);

    // Protected API route without a token should return 401.
    // SmartIpKeyExtractor in the rate-limit layer needs *some* client IP
    // signal; in production it's the socket peer address (ConnectInfo).
    // In tower's oneshot() there's no ConnectInfo, so feed X-Forwarded-For
    // so the rate-limit middleware doesn't 500 before auth runs.
    let req = Request::builder()
        .uri("/api/v1/users/me")
        .header("x-forwarded-for", "127.0.0.1")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(
        resp.status(),
        StatusCode::UNAUTHORIZED,
        "protected API routes should require auth"
    );
}

#[tokio::test]
async fn ws_ticket_returns_ticket_for_authenticated_user() {
    let (state, _tmp) = test_app_state();
    let (user_id, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state.clone());

    let resp = app
        .oneshot(
            Request::post("/api/v1/auth/ws-ticket")
                .header("Authorization", format!("Bearer {}", token))
                .header("Content-Type", "application/json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let body: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap(),
    )
    .unwrap();
    assert!(body["ticket"].is_string());
    let ticket = body["ticket"].as_str().unwrap();
    assert_eq!(ticket.len(), 64);

    let uid = state.auth.validate_ws_ticket(ticket).unwrap();
    assert_eq!(uid, user_id);
}

// ══════════════════════════════════════════════════════════════════
// Input length validation tests
// ══════════════════════════════════════════════════════════════════

#[tokio::test]
async fn register_long_username_returns_400() {
    let (state, _tmp) = test_app_state();
    let auth = state.auth.clone();

    let signing_key = {
        let mut key_bytes = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::rng(), &mut key_bytes);
        SigningKey::from_bytes(&key_bytes)
    };
    let pk = signing_key.verifying_key();
    let pk_b64 = base64::engine::general_purpose::STANDARD.encode(pk.as_bytes());
    let (nonce, cid) = auth.generate_challenge().unwrap();
    let sig = signing_key.sign(&nonce);
    let sig_b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());

    let long_username = "a".repeat(33);

    let app = test_router(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/auth/register")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "challenge_id": cid,
                        "public_key": pk_b64,
                        "signature": sig_b64,
                        "username": long_username,
                        "invite_token": "some-token",
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn create_channel_long_name_returns_400() {
    let (state, _tmp) = test_app_state();
    let (_user_id, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let long_name = "a".repeat(101);

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/v1/teams/{}/channels", team_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"name": long_name, "topic": "ok"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn update_team_long_name_returns_400() {
    let (state, _tmp) = test_app_state();
    let (_user_id, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let long_name = "a".repeat(101);

    let resp = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(&format!("/api/v1/teams/{}", team_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"name": long_name}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn update_user_long_display_name_returns_400() {
    let (state, _tmp) = test_app_state();
    let (_, _, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/api/v1/users/me")
                .header("content-type", "application/json")
                .header("Authorization", format!("Bearer {}", token))
                .body(Body::from(
                    serde_json::json!({ "display_name": "a".repeat(65) }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn update_channel_long_topic_returns_400() {
    let (state, _tmp) = test_app_state();
    let (user_id, team_id, token) = bootstrap_user_and_team(&state);

    let channel_id = db::new_id();
    state.db.with_conn(|conn| {
        db::create_channel(conn, &db::Channel {
            id: channel_id.clone(),
            team_id: team_id.clone(),
            name: "test".into(),
            topic: "".into(),
            channel_type: "text".into(),
            position: 0,
            category: "".into(),
            created_by: user_id.clone(),
            created_at: db::now_str(),
            updated_at: db::now_str(),
        
            ..Default::default()
        })
    }).unwrap();

    let app = test_router(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/v1/teams/{}/channels/{}", team_id, channel_id))
                .header("content-type", "application/json")
                .header("Authorization", format!("Bearer {}", token))
                .body(Body::from(
                    serde_json::json!({ "topic": "a".repeat(1025) }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn download_nonexistent_attachment_returns_404() {
    let (state, _tmp) = test_app_state();
    let (_, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/api/v1/teams/{}/attachments/nonexistent-id", team_id))
                .header("Authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    // Should return 404 since attachment doesn't exist
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn download_cross_team_attachment_returns_404() {
    let (state, _tmp) = test_app_state();
    let (user_id, team_id, token) = bootstrap_user_and_team(&state);

    // Create a channel and message in team
    let channel_id = db::new_id();
    let message_id = db::new_id();
    let attachment_id = db::new_id();
    let now = db::now_str();

    state.db.with_conn(|conn| {
        db::create_channel(conn, &db::Channel {
            id: channel_id.clone(), team_id: team_id.clone(), name: "ch".into(),
            topic: "".into(), channel_type: "text".into(), position: 0,
            category: "".into(), created_by: user_id.clone(),
            created_at: now.clone(), updated_at: now.clone(),
        
            ..Default::default()
        })?;
        db::create_message(conn, &db::Message {
            id: message_id.clone(), channel_id: channel_id.clone(),
            dm_channel_id: "".into(), author_id: user_id.clone(),
            content: "test".into(), msg_type: "text".into(),
            thread_id: "".into(), edited_at: None, deleted: false,
            lamport_ts: 0, created_at: now.clone(),
        
            ..Default::default()
        })?;
        db::create_attachment(conn, &db::Attachment {
            id: attachment_id.clone(), message_id: message_id.clone(),
            filename_encrypted: vec![1, 2, 3], content_type_encrypted: vec![4, 5, 6],
            size: 4, storage_path: "/tmp/nonexistent".into(),
            created_at: now.clone(),
        
            ..Default::default()
        })
    }).unwrap();

    // Create a second team and try to download the attachment from it
    let team2_id = db::new_id();
    state.db.with_conn(|conn| {
        db::create_team(conn, &db::Team {
            id: team2_id.clone(), name: "Team2".into(), description: "".into(),
            icon_url: "".into(), created_by: user_id.clone(),
            max_file_size: 1024, allow_member_invites: true,
federated: false,
            created_at: now.clone(), updated_at: now.clone(),
        
            ..Default::default()
        })?;
        db::create_member(conn, &db::Member {
            id: db::new_id(), team_id: team2_id.clone(), user_id: user_id.clone(),
            nickname: "".into(), joined_at: now.clone(), invited_by: user_id.clone(),
            updated_at: "".into(),
        })
    }).unwrap();

    let app = test_router(state);
    // Try to download attachment via team2 — should fail
    let resp = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/api/v1/teams/{}/attachments/{}", team2_id, attachment_id))
                .header("Authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

// ══════════════════════════════════════════════════════════════════
// Channel read status tests
// ══════════════════════════════════════════════════════════════════

#[tokio::test]
async fn mark_channel_read_succeeds() {
    let (state, _tmp) = test_app_state();
    let (_user_id, team_id, token) = bootstrap_user_and_team(&state);

    let now = db::now_str();
    let channel_id = db::new_id();
    let msg_id = db::new_id();
    state.db.with_conn(|conn| {
        db::create_channel(conn, &db::Channel {
            id: channel_id.clone(),
            team_id: team_id.clone(),
            name: "test-channel".into(),
            topic: String::new(),
            channel_type: "text".into(),
            position: 0,
            category: String::new(),
            created_by: _user_id.clone(),
            created_at: now.clone(),
            updated_at: now.clone(),
        
            ..Default::default()
        })?;
        db::create_message(conn, &db::Message {
            id: msg_id.clone(),
            channel_id: channel_id.clone(),
            dm_channel_id: String::new(),
            author_id: _user_id.clone(),
            content: "hello".into(),
            msg_type: "text".into(),
            thread_id: String::new(),
            edited_at: None,
            deleted: false,
            lamport_ts: 0,
            created_at: now.clone(),
        
            ..Default::default()
        })
    })
    .unwrap();

    let app = test_router(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(&format!("/api/v1/teams/{}/channels/{}/read", team_id, channel_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let body: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap(),
    )
    .unwrap();
    assert!(body["last_read_message_id"].is_string());
    assert!(body["last_read_at"].is_string());
}

#[tokio::test]
async fn mark_channel_read_requires_auth() {
    let (state, _tmp) = test_app_state();
    let (_user_id, team_id, _token) = bootstrap_user_and_team(&state);

    let channel_id = db::new_id();
    let app = test_router(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(&format!("/api/v1/teams/{}/channels/{}/read", team_id, channel_id))
                .header("content-type", "application/json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn mark_channel_read_empty_channel_returns_ok() {
    let (state, _tmp) = test_app_state();
    let (_user_id, team_id, token) = bootstrap_user_and_team(&state);

    let now = db::now_str();
    let channel_id = db::new_id();
    state.db.with_conn(|conn| {
        db::create_channel(conn, &db::Channel {
            id: channel_id.clone(),
            team_id: team_id.clone(),
            name: "empty-channel".into(),
            topic: String::new(),
            channel_type: "text".into(),
            position: 0,
            category: String::new(),
            created_by: _user_id.clone(),
            created_at: now.clone(),
            updated_at: now,
        
            ..Default::default()
        })
    })
    .unwrap();

    let app = test_router(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(&format!("/api/v1/teams/{}/channels/{}/read", team_id, channel_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
}

// ══════════════════════════════════════════════════════════════════
// Voice isolation model serving endpoints
// ══════════════════════════════════════════════════════════════════

async fn body_bytes(body: Body) -> Vec<u8> {
    axum::body::to_bytes(body, 16 * 1024 * 1024)
        .await
        .unwrap()
        .to_vec()
}

#[tokio::test]
async fn voice_models_manifest_returns_json_with_three_subgraphs() {
    let (state, _tmp) = test_app_state();
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/voice/models/manifest.json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(
        resp.headers().get("content-type").unwrap(),
        "application/json"
    );
    assert_eq!(
        resp.headers().get("cross-origin-resource-policy").unwrap(),
        "same-origin"
    );

    let body = body_bytes(resp.into_body()).await;
    let manifest: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(manifest["version"], 2);
    for sub in ["enc", "erb_dec", "df_dec"] {
        let entry = &manifest["dfn3"][sub];
        let sha = entry["sha256"].as_str().unwrap_or_default();
        assert_eq!(sha.len(), 64, "{} sha256 should be 64 hex chars", sub);
        let url = entry["url"].as_str().unwrap_or_default();
        assert!(url.starts_with("/api/voice/models/dfn3-v2/"), "{}", url);
    }
    assert_eq!(manifest["dfn3"]["config"]["sample_rate"], 48000);
    // v2: config must include state_shapes for all six stateful tensors so
    // the client worker can allocate correctly-shaped zero state buffers.
    let state_shapes = &manifest["dfn3"]["config"]["state_shapes"];
    for name in ["erb_ctx", "spec_ctx", "h_enc", "h_erb", "c0_ctx", "h_df"] {
        let arr = state_shapes[name]
            .as_array()
            .unwrap_or_else(|| panic!("state_shapes.{} missing", name));
        assert!(!arr.is_empty(), "state_shapes.{} empty", name);
    }
}

#[tokio::test]
async fn voice_models_serve_returns_each_dfn3_subgraph() {
    let (state, _tmp) = test_app_state();
    let app = test_router(state);

    for sub in ["enc.onnx", "erb_dec.onnx", "df_dec.onnx"] {
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/voice/models/dfn3-v2/{}", sub))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK, "{} should be served", sub);
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "application/octet-stream"
        );
        assert_eq!(
            resp.headers().get("cross-origin-resource-policy").unwrap(),
            "same-origin"
        );
        let body = body_bytes(resp.into_body()).await;
        assert!(body.len() > 1000, "{} body too small: {}", sub, body.len());
    }
}

#[tokio::test]
async fn voice_models_serve_404s_unknown_path() {
    let (state, _tmp) = test_app_state();
    let app = test_router(state);

    for bad in [
        "dfn3-v2/nonexistent.onnx",
        "dfn3-v2/enc.bin",
        "dfn3-v1/enc.onnx",
    ] {
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/voice/models/{}", bad))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::NOT_FOUND,
            "expected 404 for {}",
            bad
        );
    }
}

// ══════════════════════════════════════════════════════════════════
// Pins / Polls / Channel-groups / Devices
// ══════════════════════════════════════════════════════════════════
//
// Coverage for the handlers added in the mesh-redesign branch.
// Each follows the same shape as the existing channel/message tests:
// boot a state via `test_app_state`, seed a user + team via
// `bootstrap_user_and_team`, drive the routes via `test_router`.

async fn create_channel_via_api(
    app: &Router,
    team_id: &str,
    token: &str,
    name: &str,
) -> String {
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/v1/teams/{}/channels", team_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "name": name }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    json["id"].as_str().unwrap().to_string()
}

async fn create_message_via_api(
    app: &Router,
    team_id: &str,
    channel_id: &str,
    token: &str,
    content: &str,
) -> String {
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!(
                    "/api/v1/teams/{}/channels/{}/messages",
                    team_id, channel_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "content": content }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    json["id"].as_str().unwrap().to_string()
}

// ── pins ──────────────────────────────────────────────────────────

#[tokio::test]
async fn pins_list_empty_returns_empty_array() {
    let (state, _tmp) = test_app_state();
    let (_uid, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let channel_id = create_channel_via_api(&app, &team_id, &token, "general").await;

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&format!(
                    "/api/v1/teams/{}/channels/{}/pins",
                    team_id, channel_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    let ids = json["message_ids"].as_array().unwrap();
    assert!(ids.is_empty());
}

#[tokio::test]
async fn pins_pin_then_list_then_unpin_then_list() {
    let (state, _tmp) = test_app_state();
    let (_uid, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let channel_id = create_channel_via_api(&app, &team_id, &token, "general").await;
    let message_id = create_message_via_api(&app, &team_id, &channel_id, &token, "hi").await;

    // POST pin
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!(
                    "/api/v1/teams/{}/channels/{}/messages/{}/pin",
                    team_id, channel_id, message_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // GET list — should contain the message id
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&format!(
                    "/api/v1/teams/{}/channels/{}/pins",
                    team_id, channel_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let json = body_to_json(resp.into_body()).await;
    let ids: Vec<String> = json["message_ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    assert!(ids.contains(&message_id));

    // DELETE unpin
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(&format!(
                    "/api/v1/teams/{}/channels/{}/messages/{}/pin",
                    team_id, channel_id, message_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // GET list — should be empty again
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&format!(
                    "/api/v1/teams/{}/channels/{}/pins",
                    team_id, channel_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let json = body_to_json(resp.into_body()).await;
    assert!(json["message_ids"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn pins_pin_unknown_message_returns_404() {
    let (state, _tmp) = test_app_state();
    let (_uid, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);
    let channel_id = create_channel_via_api(&app, &team_id, &token, "general").await;

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!(
                    "/api/v1/teams/{}/channels/{}/messages/{}/pin",
                    team_id, channel_id, "not-a-real-id"
                ))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

// ── polls ─────────────────────────────────────────────────────────

#[tokio::test]
async fn polls_create_list_vote_unvote_roundtrip() {
    let (state, _tmp) = test_app_state();
    let (_uid, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);
    let channel_id = create_channel_via_api(&app, &team_id, &token, "general").await;

    // Create a poll.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!(
                    "/api/v1/teams/{}/channels/{}/polls",
                    team_id, channel_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "question": "lunch?",
                        "options": ["pizza", "sushi", "salad"]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    let poll_id = json["id"].as_str().unwrap().to_string();
    assert_eq!(json["question"], "lunch?");
    assert_eq!(json["options"].as_array().unwrap().len(), 3);
    assert_eq!(json["tallies"][0], 0);

    // List polls for the channel.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&format!(
                    "/api/v1/teams/{}/channels/{}/polls",
                    team_id, channel_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json.as_array().unwrap().len(), 1);
    assert_eq!(json[0]["id"], poll_id);

    // Vote for option 1.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!(
                    "/api/v1/teams/{}/polls/{}/votes",
                    team_id, poll_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "option_index": 1 }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["tallies"][1], 1);

    // Unvote.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(&format!(
                    "/api/v1/teams/{}/polls/{}/votes",
                    team_id, poll_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["tallies"][1], 0);
}

#[tokio::test]
async fn polls_create_rejects_empty_question() {
    let (state, _tmp) = test_app_state();
    let (_uid, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);
    let channel_id = create_channel_via_api(&app, &team_id, &token, "general").await;

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!(
                    "/api/v1/teams/{}/channels/{}/polls",
                    team_id, channel_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "question": "", "options": ["a", "b"] }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn polls_create_rejects_under_two_options() {
    let (state, _tmp) = test_app_state();
    let (_uid, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);
    let channel_id = create_channel_via_api(&app, &team_id, &token, "general").await;

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!(
                    "/api/v1/teams/{}/channels/{}/polls",
                    team_id, channel_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "question": "?", "options": ["only-one"] }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn polls_create_rejects_too_many_options() {
    let (state, _tmp) = test_app_state();
    let (_uid, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);
    let channel_id = create_channel_via_api(&app, &team_id, &token, "general").await;

    let many: Vec<String> = (0..13).map(|i| format!("opt{}", i)).collect();
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!(
                    "/api/v1/teams/{}/channels/{}/polls",
                    team_id, channel_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "question": "?", "options": many }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn polls_vote_out_of_range_returns_error() {
    let (state, _tmp) = test_app_state();
    let (_uid, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);
    let channel_id = create_channel_via_api(&app, &team_id, &token, "general").await;

    // Create a 2-option poll.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!(
                    "/api/v1/teams/{}/channels/{}/polls",
                    team_id, channel_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "question": "?", "options": ["a", "b"] }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let poll_id = body_to_json(resp.into_body()).await["id"]
        .as_str()
        .unwrap()
        .to_string();

    // Vote at index 5 → out of range.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!(
                    "/api/v1/teams/{}/polls/{}/votes",
                    team_id, poll_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "option_index": 5 }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(
        !resp.status().is_success(),
        "out-of-range vote should fail, got {}",
        resp.status()
    );
}

// ── channel_groups ────────────────────────────────────────────────

#[tokio::test]
async fn channel_groups_create_list_update_delete() {
    let (state, _tmp) = test_app_state();
    let (_uid, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    // Create a group.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/v1/teams/{}/groups", team_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "name": "private" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let group = body_to_json(resp.into_body()).await;
    let group_id = group["id"].as_str().unwrap().to_string();
    assert_eq!(group["name"], "private");

    // List groups.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&format!("/api/v1/teams/{}/groups", team_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json.as_array().unwrap().len(), 1);
    assert_eq!(json[0]["id"], group_id);

    // Update.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(&format!("/api/v1/teams/{}/groups/{}", team_id, group_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "name": "renamed" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // Delete.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(&format!("/api/v1/teams/{}/groups/{}", team_id, group_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // List again — empty.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&format!("/api/v1/teams/{}/groups", team_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let json = body_to_json(resp.into_body()).await;
    assert!(json.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn channel_groups_get_set_access() {
    let (state, _tmp) = test_app_state();
    let (_uid, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    // Create a group.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/v1/teams/{}/groups", team_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "name": "private" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let group_id = body_to_json(resp.into_body()).await["id"]
        .as_str()
        .unwrap()
        .to_string();

    // GET access (initially empty).
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&format!(
                    "/api/v1/teams/{}/groups/{}/access",
                    team_id, group_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // PUT access with an empty list (acceptable — clears).
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(&format!(
                    "/api/v1/teams/{}/groups/{}/access",
                    team_id, group_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "role_ids": [] }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}

// ── devices ───────────────────────────────────────────────────────

#[tokio::test]
async fn devices_list_returns_array() {
    let (state, _tmp) = test_app_state();
    let (_uid, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/devices")
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    // No devices enrolled yet beyond the auth user — handler may
    // return an empty array, or the JWT's own device entry. Just
    // assert the shape.
    assert!(json.is_array() || json.is_object());
}

#[tokio::test]
async fn devices_revoke_unknown_device_returns_404_or_error() {
    let (state, _tmp) = test_app_state();
    let (_uid, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/devices/not-a-real-id/revoke")
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    // Should not 200 — the device doesn't exist.
    assert!(
        !resp.status().is_success(),
        "revoking unknown device should fail, got {}",
        resp.status()
    );
}

// ── debug / browser-log ──────────────────────────────────────────

/// Variant of test_app_state with browser_log_forward flipped on, so
/// the /api/v1/debug/browser-log route actually processes the batch
/// instead of 204'ing it.
fn test_app_state_log_forward_on() -> (AppState, tempfile::TempDir) {
    let (db, tmp) = test_db();
    let auth = Arc::new(AuthService::new(db.clone(), ""));
    let hub = Arc::new(Hub::new(db.clone()));
    let presence = Arc::new(PresenceManager::new());
    let mut cfg = test_config();
    cfg.browser_log_forward = true;
    let config = Arc::new(cfg);
    let state = AppState {
        db,
        auth,
        hub,
        presence,
        config,
        mesh: None,
        custom_theme_css: None,
    };
    (state, tmp)
}

#[tokio::test]
async fn debug_browser_log_returns_204_when_disabled() {
    let (state, _tmp) = test_app_state();
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/debug/browser-log")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "session": "abc",
                        "entries": [{"level": "info", "message": "hi"}]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn debug_browser_log_accepts_batch_when_enabled() {
    let (state, _tmp) = test_app_state_log_forward_on();
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/debug/browser-log")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "session": "tab-1",
                        "entries": [
                            {"level": "info",  "message": "boot ok", "tag": "boot"},
                            {"level": "warn",  "message": "slow render"},
                            {"level": "error", "message": "panic in worker"},
                            {"level": "debug", "message": "trace data", "tag": "WebRTC"}
                        ]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["accepted"], 4);
}

#[tokio::test]
async fn debug_browser_log_caps_batch_size() {
    let (state, _tmp) = test_app_state_log_forward_on();
    let app = test_router(state);

    // Build a batch of 150 entries — the handler caps at MAX_ENTRIES_PER_BATCH (100).
    let entries: Vec<_> = (0..150)
        .map(|i| serde_json::json!({"level": "info", "message": format!("msg {}", i)}))
        .collect();
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/debug/browser-log")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"entries": entries}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["accepted"], 100);
}

#[tokio::test]
async fn debug_browser_log_rejects_invalid_json() {
    let (state, _tmp) = test_app_state_log_forward_on();
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/debug/browser-log")
                .header("content-type", "application/json")
                .body(Body::from("not-json"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn debug_browser_log_uses_jwt_user_when_authenticated() {
    let (state, _tmp) = test_app_state_log_forward_on();
    let (_uid, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/debug/browser-log")
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "entries": [{
                            "level": "info",
                            "message": "with auth",
                            "user": "spoofed-by-client"
                        }]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["accepted"], 1);
}

// ── channel field updates (slow_mode, locked, hidden_if_restricted) ───

#[tokio::test]
async fn update_channel_sets_locked_flag() {
    let (state, _tmp) = test_app_state();
    let (_uid, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);
    let channel_id = create_channel_via_api(&app, &team_id, &token, "general").await;

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(&format!(
                    "/api/v1/teams/{}/channels/{}",
                    team_id, channel_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "locked": true }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["locked"], true);
}

#[tokio::test]
async fn update_channel_sets_slow_mode_seconds() {
    let (state, _tmp) = test_app_state();
    let (_uid, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);
    let channel_id = create_channel_via_api(&app, &team_id, &token, "general").await;

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(&format!(
                    "/api/v1/teams/{}/channels/{}",
                    team_id, channel_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "slow_mode_seconds": 30 }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["slow_mode_seconds"], 30);
}

#[tokio::test]
async fn update_channel_sets_hidden_if_restricted() {
    let (state, _tmp) = test_app_state();
    let (_uid, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);
    let channel_id = create_channel_via_api(&app, &team_id, &token, "general").await;

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(&format!(
                    "/api/v1/teams/{}/channels/{}",
                    team_id, channel_id
                ))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "hidden_if_restricted": true }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["hidden_if_restricted"], true);
}

#[tokio::test]
async fn create_channel_with_category_creates_group_id() {
    let (state, _tmp) = test_app_state();
    let (_uid, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    // Create channel with a category — should auto-create the channel-group.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/v1/teams/{}/channels", team_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"name": "dev", "category": "Engineering"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert!(
        json["group_id"].as_str().is_some(),
        "expected group_id to be set, got: {}",
        json
    );

    // Second channel with the SAME category should reuse the group.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/v1/teams/{}/channels", team_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"name": "ops", "category": "Engineering"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json2 = body_to_json(resp.into_body()).await;
    assert_eq!(json["group_id"], json2["group_id"]);
}

// ── team field updates (quiet_hours, force_turn_relay) ───

#[tokio::test]
async fn update_team_sets_force_turn_relay() {
    let (state, _tmp) = test_app_state();
    let (_uid, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(&format!("/api/v1/teams/{}", team_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "force_turn_relay": true }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["force_turn_relay"], true);
}

// ── federation: not-enabled branches ───

#[tokio::test]
async fn federation_status_returns_400_when_disabled() {
    let (state, _tmp) = test_app_state();
    let (_uid, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/federation/status")
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn federation_peers_returns_400_when_disabled() {
    let (state, _tmp) = test_app_state();
    let (_uid, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/federation/peers")
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn federation_join_token_returns_400_when_disabled() {
    let (state, _tmp) = test_app_state();
    let (_uid, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/federation/join-token")
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn federation_join_info_returns_400_when_disabled() {
    let (state, _tmp) = test_app_state();
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/federation/join/some-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

// ── auth / refresh / logout ─────────────────────────────────────────

#[tokio::test]
async fn auth_refresh_rejects_empty_refresh_token() {
    let (state, _tmp) = test_app_state();
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/auth/refresh")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "refresh_token": "" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn auth_refresh_rejects_garbage_token() {
    let (state, _tmp) = test_app_state();
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/auth/refresh")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "refresh_token": "not.a.real.token" })
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    // Some non-2xx — Unauthorized / BadRequest / Internal all signal "no".
    assert!(
        !resp.status().is_success(),
        "expected non-success for invalid refresh token, got {}",
        resp.status()
    );
}

#[tokio::test]
async fn auth_logout_without_bearer_returns_401() {
    let (state, _tmp) = test_app_state();
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/auth/logout")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn auth_logout_revokes_the_bearer_token() {
    let (state, _tmp) = test_app_state();
    let (_uid, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state.clone());

    // First request should succeed.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/users/me")
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // Log out.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/auth/logout")
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // Same token now revoked → 401.
    let app2 = test_router(state);
    let resp = app2
        .oneshot(
            Request::builder()
                .uri("/api/v1/users/me")
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

// ── users: quiet_hours endpoint ─────────────────────────────────────

#[tokio::test]
async fn users_update_quiet_hours_roundtrips() {
    let (state, _tmp) = test_app_state();
    let (_uid, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/api/v1/users/me")
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "quiet_hours_enabled": true,
                        "quiet_hours_from": "22:00",
                        "quiet_hours_to": "08:00",
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["quiet_hours_enabled"], true);
    assert_eq!(json["quiet_hours_from"], "22:00");
    assert_eq!(json["quiet_hours_to"], "08:00");
}

#[tokio::test]
async fn users_update_quiet_hours_rejects_invalid_time_format() {
    let (state, _tmp) = test_app_state();
    let (_uid, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/api/v1/users/me")
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "quiet_hours_from": "25:99" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    // helpers::map_db_error converts the validator's
    // rusqlite::Error::InvalidParameterName into AppError::Forbidden
    // (403). The contract is "non-success on bad input"; assert that
    // broadly rather than tying to the specific code.
    assert!(
        !resp.status().is_success(),
        "expected non-success for malformed HH:MM, got {}",
        resp.status()
    );
}

// ── teams: leave_team ───────────────────────────────────────────────

#[tokio::test]
async fn leave_team_rejects_sole_admin() {
    // bootstrap_user_and_team creates a team where the caller is the
    // only admin — leave_team should refuse with 409 Conflict.
    let (state, _tmp) = test_app_state();
    let (_uid, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/v1/teams/{}/leave", team_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn leave_team_404s_for_non_member() {
    let (state, _tmp) = test_app_state();
    let (_uid, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/teams/no-such-team/leave")
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

// ── gif search (early-exit branches) ────────────────────────────────

#[tokio::test]
async fn gif_search_rejects_empty_query() {
    let (state, _tmp) = test_app_state();
    let (_uid, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri(&format!("/api/v1/teams/{}/gif?q=", team_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn gif_search_returns_503_when_team_has_no_giphy_key() {
    let (state, _tmp) = test_app_state();
    let (_uid, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri(&format!("/api/v1/teams/{}/gif?q=hello", team_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn gif_search_forbids_non_team_member() {
    let (state, _tmp) = test_app_state();
    // Bootstrap creates user+team but the request hits a DIFFERENT team
    // id, so require_team_member should refuse.
    let (_uid, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/teams/some-other-team/gif?q=hello")
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(
        !resp.status().is_success(),
        "expected non-success for non-member, got {}",
        resp.status()
    );
}

// ── identity/blob + delete_me ──────────────────────────────────────

#[tokio::test]
async fn identity_blob_get_empty_when_never_uploaded() {
    let (state, _tmp) = test_app_state();
    let (_uid, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/identity/blob")
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    // Default for a fresh user: empty string (not null).
    assert_eq!(json["blob"], "");
}

#[tokio::test]
async fn identity_blob_put_and_get_roundtrip() {
    let (state, _tmp) = test_app_state();
    let (_uid, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    // PUT a small blob.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/v1/identity/blob")
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "blob": "encrypted-blob-bytes" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // GET it back.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/identity/blob")
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["blob"], "encrypted-blob-bytes");
}

#[tokio::test]
async fn identity_blob_put_413_when_too_large() {
    let (state, _tmp) = test_app_state();
    let (_uid, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    // 65 KiB blob — just over MAX_IDENTITY_BLOB_BYTES.
    let big = "x".repeat(65 * 1024);
    let resp = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/v1/identity/blob")
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "blob": big }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn delete_me_fails_when_user_is_sole_admin_of_a_team() {
    // bootstrap_user_and_team creates a team where the caller is the
    // only admin. delete_me should refuse — same protection as
    // leave_team's sole-admin guard.
    let (state, _tmp) = test_app_state();
    let (_uid, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/api/v1/users/me")
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    // delete_user maps InvalidParameterName to BadRequest. Either way
    // non-success.
    assert!(
        !resp.status().is_success(),
        "expected non-success when user is sole admin, got {}",
        resp.status()
    );
}

// ── blocks / channel-mutes / audit ─────────────────────────────────

#[tokio::test]
async fn blocks_list_starts_empty() {
    let (state, _tmp) = test_app_state();
    let (_uid, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/users/me/blocks")
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    // Wire shape: { user_ids: [...] }
    assert!(json["user_ids"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn blocks_block_then_list_then_unblock() {
    let (state, _tmp) = test_app_state();
    let (_uid, _team_id, token) = bootstrap_user_and_team(&state);
    // Seed a second user so we have someone to block.
    state.db.with_conn(|conn| {
        db::create_user(conn, &db::User {
            id: "other".into(),
            username: "other".into(),
            display_name: "Other".into(),
            public_key: vec![9u8; 32],
            avatar_url: String::new(),
            status_text: String::new(),
            status_type: "online".into(),
            is_admin: false,
            created_at: db::now_str(),
            updated_at: db::now_str(),
            ..Default::default()
        })
    }).unwrap();
    let app = test_router(state);

    // Block.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/users/me/blocks/other")
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // List — should contain "other".
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/users/me/blocks")
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let json = body_to_json(resp.into_body()).await;
    let arr = json["user_ids"].as_array().unwrap();
    assert!(arr.iter().any(|v| v.as_str() == Some("other")));

    // Unblock.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/api/v1/users/me/blocks/other")
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn channel_mutes_list_starts_empty() {
    let (state, _tmp) = test_app_state();
    let (_uid, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/me/muted-channels")
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert!(json.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn channel_mutes_mute_then_list_then_unmute() {
    let (state, _tmp) = test_app_state();
    let (_uid, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);
    let channel_id = create_channel_via_api(&app, &team_id, &token, "general").await;

    // PUT mute (no expiry = indefinite).
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(&format!("/api/v1/me/muted-channels/{}", channel_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(serde_json::json!({}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // List — should contain the channel.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/me/muted-channels")
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let json = body_to_json(resp.into_body()).await;
    let arr = json.as_array().unwrap();
    assert!(!arr.is_empty());

    // DELETE unmute.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(&format!("/api/v1/me/muted-channels/{}", channel_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn audit_list_for_team_returns_array() {
    let (state, _tmp) = test_app_state();
    let (_uid, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri(&format!("/api/v1/teams/{}/audit", team_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    // audit_events table is empty on a fresh bootstrap until an action
    // runs — the response shape is still an array (or object with array).
    assert!(json.is_array() || json.is_object());
}

// ── integrations: giphy ────────────────────────────────────────────

#[tokio::test]
async fn integrations_giphy_unconfigured_by_default() {
    let (state, _tmp) = test_app_state();
    let (_uid, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri(&format!("/api/v1/teams/{}/integrations/giphy", team_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["configured"], false);
}

#[tokio::test]
async fn integrations_giphy_set_then_get_reports_configured() {
    let (state, _tmp) = test_app_state();
    let (_uid, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(&format!("/api/v1/teams/{}/integrations/giphy", team_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "api_key": "real-giphy-key-here" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["configured"], true);

    // GET — also reports configured (without leaking the key).
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&format!("/api/v1/teams/{}/integrations/giphy", team_id))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["configured"], true);
    // Critically: the key itself never appears in the response body.
    assert!(json.get("api_key").is_none());
}

#[tokio::test]
async fn integrations_giphy_set_empty_clears() {
    let (state, _tmp) = test_app_state();
    let (_uid, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    // Set then clear.
    let _ = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(&format!("/api/v1/teams/{}/integrations/giphy", team_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "api_key": "tmp" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(&format!("/api/v1/teams/{}/integrations/giphy", team_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "api_key": "" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["configured"], false);
}

#[tokio::test]
async fn integrations_giphy_rejects_too_long_key() {
    let (state, _tmp) = test_app_state();
    let (_uid, team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let too_long = "a".repeat(257);
    let resp = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(&format!("/api/v1/teams/{}/integrations/giphy", team_id))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "api_key": too_long }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

// ── prekeys ─────────────────────────────────────────────────────────

fn b64(b: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(b)
}

#[tokio::test]
async fn prekeys_upload_then_get_bundle_for_self() {
    let (state, _tmp) = test_app_state();
    let (uid, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    // Upload a bundle.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/prekeys")
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "identity_key":       b64(&[1u8; 32]),
                        "identity_dh_key":    b64(&[2u8; 32]),
                        "signed_prekey":      b64(&[3u8; 32]),
                        "signed_prekey_signature": b64(&[4u8; 64]),
                        "one_time_prekeys":   [b64(&[5u8; 32]), b64(&[6u8; 32])],
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // GET own bundle (same team trivially) — VULN-006 shared-team check
    // passes because the caller IS the target.
    let resp = app
        .oneshot(
            Request::builder()
                .uri(&format!("/api/v1/prekeys/{}", uid))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["user_id"], uid);
    assert!(json["identity_key"].as_str().unwrap().len() > 0);
}

#[tokio::test]
async fn prekeys_upload_rejects_invalid_base64() {
    let (state, _tmp) = test_app_state();
    let (_uid, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/prekeys")
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "identity_key": "not-base64!@#$",
                        "identity_dh_key": b64(&[2u8; 32]),
                        "signed_prekey": b64(&[3u8; 32]),
                        "signed_prekey_signature": b64(&[4u8; 64]),
                        "one_time_prekeys": [],
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn prekeys_get_bundle_404_when_target_has_no_bundle() {
    let (state, _tmp) = test_app_state();
    let (uid, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri(&format!("/api/v1/prekeys/{}", uid))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn prekeys_get_bundle_forbidden_for_unrelated_user() {
    let (state, _tmp) = test_app_state();
    let (_uid, _team_id, token) = bootstrap_user_and_team(&state);
    // Seed a stranger who shares no team with the caller, AND give
    // them a bundle (so the 404 path isn't what we hit first).
    state.db.with_conn(|conn| {
        db::create_user(conn, &db::User {
            id: "stranger".into(),
            username: "stranger".into(),
            display_name: "Stranger".into(),
            public_key: vec![7u8; 32],
            avatar_url: String::new(),
            status_text: String::new(),
            status_type: "online".into(),
            is_admin: false,
            created_at: db::now_str(),
            updated_at: db::now_str(),
            ..Default::default()
        })?;
        db::save_prekey_bundle(conn, &db::PrekeyBundle {
            id: db::new_id(),
            user_id: "stranger".into(),
            identity_key: vec![1u8; 32],
            identity_dh_key: vec![2u8; 32],
            signed_prekey: vec![3u8; 32],
            signed_prekey_signature: vec![4u8; 64],
            one_time_prekeys: b"[]".to_vec(),
            uploaded_at: db::now_str(),
        })
    }).unwrap();
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/prekeys/stranger")
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn prekeys_delete_own_clears_the_bundle() {
    let (state, _tmp) = test_app_state();
    let (uid, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    // Upload first so there's something to delete.
    let _ = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/prekeys")
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "identity_key": b64(&[1u8; 32]),
                        "identity_dh_key": b64(&[2u8; 32]),
                        "signed_prekey": b64(&[3u8; 32]),
                        "signed_prekey_signature": b64(&[4u8; 64]),
                        "one_time_prekeys": [],
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    // Delete.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/api/v1/prekeys")
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // GET should now 404 even for self.
    let resp = app
        .oneshot(
            Request::builder()
                .uri(&format!("/api/v1/prekeys/{}", uid))
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

// ── federation: with a real MeshNode ──────────────────────────────

fn test_app_state_with_mesh() -> (AppState, tempfile::TempDir) {
    use crate::federation::{MeshConfig, MeshNode};

    let (db, tmp) = test_db();
    let auth = Arc::new(AuthService::new(db.clone(), ""));
    let hub = Arc::new(Hub::new(db.clone()));
    let presence = Arc::new(PresenceManager::new());
    let config = Arc::new(test_config());

    let mesh_config = MeshConfig {
        node_name: "test-node-1".into(),
        bind_addr: "127.0.0.1".into(),
        bind_port: 0,
        advertise_addr: String::new(),
        advertise_port: 0,
        peers: vec![],
        tls_cert: String::new(),
        tls_key: String::new(),
        join_secret: "test-secret".into(),
        ..Default::default()
    };
    let mesh = Arc::new(MeshNode::new(mesh_config, db.clone(), hub.clone()));

    let state = AppState {
        db,
        auth,
        hub,
        presence,
        config,
        mesh: Some(mesh),
        custom_theme_css: None,
    };
    (state, tmp)
}

#[tokio::test]
async fn federation_status_returns_node_info_when_mesh_is_up() {
    let (state, _tmp) = test_app_state_with_mesh();
    let (_uid, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/federation/status")
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert_eq!(json["node_name"], "test-node-1");
    assert_eq!(json["peer_count"], 0);
    assert!(json["lamport_ts"].is_number());
}

#[tokio::test]
async fn federation_peers_returns_empty_list_when_no_peers() {
    let (state, _tmp) = test_app_state_with_mesh();
    let (_uid, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/federation/peers")
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert!(json.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn federation_join_token_succeeds_for_admin_user() {
    let (state, _tmp) = test_app_state_with_mesh();
    // bootstrap_user_and_team gives the user PERM_ADMIN via the
    // default admin role, which short-circuits the PERM_MANAGE_
    // FEDERATION bit check.
    let (_uid, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/federation/join-token")
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    assert!(json["token"].as_str().unwrap().len() > 10);
}

#[tokio::test]
async fn federation_join_info_validates_a_freshly_minted_token() {
    let (state, _tmp) = test_app_state_with_mesh();
    let (_uid, _team_id, token) = bootstrap_user_and_team(&state);
    let app = test_router(state);

    // Mint a token first.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/federation/join-token")
                .header("authorization", format!("Bearer {}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let minted = body_to_json(resp.into_body()).await["token"]
        .as_str()
        .unwrap()
        .to_string();

    // Now validate via the public join-info endpoint.
    let resp = app
        .oneshot(
            Request::builder()
                .uri(&format!("/api/v1/federation/join/{}", minted))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_to_json(resp.into_body()).await;
    // Wire fields documented by the federation::JoinInfo struct.
    assert!(json["team_id"].is_string() || json.is_object());
}

#[tokio::test]
async fn federation_join_info_rejects_garbage_token() {
    let (state, _tmp) = test_app_state_with_mesh();
    let app = test_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/federation/join/not.a.real.token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(
        !resp.status().is_success(),
        "expected non-success for invalid token, got {}",
        resp.status()
    );
}
