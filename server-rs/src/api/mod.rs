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
pub mod helpers;
pub mod outbound;
pub mod theme;
pub mod debug;
pub mod audit;
pub mod polls;
pub mod channel_mutes;
pub mod channel_groups;
pub mod gif;
pub mod integrations;
pub mod pins;
pub mod blocks;
pub mod devices;

use crate::auth::{self, AuthService};
use crate::config::Config;
use crate::db::Database;
use crate::federation::MeshNode;
use crate::presence::PresenceManager;
use crate::ws::Hub;
use axum::{
    extract::Extension,
    http::HeaderValue,
    middleware,
    routing::{delete, get, patch, post, put},
    Json, Router,
};
use std::sync::{Arc, OnceLock};
use tower_governor::{governor::GovernorConfigBuilder, key_extractor::SmartIpKeyExtractor, GovernorLayer};
use tower_http::cors::{Any, CorsLayer};
use tower_http::set_header::SetResponseHeaderLayer;

pub static VERSION: OnceLock<String> = OnceLock::new();

#[derive(Clone)]
pub struct AppState {
    pub db: Database,
    pub auth: Arc<AuthService>,
    pub hub: Arc<Hub>,
    pub presence: Arc<PresenceManager>,
    pub config: Arc<Config>,
    pub mesh: Option<Arc<MeshNode>>,
    pub custom_theme_css: Option<String>,
}

#[cfg(not(tarpaulin_include))]
pub fn create_router(state: AppState) -> Router {
    // Rate limiter for auth endpoints: 10 requests per 6-second window per IP.
    // SmartIpKeyExtractor checks X-Forwarded-For, X-Real-IP, Forwarded
    // headers before falling back to peer IP (solves NEW-10 trusted_proxies).
    let auth_rate_config = Arc::new(
        GovernorConfigBuilder::default()
            .per_second(6)
            .burst_size(10)
            .key_extractor(SmartIpKeyExtractor)
            .finish()
            .unwrap(),
    );

    let auth_rate_limiter = auth_rate_config.limiter().clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
        auth_rate_limiter.retain_recent();
    });

    // VULN-011 / H1: per-IP rate limiter for the *protected* router.
    // Auth routes have a strict 10/burst at 6/s; this one is the
    // backstop for everything behind auth_middleware. Defaults are
    // intentionally permissive (chat traffic spikes) and tunable via
    // DILLA_RATELIMIT_BURST / DILLA_RATELIMIT_PER_SECOND.
    let protected_rate_config = Arc::new(
        GovernorConfigBuilder::default()
            .per_second(state.config.ratelimit_per_second.max(1))
            .burst_size(state.config.ratelimit_burst.max(1))
            .key_extractor(SmartIpKeyExtractor)
            .finish()
            .unwrap(),
    );
    let protected_rate_limiter = protected_rate_config.limiter().clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
        protected_rate_limiter.retain_recent();
    });

    // Stricter limiter for expensive / abuse-prone endpoints: uploads,
    // Giphy embed (outbound fetch + disk write), prekey-bundle fetch
    // (OTPK consumption). burst=10, per_second=5 keeps a normal user
    // unaffected while throttling enumeration sweeps.
    let strict_rate_config = Arc::new(
        GovernorConfigBuilder::default()
            .per_second(5)
            .burst_size(10)
            .key_extractor(SmartIpKeyExtractor)
            .finish()
            .unwrap(),
    );
    let strict_rate_limiter = strict_rate_config.limiter().clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
        strict_rate_limiter.retain_recent();
    });

    let cors = if state.config.allowed_origins.is_empty() {
        if state.config.insecure {
            CorsLayer::very_permissive()
        } else {
            // Restrictive default: same-origin only when no origins configured.
            CorsLayer::new()
        }
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
    // Auth endpoints are rate-limited per-IP to prevent brute force.
    let auth_routes = Router::new()
        .route("/api/v1/auth/challenge", post(auth_handlers::challenge))
        .route("/api/v1/auth/verify", post(auth_handlers::verify))
        .route("/api/v1/auth/register", post(auth_handlers::register))
        .route("/api/v1/auth/bootstrap", post(auth_handlers::bootstrap))
        .layer(GovernorLayer { config: auth_rate_config.clone() });

    let public = Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/version", get(version))
        .route("/api/v1/config", get(get_config))
        .route("/theme/custom.css", get(theme::get_custom_theme))
        // Voice isolation model assets — manifest + DFN3 sub-graphs.
        // Public so the client can fetch before WS auth completes.
        .route("/api/voice/models/manifest.json", get(voice::models_manifest))
        .route("/api/voice/models/{*path}", get(voice::models_serve))
        .merge(auth_routes)
        .route(
            "/api/v1/invites/{token}/info",
            get(invites::get_invite_info),
        )
        .route(
            "/api/v1/federation/join/{token}",
            get(federation::get_join_info),
        )
        // VULN-003: attachment download moved to the PROTECTED group
        // below so auth_middleware + per-channel ACL run on every
        // fetch. Anonymous attachment exfil is no longer possible.
        // Browser-log relay. Public so the client can ship logs before
        // the user signs in. The handler itself no-ops (204) when the
        // feature is disabled in config, so it's safe to leave wired.
        // H8 / VULN-010: same per-IP rate limit as auth routes so a
        // hostile browser can't pin the server's log pipeline.
        .route(
            "/api/v1/debug/browser-log",
            post(debug::ingest)
                .route_layer(GovernorLayer { config: auth_rate_config.clone() }),
        );

    // Protected routes (auth required).
    let protected = Router::new()
        // Users
        .route("/api/v1/users/me", get(users::get_me).patch(users::update_me).delete(users::delete_me))
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
        .route(
            "/api/v1/prekeys/{user_id}",
            get(prekeys::get_bundle)
                .route_layer(GovernorLayer { config: strict_rate_config.clone() }),
        )
        // Teams
        .route("/api/v1/teams", get(teams::list).post(teams::create))
        .route(
            "/api/v1/teams/{team_id}",
            get(teams::get_team).patch(teams::update),
        )
        // Members
        .route(
            "/api/v1/teams/{team_id}/members",
            get(teams::list_members),
        )
        .route(
            "/api/v1/teams/{team_id}/members/{user_id}",
            patch(teams::update_member).delete(teams::kick_member),
        )
        // Self-leave — caller drops their own membership. Distinct from
        // DELETE /members/{user_id} which requires manage-members.
        .route(
            "/api/v1/teams/{team_id}/leave",
            post(teams::leave_team),
        )
        .route(
            "/api/v1/teams/{team_id}/members/{user_id}/ban",
            post(teams::ban_member).delete(teams::unban_member),
        )
        // Channels
        .route(
            "/api/v1/teams/{team_id}/channels",
            get(channels::list).post(channels::create),
        )
        .route(
            "/api/v1/teams/{team_id}/channels/{channel_id}",
            get(channels::get_channel)
                .patch(channels::update)
                .delete(channels::delete_channel),
        )
        .route(
            "/api/v1/teams/{team_id}/channels/{channel_id}/read",
            put(channels::mark_read),
        )
        // Messages
        .route(
            "/api/v1/teams/{team_id}/channels/{channel_id}/messages",
            get(messages::list).post(messages::create),
        )
        .route(
            "/api/v1/teams/{team_id}/channels/{channel_id}/messages/{message_id}",
            patch(messages::edit).delete(messages::delete_msg),
        )
        // Roles
        .route(
            "/api/v1/teams/{team_id}/roles",
            get(roles::list).post(roles::create),
        )
        .route(
            "/api/v1/teams/{team_id}/roles/reorder",
            put(roles::reorder),
        )
        .route(
            "/api/v1/teams/{team_id}/roles/{role_id}",
            patch(roles::update).delete(roles::delete_role),
        )
        .route(
            "/api/v1/teams/{team_id}/audit",
            get(audit::list),
        )
        .route(
            "/api/v1/me/muted-channels",
            get(channel_mutes::list),
        )
        .route(
            "/api/v1/me/muted-channels/{channel_id}",
            put(channel_mutes::mute).delete(channel_mutes::unmute),
        )
        .route(
            "/api/v1/teams/{team_id}/channels/{channel_id}/polls",
            get(polls::list_for_channel).post(polls::create),
        )
        .route(
            "/api/v1/teams/{team_id}/channels/{channel_id}/access",
            get(channels::get_access).put(channels::set_access),
        )
        .route(
            "/api/v1/teams/{team_id}/polls/{poll_id}/votes",
            post(polls::vote).delete(polls::unvote),
        )
        // Channel groups — first-class containers for channels that own
        // role-based access (pure inheritance: channels in a group use
        // the group's roles, channels without a group fall back to
        // channel_role_access).
        .route(
            "/api/v1/teams/{team_id}/groups",
            get(channel_groups::list).post(channel_groups::create),
        )
        .route(
            "/api/v1/teams/{team_id}/groups/{group_id}",
            put(channel_groups::update).delete(channel_groups::delete),
        )
        .route(
            "/api/v1/teams/{team_id}/groups/{group_id}/access",
            get(channel_groups::get_access).put(channel_groups::set_access),
        )
        // Per-user block list. Block / unblock / list endpoints scoped
        // to the caller; WS hub honors the list to drop message:new
        // broadcasts from blocked authors before they reach the wire.
        .route("/api/v1/users/me/blocks", get(blocks::list))
        .route(
            "/api/v1/users/me/blocks/{blocked_id}",
            post(blocks::block).delete(blocks::unblock),
        )
        // Pinned messages — admins pin/unpin via POST/DELETE; everyone
        // can list. message:pin-update broadcasts on every mutation so
        // the pin-popover stays live without a re-fetch.
        .route(
            "/api/v1/teams/{team_id}/channels/{channel_id}/pins",
            get(pins::list_for_channel),
        )
        .route(
            "/api/v1/teams/{team_id}/channels/{channel_id}/messages/{message_id}/pin",
            post(pins::pin).delete(pins::unpin),
        )
        // Gif search proxy for the /giphy slash command. Team-scoped:
        // the key lives in settings (team:<tid>:giphy_api_key) and is
        // set via Team Settings → Integrations. Stays out of the bundle.
        .route("/api/v1/teams/{team_id}/gif", get(gif::search))
        // Materialize a picked Giphy URL into a team attachment — keeps
        // viewer IPs off media.giphy.com and survives Giphy rotating
        // the URL. Returns the same attachment shape /upload does.
        .route(
            "/api/v1/teams/{team_id}/gif/embed",
            post(gif::embed)
                .route_layer(GovernorLayer { config: strict_rate_config.clone() }),
        )
        .route(
            "/api/v1/teams/{team_id}/integrations/giphy",
            get(integrations::get_giphy).put(integrations::set_giphy),
        )
        // Invites
        .route(
            "/api/v1/teams/{team_id}/invites",
            get(invites::list).post(invites::create),
        )
        .route(
            "/api/v1/teams/{team_id}/invites/{invite_id}",
            delete(invites::revoke),
        )
        // DMs
        .route(
            "/api/v1/teams/{team_id}/dms",
            get(dms::list).post(dms::create_or_get),
        )
        .route("/api/v1/teams/{team_id}/dms/{dm_id}", get(dms::get_dm))
        .route(
            "/api/v1/teams/{team_id}/dms/{dm_id}/messages",
            get(dms::list_messages).post(dms::send_message),
        )
        .route(
            "/api/v1/teams/{team_id}/dms/{dm_id}/messages/{message_id}",
            put(dms::edit_message).delete(dms::delete_message),
        )
        .route(
            "/api/v1/teams/{team_id}/dms/{dm_id}/members",
            post(dms::add_members),
        )
        .route(
            "/api/v1/teams/{team_id}/dms/{dm_id}/members/{user_id}",
            delete(dms::remove_member),
        )
        // Threads
        .route(
            "/api/v1/teams/{team_id}/channels/{channel_id}/threads",
            get(threads::list).post(threads::create),
        )
        .route(
            "/api/v1/teams/{team_id}/threads/{thread_id}",
            get(threads::get_thread)
                .put(threads::update)
                .delete(threads::delete_thread),
        )
        .route(
            "/api/v1/teams/{team_id}/threads/{thread_id}/messages",
            get(threads::list_messages).post(threads::create_message),
        )
        // Reactions
        .route(
            "/api/v1/teams/{team_id}/channels/{channel_id}/messages/{message_id}/reactions/{emoji}",
            put(reactions::add).delete(reactions::remove),
        )
        .route(
            "/api/v1/teams/{team_id}/channels/{channel_id}/messages/{message_id}/reactions",
            get(reactions::list),
        )
        // Uploads
        .route(
            "/api/v1/teams/{team_id}/upload",
            post(uploads::upload)
                .route_layer(GovernorLayer { config: strict_rate_config.clone() }),
        )
        .route(
            "/api/v1/teams/{team_id}/attachments/{attachment_id}",
            get(uploads::download).delete(uploads::delete_attachment),
        )
        // Presence
        .route(
            "/api/v1/teams/{team_id}/presence",
            get(presence::get_all).put(presence::update_own),
        )
        .route(
            "/api/v1/teams/{team_id}/presence/{user_id}",
            get(presence::get_user),
        )
        // Voice
        .route(
            "/api/v1/teams/{team_id}/voice/{channel_id}",
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
        // WebSocket ticket (returns a single-use ticket for WS connection)
        .route("/api/v1/auth/ws-ticket", post(ws_ticket))
        // H2 / VULN-012: logout revokes the bearer token via the
        // jwt_revocations table so a stolen JWT can be killed before
        // its natural expiry.
        .route("/api/v1/auth/logout", post(auth_handlers::logout))
        // H2 / VULN-012 + A4: rotate the refresh token (sliding
        // renewal) and mint a fresh access token in one round trip.
        .route("/api/v1/auth/refresh", post(auth_handlers::refresh))
        // A1 / AUTH-MULTIDEV-1: multi-device key trust. A user can
        // enroll N devices, each with its own Ed25519 keypair; any
        // trusted device can revoke any other. Token issuance carries
        // a `device_id` claim so per-device revocation is possible.
        .route("/api/v1/devices", get(devices::list_devices))
        .route(
            "/api/v1/devices/enroll-begin",
            post(devices::enroll_begin)
                .route_layer(GovernorLayer { config: auth_rate_config.clone() }),
        )
        .route(
            "/api/v1/devices/enroll-complete",
            post(devices::enroll_complete)
                .route_layer(GovernorLayer { config: auth_rate_config.clone() }),
        )
        .route(
            "/api/v1/devices/{device_id}/revoke",
            post(devices::revoke_device),
        )
        // WebSocket
        .layer(middleware::from_fn(auth::auth_middleware))
        // VULN-011 / H1: global per-IP rate limit for the protected
        // router. Applied after the auth middleware so denials count
        // against the calling client (not the public surface).
        .layer(GovernorLayer { config: protected_rate_config });

    // WebSocket route — outside auth middleware (does its own token auth via query params)
    let ws_route = Router::new()
        .route("/ws", get(ws_handler));

    let mut router = Router::new()
        .merge(public)
        .merge(protected)
        .merge(ws_route)
        .layer(Extension(state.auth.clone()))
        .layer(cors)
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::header::REFERRER_POLICY,
            HeaderValue::from_static("strict-origin-when-cross-origin"),
        ))
        // F1 — propagate the operator's INSECURE flag into the CSP so
        // the dev pattern (`DILLA_INSECURE=true`) keeps working with the
        // plain-HTTP loopback API while production deployments only allow
        // wss:/https: in connect-src. Cites VULN-001 / VULN-014.
        .fallback_service(crate::webapp::webapp_fallback(crate::webapp::WebappSecurity {
            insecure: state.config.insecure,
        }))
        .with_state(state.clone());

    // Add HSTS header only when TLS is configured.
    if !state.config.tls_cert.is_empty() && !state.config.tls_key.is_empty() {
        router = router.layer(SetResponseHeaderLayer::if_not_present(
            axum::http::header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=63072000; includeSubDomains; preload"),
        ));
    }

    router
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
        "has_custom_theme": !state.config.theme_file.is_empty(),
        // At-rest DB encryption: SQLCipher is keyed off DILLA_DB_PASSPHRASE.
        // Empty passphrase (--insecure dev mode) means the file is plain
        // SQLite. The chip in the client mirrors this — we never claim
        // SQLCipher when it isn't actually in effect.
        "db_encrypted": !state.config.db_passphrase.is_empty(),
        "tls_enabled": !state.config.tls_cert.is_empty(),
    }))
}

/// Generate a single-use WebSocket ticket (requires auth).
async fn ws_ticket(
    Extension(auth_svc): Extension<Arc<AuthService>>,
    axum::extract::Extension(auth::UserId(user_id)): axum::extract::Extension<auth::UserId>,
) -> Json<serde_json::Value> {
    let ticket = auth_svc.generate_ws_ticket(&user_id);
    Json(serde_json::json!({ "ticket": ticket }))
}

async fn ws_handler(
    ws: axum::extract::WebSocketUpgrade,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
    Extension(auth_svc): Extension<Arc<AuthService>>,
    axum::extract::State(state): axum::extract::State<AppState>,
) -> impl axum::response::IntoResponse {
    let team_id = params.get("team").cloned().unwrap_or_default();

    // Try ticket first (preferred — short-lived, single-use), then fall back to JWT.
    let user_id = if let Some(ticket) = params.get("ticket") {
        match auth_svc.validate_ws_ticket(ticket) {
            Ok(uid) => uid,
            Err(_) => {
                return axum::response::Response::builder()
                    .status(401)
                    .body(axum::body::Body::from("invalid or expired ticket"))
                    .unwrap()
                    .into_response();
            }
        }
    } else {
        let token = params.get("token").cloned().unwrap_or_default();
        match auth_svc.validate_jwt(&token) {
            Ok(uid) => uid,
            Err(_) => {
                return axum::response::Response::builder()
                    .status(401)
                    .body(axum::body::Body::from("invalid token"))
                    .unwrap()
                    .into_response();
            }
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
mod tests;
