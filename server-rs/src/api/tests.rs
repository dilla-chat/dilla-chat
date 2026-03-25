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
        otel_enabled: false,
        otel_protocol: "http".into(),
        otel_endpoint: "localhost:4317".into(),
        otel_http_endpoint: String::new(),
        otel_insecure: false,
        otel_service_name: "test".into(),
        otel_api_key: String::new(),
        otel_api_header: String::new(),
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
        })?;
        db::create_team(conn, &db::Team {
            id: team_id.clone(),
            name: "Test Team".into(),
            description: String::new(),
            icon_url: String::new(),
            created_by: user_id.clone(),
            max_file_size: 25 * 1024 * 1024,
            allow_member_invites: true,
            created_at: now.clone(),
            updated_at: now.clone(),
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
        .route("/api/v1/auth/challenge", post(super::auth_handlers::challenge))
        .route("/api/v1/auth/verify", post(super::auth_handlers::verify))
        .route("/api/v1/auth/register", post(super::auth_handlers::register))
        .route("/api/v1/auth/bootstrap", post(super::auth_handlers::bootstrap))
        .route("/api/v1/invites/{token}/info", get(super::invites::get_invite_info))
        .route("/api/v1/federation/join/{token}", get(super::federation::get_join_info));

    let protected = Router::new()
        .route("/api/v1/users/me", get(super::users::get_me).patch(super::users::update_me))
        .route("/api/v1/teams", get(super::teams::list).post(super::teams::create))
        .route("/api/v1/teams/{team_id}", get(super::teams::get_team).patch(super::teams::update))
        .route("/api/v1/teams/{team_id}/members", get(super::teams::list_members))
        .route("/api/v1/teams/{team_id}/members/{user_id}", patch(super::teams::update_member).delete(super::teams::kick_member))
        .route("/api/v1/teams/{team_id}/members/{user_id}/ban", post(super::teams::ban_member).delete(super::teams::unban_member))
        .route("/api/v1/teams/{team_id}/channels", get(super::channels::list).post(super::channels::create))
        .route("/api/v1/teams/{team_id}/channels/{channel_id}", get(super::channels::get_channel).patch(super::channels::update).delete(super::channels::delete_channel))
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
        .route("/api/v1/federation/status", get(super::federation::get_status))
        .route("/api/v1/federation/peers", get(super::federation::get_peers))
        .route("/api/v1/federation/join-token", post(super::federation::create_join_token))
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
    assert!(json["channel"].is_object());
    assert!(json["members"].is_array());
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
    let req = Request::builder()
        .uri("/api/v1/users/me")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();

    assert_eq!(
        resp.status(),
        StatusCode::UNAUTHORIZED,
        "protected API routes should require auth"
    );
}
