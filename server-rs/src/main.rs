mod api;
mod auth;
mod config;
mod db;
mod error;
mod federation;
mod observability;
mod presence;
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

    // Validate config.
    if let Err(e) = cfg.validate() {
        tracing::error!("invalid configuration: {}", e);
        std::process::exit(1);
    }
    cfg.warn_insecure_defaults();

    // Ensure data directory exists.
    if let Err(e) = db::ensure_data_dir(&cfg.data_dir) {
        tracing::error!("failed to create data directory: {}", e);
        std::process::exit(1);
    }

    // Open database.
    let database = match Database::open(&cfg.data_dir, &cfg.db_passphrase) {
        Ok(db) => db,
        Err(e) => {
            tracing::error!("failed to open database: {}", e);
            std::process::exit(1);
        }
    };

    // Run migrations.
    if let Err(e) = database.run_migrations() {
        tracing::error!("failed to run migrations: {}", e);
        std::process::exit(1);
    }

    // Create auth service.
    let auth_svc = Arc::new(AuthService::new(database.clone(), &cfg.db_passphrase));

    // Check for first start (no users).
    match database.has_users() {
        Ok(false) => {
            match auth_svc.generate_bootstrap_token() {
                Ok(token) => {
                    println!();
                    println!("  *** First-time setup ***");
                    println!("  Open your client UI and navigate to /setup, or use this link:");
                    println!("  http://localhost:5173/setup?token={}", token);
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

    // Create Voice SFU and wire TURN provider.
    let sfu = Arc::new(voice::SFU::new());
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

    // Create WebSocket hub.
    let mut hub = ws::Hub::new(database.clone());
    hub.voice_sfu = Some(sfu as Arc<dyn ws::hub::VoiceSFU>);
    let hub = Arc::new(hub);

    // Spawn hub dispatch loop.
    let hub_runner = hub.clone();
    tokio::spawn(async move {
        hub_runner.run().await;
    });

    // Create presence manager.
    let mut presence_mgr = PresenceManager::new();

    // Wire presence broadcast to WebSocket hub.
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
    let presence_mgr = Arc::new(presence_mgr);

    // Subscribe to hub events and handle presence updates.
    {
        let pm = presence_mgr.clone();
        let db_evt = database.clone();
        let mut event_rx = hub.event_tx().subscribe();
        tokio::spawn(async move {
            while let Ok(event) = event_rx.recv().await {
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
                    // MessageSent, MessageEdited, MessageDeleted, VoiceJoined, VoiceLeft
                    // are available for federation subscribers to consume.
                    _ => {}
                }
            }
        });
    }

    // Start federation mesh node (if peers or federation port configured).
    let mesh = if !cfg.peers.is_empty() || !cfg.node_name.is_empty() {
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
    } else {
        None
    };

    // Build application state.
    let state = api::AppState {
        db: database.clone(),
        auth: auth_svc.clone(),
        hub: hub.clone(),
        presence: presence_mgr.clone(),
        config: Arc::new(cfg.clone()),
        mesh,
    };

    // Create router.
    let app = api::create_router(state);

    // Start server.
    let addr = format!("0.0.0.0:{}", cfg.port);
    tracing::info!(addr = %addr, team = %cfg.team_name, "server starting");

    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!("failed to bind: {}", e);
            std::process::exit(1);
        }
    };

    // Graceful shutdown.
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .unwrap();

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
