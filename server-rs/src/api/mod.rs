pub mod auth_handlers;
pub mod users;
pub mod teams;
pub mod channels;
pub mod messages;
pub mod roles;
pub mod invites;
pub mod dms;
pub mod threads;
pub mod reactions;
pub mod uploads;
pub mod prekeys;
pub mod presence;
pub mod voice;
pub mod federation;

use crate::auth::{self, AuthService};
use crate::config::Config;
use crate::db::Database;
use crate::federation::MeshNode;
use crate::presence::PresenceManager;
use crate::ws::Hub;
use axum::{
    extract::Extension,
    middleware,
    routing::{delete, get, patch, post, put},
    Json, Router,
};
use std::sync::{Arc, OnceLock};
use tower_http::cors::{Any, CorsLayer};

pub static VERSION: OnceLock<String> = OnceLock::new();

#[derive(Clone)]
pub struct AppState {
    pub db: Database,
    pub auth: Arc<AuthService>,
    pub hub: Arc<Hub>,
    pub presence: Arc<PresenceManager>,
    pub config: Arc<Config>,
    pub mesh: Option<Arc<MeshNode>>,
}

pub fn create_router(state: AppState) -> Router {
    let cors = if state.config.allowed_origins.is_empty() {
        CorsLayer::very_permissive()
    } else {
        let origins: Vec<_> = state
            .config
            .allowed_origins
            .iter()
            .filter_map(|o| o.parse().ok())
            .collect();
        CorsLayer::new()
            .allow_origin(origins)
            .allow_methods(Any)
            .allow_headers(Any)
    };

    // Public routes (no auth required).
    let public = Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/version", get(version))
        .route("/api/v1/config", get(get_config))
        .route("/api/v1/auth/challenge", post(auth_handlers::challenge))
        .route("/api/v1/auth/verify", post(auth_handlers::verify))
        .route("/api/v1/auth/register", post(auth_handlers::register))
        .route("/api/v1/auth/bootstrap", post(auth_handlers::bootstrap))
        .route(
            "/api/v1/invites/:token/info",
            get(invites::get_invite_info),
        )
        .route(
            "/api/v1/federation/join/:token",
            get(federation::get_join_info),
        );

    // Protected routes (auth required).
    let protected = Router::new()
        // Users
        .route("/api/v1/users/me", get(users::get_me).patch(users::update_me))
        // Identity blob
        .route(
            "/api/v1/identity/blob",
            get(users::get_identity_blob).put(users::put_identity_blob),
        )
        // Prekeys
        .route(
            "/api/v1/prekeys",
            post(prekeys::upload).delete(prekeys::delete_own),
        )
        .route("/api/v1/prekeys/:user_id", get(prekeys::get_bundle))
        // Teams
        .route("/api/v1/teams", get(teams::list).post(teams::create))
        .route(
            "/api/v1/teams/:team_id",
            get(teams::get_team).patch(teams::update),
        )
        // Members
        .route(
            "/api/v1/teams/:team_id/members",
            get(teams::list_members),
        )
        .route(
            "/api/v1/teams/:team_id/members/:user_id",
            patch(teams::update_member).delete(teams::kick_member),
        )
        .route(
            "/api/v1/teams/:team_id/members/:user_id/ban",
            post(teams::ban_member).delete(teams::unban_member),
        )
        // Channels
        .route(
            "/api/v1/teams/:team_id/channels",
            get(channels::list).post(channels::create),
        )
        .route(
            "/api/v1/teams/:team_id/channels/:channel_id",
            get(channels::get_channel)
                .patch(channels::update)
                .delete(channels::delete_channel),
        )
        // Messages
        .route(
            "/api/v1/teams/:team_id/channels/:channel_id/messages",
            get(messages::list).post(messages::create),
        )
        .route(
            "/api/v1/teams/:team_id/channels/:channel_id/messages/:message_id",
            patch(messages::edit).delete(messages::delete_msg),
        )
        // Roles
        .route(
            "/api/v1/teams/:team_id/roles",
            get(roles::list).post(roles::create),
        )
        .route(
            "/api/v1/teams/:team_id/roles/reorder",
            put(roles::reorder),
        )
        .route(
            "/api/v1/teams/:team_id/roles/:role_id",
            patch(roles::update).delete(roles::delete_role),
        )
        // Invites
        .route(
            "/api/v1/teams/:team_id/invites",
            get(invites::list).post(invites::create),
        )
        .route(
            "/api/v1/teams/:team_id/invites/:invite_id",
            delete(invites::revoke),
        )
        // DMs
        .route(
            "/api/v1/teams/:team_id/dms",
            get(dms::list).post(dms::create_or_get),
        )
        .route("/api/v1/teams/:team_id/dms/:dm_id", get(dms::get_dm))
        .route(
            "/api/v1/teams/:team_id/dms/:dm_id/messages",
            get(dms::list_messages).post(dms::send_message),
        )
        .route(
            "/api/v1/teams/:team_id/dms/:dm_id/messages/:message_id",
            put(dms::edit_message).delete(dms::delete_message),
        )
        .route(
            "/api/v1/teams/:team_id/dms/:dm_id/members",
            post(dms::add_members),
        )
        .route(
            "/api/v1/teams/:team_id/dms/:dm_id/members/:user_id",
            delete(dms::remove_member),
        )
        // Threads
        .route(
            "/api/v1/teams/:team_id/channels/:channel_id/threads",
            get(threads::list).post(threads::create),
        )
        .route(
            "/api/v1/teams/:team_id/threads/:thread_id",
            get(threads::get_thread)
                .put(threads::update)
                .delete(threads::delete_thread),
        )
        .route(
            "/api/v1/teams/:team_id/threads/:thread_id/messages",
            get(threads::list_messages).post(threads::create_message),
        )
        // Reactions
        .route(
            "/api/v1/teams/:team_id/channels/:channel_id/messages/:message_id/reactions/:emoji",
            put(reactions::add).delete(reactions::remove),
        )
        .route(
            "/api/v1/teams/:team_id/channels/:channel_id/messages/:message_id/reactions",
            get(reactions::list),
        )
        // Uploads
        .route(
            "/api/v1/teams/:team_id/upload",
            post(uploads::upload),
        )
        .route(
            "/api/v1/teams/:team_id/attachments/:attachment_id",
            get(uploads::download).delete(uploads::delete_attachment),
        )
        // Presence
        .route(
            "/api/v1/teams/:team_id/presence",
            get(presence::get_all).put(presence::update_own),
        )
        .route(
            "/api/v1/teams/:team_id/presence/:user_id",
            get(presence::get_user),
        )
        // Voice
        .route(
            "/api/v1/teams/:team_id/voice/:channel_id",
            get(voice::get_room),
        )
        // Federation
        .route(
            "/api/v1/federation/status",
            get(federation::get_status),
        )
        .route(
            "/api/v1/federation/peers",
            get(federation::get_peers),
        )
        .route(
            "/api/v1/federation/join-token",
            post(federation::create_join_token),
        )
        // WebSocket
        .route("/ws", get(ws_handler))
        .layer(middleware::from_fn(auth::auth_middleware));

    Router::new()
        .merge(public)
        .merge(protected)
        .layer(Extension(state.auth.clone()))
        .layer(cors)
        .with_state(state)
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
    }))
}

async fn version() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "version": VERSION.get().map(|s| s.as_str()).unwrap_or("dev"),
        "runtime": "rust",
    }))
}

async fn get_config(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "domain": state.config.domain,
        "rp_id": state.config.domain,
    }))
}

async fn ws_handler(
    ws: axum::extract::WebSocketUpgrade,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
    Extension(auth_svc): Extension<Arc<AuthService>>,
    axum::extract::State(state): axum::extract::State<AppState>,
) -> impl axum::response::IntoResponse {
    let token = params.get("token").cloned().unwrap_or_default();
    let team_id = params.get("team").cloned().unwrap_or_default();

    let user_id = match auth_svc.validate_jwt(&token) {
        Ok(uid) => uid,
        Err(_) => {
            return axum::response::Response::builder()
                .status(401)
                .body(axum::body::Body::from("invalid token"))
                .unwrap()
                .into_response();
        }
    };

    // Look up username.
    let db = state.db.clone();
    let uid_clone = user_id.clone();
    let username = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            crate::db::get_user_by_id(conn, &uid_clone)
                .map(|u| u.map(|u| u.username).unwrap_or_default())
        })
    })
    .await
    .unwrap()
    .unwrap_or_default();

    let hub = state.hub.clone();
    ws.on_upgrade(move |socket| {
        crate::ws::client::handle_ws_connection(socket, hub, user_id, username, team_id)
    })
    .into_response()
}

use axum::response::IntoResponse;

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use crate::config::Config;
    use crate::db::{self, Database};
    use crate::presence::PresenceManager;
    use ed25519_dalek::{Signer, SigningKey};
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

        let signing_key = SigningKey::generate(&mut rand::thread_rng());
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

        let signing_key = SigningKey::generate(&mut rand::thread_rng());
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

        let signing_key = SigningKey::generate(&mut rand::thread_rng());
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

        let signing_key = SigningKey::generate(&mut rand::thread_rng());
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
}
