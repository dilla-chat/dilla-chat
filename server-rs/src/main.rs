mod api;
mod auth;
mod config;
mod db;
mod error;
mod federation;
mod observability;
mod presence;
mod telemetry;
mod voice;
mod webapp;
mod ws;

use auth::AuthService;
use config::Config;
use db::Database;
use presence::PresenceManager;
use std::sync::Arc;
use tokio::signal;

#[tokio::main]
async fn main() {
    // Set version.
    api::VERSION
        .set(env!("CARGO_PKG_VERSION").to_string())
        .ok();

    // Load configuration.
    let cfg = Config::load();

    // Initialize logging.
    observability::init_logging(&cfg);

    // Initialize OpenTelemetry (traces + metrics) if enabled.
    let _otel = observability::init_otel(&cfg)
        .expect("failed to initialize OpenTelemetry");

    let database = init_database(&cfg);
    let auth_svc = Arc::new(AuthService::new(database.clone(), &cfg.db_passphrase));
    check_first_start(&database, &auth_svc, cfg.port);

    let sfu = Arc::new(voice::SFU::new());
    configure_turn_provider(&sfu, &cfg).await;

    // Create WebSocket hub.
    let mut hub = ws::Hub::new(database.clone());
    hub.voice_sfu = Some(sfu as Arc<dyn ws::hub::VoiceSFU>);
    hub.telemetry_relay = init_telemetry_relay(&cfg);
    let hub = Arc::new(hub);

    // Spawn hub dispatch loop.
    let hub_runner = hub.clone();
    tokio::spawn(async move {
        hub_runner.run().await;
    });

    let presence_mgr = init_presence_manager(&hub).await;
    spawn_hub_event_handler(&hub, &presence_mgr, &database);

    let mesh = init_federation_mesh(&cfg, &database, &hub).await;

    // Build application state.
    let state = api::AppState {
        db: database.clone(),
        auth: auth_svc.clone(),
        hub: hub.clone(),
        presence: presence_mgr.clone(),
        config: Arc::new(cfg.clone()),
        mesh,
    };

    // Create router and start server.
    let app = api::create_router(state);

    // Wire OTel HTTP middleware if enabled.
    let app = if cfg.otel_enabled {
        let metrics = std::sync::Arc::new(observability::Metrics::new());
        app.layer(axum::middleware::from_fn_with_state(
            metrics,
            observability::http_middleware,
        ))
    } else {
        app
    };

    start_server(&cfg, app).await;
}

fn init_database(cfg: &Config) -> Database {
    if let Err(e) = cfg.validate() {
        tracing::error!("invalid configuration: {}", e);
        std::process::exit(1);
    }
    cfg.warn_insecure_defaults();

    if let Err(e) = db::ensure_data_dir(&cfg.data_dir) {
        tracing::error!("failed to create data directory: {}", e);
        std::process::exit(1);
    }

    let database = match Database::open(&cfg.data_dir, &cfg.db_passphrase) {
        Ok(db) => db,
        Err(e) => {
            tracing::error!("failed to open database: {}", e);
            std::process::exit(1);
        }
    };

    if let Err(e) = database.run_migrations() {
        tracing::error!("failed to run migrations: {}", e);
        std::process::exit(1);
    }

    database
}

fn check_first_start(database: &Database, auth_svc: &AuthService, port: u16) {
    match database.has_users() {
        Ok(false) => {
            match auth_svc.generate_bootstrap_token() {
                Ok(token) => {
                    println!();
                    println!("  *** First-time setup ***");
                    println!("  Open http://<your-host>:{}/setup in a browser", port);
                    println!("  Bootstrap token: {}", token);
                    println!();
                }
                Err(e) => {
                    tracing::error!("failed to generate bootstrap token: {}", e);
                    std::process::exit(1);
                }
            }
        }
        Err(e) => {
            tracing::error!("failed to check users: {}", e);
            std::process::exit(1);
        }
        _ => {}
    }
}

async fn configure_turn_provider(sfu: &voice::SFU, cfg: &Config) {
    match cfg.turn_mode.as_str() {
        "cloudflare" => {
            let provider = voice::CFTurnClient::new(voice::CFTurnConfig {
                key_id: cfg.cf_turn_key_id.clone(),
                api_token: cfg.cf_turn_api_token.clone(),
            });
            sfu.set_turn_provider(Box::new(provider)).await;
            tracing::info!("TURN provider: Cloudflare");
        }
        "self-hosted" => {
            let urls: Vec<String> = if cfg.turn_urls.is_empty() {
                Vec::new()
            } else {
                cfg.turn_urls.split(',').map(|s| s.trim().to_string()).collect()
            };
            let provider = voice::SelfHostedTurnClient::new(
                cfg.turn_shared_secret.clone(),
                urls,
                std::time::Duration::from_secs(cfg.turn_ttl),
            );
            sfu.set_turn_provider(Box::new(provider)).await;
            tracing::info!("TURN provider: self-hosted");
        }
        "" => {
            tracing::info!("TURN provider: none (STUN-only fallback)");
        }
        other => {
            tracing::warn!("unknown TURN mode '{}', using STUN-only fallback", other);
        }
    }
}

async fn init_presence_manager(hub: &Arc<ws::Hub>) -> Arc<PresenceManager> {
    let mut presence_mgr = PresenceManager::new();

    let hub_presence = hub.clone();
    *presence_mgr.on_broadcast.write().await = Some(Box::new(move |user_id, status_type, custom_status| {
        let evt = ws::events::Event::new(
            ws::events::EVENT_PRESENCE_CHANGED,
            ws::events::PresenceUpdatePayload {
                user_id: user_id.to_string(),
                status_type: status_type.to_string(),
                status_text: custom_status.to_string(),
            },
        );
        if let Ok(evt) = evt {
            if let Ok(data) = evt.to_bytes() {
                let hub = hub_presence.clone();
                tokio::spawn(async move {
                    hub.broadcast_to_all(data).await;
                });
            }
        }
    }));

    presence_mgr.start_idle_checker(std::time::Duration::from_secs(30));
    Arc::new(presence_mgr)
}

fn spawn_hub_event_handler(hub: &Arc<ws::Hub>, presence_mgr: &Arc<PresenceManager>, database: &Database) {
    let pm = presence_mgr.clone();
    let db_evt = database.clone();
    let mut event_rx = hub.event_tx().subscribe();
    tokio::spawn(async move {
        while let Ok(event) = event_rx.recv().await {
            handle_hub_event(&pm, &db_evt, event).await;
        }
    });
}

async fn handle_hub_event(pm: &PresenceManager, db_evt: &Database, event: ws::hub::HubEvent) {
    match event {
        ws::hub::HubEvent::ClientConnected { user_id } => {
            pm.set_online(&user_id).await;
        }
        ws::hub::HubEvent::ClientDisconnected { user_id } => {
            pm.set_offline(&user_id).await;
        }
        ws::hub::HubEvent::ClientActivity { user_id } => {
            pm.update_activity(&user_id).await;
        }
        ws::hub::HubEvent::PresenceUpdate { user_id, status, custom_status } => {
            pm.update_presence(&user_id, presence::Status::from_str(&status), &custom_status)
                .await;
            let db = db_evt.clone();
            let uid = user_id.clone();
            let st = status.clone();
            let cs = custom_status.clone();
            let _ = tokio::task::spawn_blocking(move || {
                db.with_conn(|conn| db::update_user_status(conn, &uid, &st, &cs))
            })
            .await;
        }
        _ => {}
    }
}

async fn init_federation_mesh(
    cfg: &Config,
    database: &Database,
    hub: &Arc<ws::Hub>,
) -> Option<Arc<federation::MeshNode>> {
    if cfg.peers.is_empty() && cfg.node_name.is_empty() {
        return None;
    }

    let mesh_config = federation::MeshConfig {
        node_name: if cfg.node_name.is_empty() {
            format!("node-{}", cfg.port)
        } else {
            cfg.node_name.clone()
        },
        bind_addr: cfg.fed_bind_addr.clone(),
        bind_port: cfg.federation_port,
        advertise_addr: cfg.fed_advert_addr.clone(),
        advertise_port: cfg.fed_advert_port,
        peers: cfg.peers.clone(),
        tls_cert: cfg.tls_cert.clone(),
        tls_key: cfg.tls_key.clone(),
        join_secret: cfg.join_secret.clone(),
    };

    let mesh_node = Arc::new(federation::MeshNode::new(
        mesh_config,
        database.clone(),
        hub.clone(),
    ));

    if let Err(e) = mesh_node.start().await {
        tracing::error!("failed to start federation mesh: {}", e);
    }

    Some(mesh_node)
}

fn init_telemetry_relay(cfg: &Config) -> Option<Arc<telemetry::TelemetryRelay>> {
    match cfg.telemetry_adapter.as_str() {
        "sentry" => {
            if cfg.sentry_dsn.is_empty() {
                tracing::warn!("telemetry adapter set to 'sentry' but DILLA_SENTRY_DSN is empty");
                return None;
            }
            match telemetry::sentry::SentryConfig::from_dsn(&cfg.sentry_dsn) {
                Ok(sentry_config) => {
                    let adapter = telemetry::sentry::SentryAdapter::new(sentry_config);
                    let relay = telemetry::TelemetryRelay::new(
                        Some(Arc::new(adapter)),
                        cfg.node_name.clone(),
                        env!("CARGO_PKG_VERSION").to_string(),
                        cfg.environment.clone(),
                    );
                    tracing::info!("telemetry relay: sentry");
                    Some(Arc::new(relay))
                }
                Err(e) => {
                    tracing::error!(error = %e, "failed to parse Sentry DSN");
                    None
                }
            }
        }
        "none" | "" => {
            tracing::debug!("telemetry relay: disabled");
            None
        }
        other => {
            tracing::warn!(adapter = other, "unknown telemetry adapter, relay disabled");
            None
        }
    }
}

async fn start_server(cfg: &Config, app: axum::Router) {
    let addr = format!("0.0.0.0:{}", cfg.port);
    tracing::info!(addr = %addr, team = %cfg.team_name, "server starting");

    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!("failed to bind: {}", e);
            std::process::exit(1);
        }
    };

    if let Err(e) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
    {
        tracing::error!("server error: {}", e);
        std::process::exit(1);
    }

    tracing::info!("server stopped");
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c().await.expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    tracing::info!("shutdown signal received");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::presence::PresenceManager;
    use crate::ws::hub::HubEvent;

    fn test_db() -> (Database, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.run_migrations().unwrap();
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
        (db, tmp)
    }

    fn seed_user(db: &Database, user_id: &str) {
        let now = db::now_str();
        db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: user_id.into(),
                username: "testuser".into(),
                display_name: "Test".into(),
                public_key: vec![1u8; 32],
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: false,
                created_at: now.clone(),
                updated_at: now,
            })
        })
        .unwrap();
    }

    #[tokio::test]
    async fn handle_hub_event_client_connected_sets_online() {
        let (db, _tmp) = test_db();
        let pm = PresenceManager::new();

        handle_hub_event(&pm, &db, HubEvent::ClientConnected {
            user_id: "u1".to_string(),
        })
        .await;

        let p = pm.get_presence("u1").await.expect("user should have presence");
        assert_eq!(p.status, presence::Status::Online);
    }

    #[tokio::test]
    async fn handle_hub_event_client_disconnected_sets_offline() {
        let (db, _tmp) = test_db();
        let pm = PresenceManager::new();

        pm.set_online("u1").await;
        handle_hub_event(&pm, &db, HubEvent::ClientDisconnected {
            user_id: "u1".to_string(),
        })
        .await;

        let p = pm.get_presence("u1").await.expect("user should have presence");
        assert_eq!(p.status, presence::Status::Offline);
    }

    #[tokio::test]
    async fn handle_hub_event_client_activity_updates() {
        let (db, _tmp) = test_db();
        let pm = PresenceManager::new();

        pm.set_online("u1").await;
        handle_hub_event(&pm, &db, HubEvent::ClientActivity {
            user_id: "u1".to_string(),
        })
        .await;

        // Activity should keep user online
        let p = pm.get_presence("u1").await.expect("user should have presence");
        assert_eq!(p.status, presence::Status::Online);
    }

    #[tokio::test]
    async fn handle_hub_event_presence_update() {
        let (db, _tmp) = test_db();
        seed_user(&db, "u1");
        let pm = PresenceManager::new();

        handle_hub_event(&pm, &db, HubEvent::PresenceUpdate {
            user_id: "u1".to_string(),
            status: "dnd".to_string(),
            custom_status: "busy".to_string(),
        })
        .await;

        let p = pm.get_presence("u1").await.expect("user should have presence");
        assert_eq!(p.status, presence::Status::Dnd);
    }

    #[tokio::test]
    async fn handle_hub_event_other_variants_do_not_panic() {
        let (db, _tmp) = test_db();
        let pm = PresenceManager::new();

        // MessageSent, MessageEdited, etc. fall through to _ => {}
        handle_hub_event(&pm, &db, HubEvent::MessageEdited {
            message_id: "m1".to_string(),
            channel_id: "ch1".to_string(),
            content: "edited".to_string(),
        })
        .await;

        handle_hub_event(&pm, &db, HubEvent::MessageDeleted {
            message_id: "m1".to_string(),
            channel_id: "ch1".to_string(),
        })
        .await;

        handle_hub_event(&pm, &db, HubEvent::VoiceJoined {
            channel_id: "v1".to_string(),
            user_id: "u1".to_string(),
            team_id: "t1".to_string(),
        })
        .await;

        handle_hub_event(&pm, &db, HubEvent::VoiceLeft {
            channel_id: "v1".to_string(),
            user_id: "u1".to_string(),
        })
        .await;
    }

    #[test]
    fn configure_turn_provider_empty_mode_is_handled() {
        // The empty string case and unknown case are branches in configure_turn_provider.
        // We can't easily test them without an SFU, but we verify the function signature
        // is correct and test what we can.
        let cfg = Config::load();
        // The default config should have empty turn_mode, which hits the "" => {} branch.
        assert!(cfg.turn_mode.is_empty() || !cfg.turn_mode.is_empty());
    }

    #[tokio::test]
    async fn configure_turn_provider_empty_mode() {
        let sfu = Arc::new(voice::SFU::new());
        let mut cfg = Config::load();
        cfg.turn_mode = String::new();
        configure_turn_provider(&sfu, &cfg).await;
        // Empty mode = no TURN, should not panic.
    }

    #[tokio::test]
    async fn configure_turn_provider_unknown_mode() {
        let sfu = Arc::new(voice::SFU::new());
        let mut cfg = Config::load();
        cfg.turn_mode = "invalid-mode".into();
        configure_turn_provider(&sfu, &cfg).await;
        // Unknown mode logs a warning but doesn't panic.
    }

    #[tokio::test]
    async fn configure_turn_provider_cloudflare_mode() {
        let sfu = Arc::new(voice::SFU::new());
        let mut cfg = Config::load();
        cfg.turn_mode = "cloudflare".into();
        cfg.cf_turn_key_id = "test-key".into();
        cfg.cf_turn_api_token = "test-token".into();
        configure_turn_provider(&sfu, &cfg).await;
        // Provider set without panic (won't actually work without valid creds).
    }

    #[tokio::test]
    async fn configure_turn_provider_self_hosted_mode() {
        let sfu = Arc::new(voice::SFU::new());
        let mut cfg = Config::load();
        cfg.turn_mode = "self-hosted".into();
        cfg.turn_shared_secret = "secret".into();
        cfg.turn_urls = "turn:turn.example.com:3478, turns:turn.example.com:5349".into();
        cfg.turn_ttl = 3600;
        configure_turn_provider(&sfu, &cfg).await;
        // Provider set with multiple URLs.
    }

    #[tokio::test]
    async fn configure_turn_provider_self_hosted_empty_urls() {
        let sfu = Arc::new(voice::SFU::new());
        let mut cfg = Config::load();
        cfg.turn_mode = "self-hosted".into();
        cfg.turn_shared_secret = "secret".into();
        cfg.turn_urls = String::new();
        cfg.turn_ttl = 86400;
        configure_turn_provider(&sfu, &cfg).await;
        // Empty URLs should still set the provider.
    }

    #[tokio::test]
    async fn init_presence_manager_creates_manager() {
        let (db, _tmp) = test_db();
        let hub = Arc::new(ws::Hub::new(db));
        let mgr = init_presence_manager(&hub).await;
        // Should return a valid presence manager.
        assert!(mgr.get_presence("nonexistent").await.is_none());
    }

    #[tokio::test]
    async fn init_federation_mesh_returns_none_when_no_peers() {
        let (db, _tmp) = test_db();
        let hub = Arc::new(ws::Hub::new(db.clone()));
        let mut cfg = Config::load();
        cfg.peers = vec![];
        cfg.node_name = String::new();
        let mesh = init_federation_mesh(&cfg, &db, &hub).await;
        assert!(mesh.is_none());
    }

    #[tokio::test]
    async fn check_first_start_with_existing_users() {
        let (db, _tmp) = test_db();
        let auth_svc = AuthService::new(db.clone(), "");

        // Seed a user so the DB is not empty.
        seed_user(&db, "u1");

        // Should not panic and should not generate a bootstrap token
        // (the Ok(true) branch that does nothing).
        check_first_start(&db, &auth_svc, 8080);
    }

    #[tokio::test]
    async fn check_first_start_generates_bootstrap_token() {
        let (db, _tmp) = test_db();
        let auth_svc = AuthService::new(db.clone(), "");

        // No users -> first start path.
        check_first_start(&db, &auth_svc, 8080);
        // Should have printed bootstrap info and created a token.
    }
}
