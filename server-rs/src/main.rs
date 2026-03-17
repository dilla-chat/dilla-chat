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
    let auth_svc = Arc::new(AuthService::new(database.clone()));

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

    // Create WebSocket hub.
    let hub = Arc::new(ws::Hub::new(database.clone()));

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

    // Wire hub callbacks to presence manager.
    let pm = presence_mgr.clone();
    *hub.on_client_connect.write().await = Some(Box::new(move |user_id| {
        let pm = pm.clone();
        let uid = user_id.to_string();
        tokio::spawn(async move { pm.set_online(&uid).await });
    }));

    let pm = presence_mgr.clone();
    *hub.on_client_disconnect.write().await = Some(Box::new(move |user_id| {
        let pm = pm.clone();
        let uid = user_id.to_string();
        tokio::spawn(async move { pm.set_offline(&uid).await });
    }));

    let pm = presence_mgr.clone();
    *hub.on_client_activity.write().await = Some(Box::new(move |user_id| {
        let pm = pm.clone();
        let uid = user_id.to_string();
        tokio::spawn(async move { pm.update_activity(&uid).await });
    }));

    let pm = presence_mgr.clone();
    let db_pres = database.clone();
    *hub.on_presence_update.write().await =
        Some(Box::new(move |user_id, status_type, custom_status| {
            let pm = pm.clone();
            let uid = user_id.to_string();
            let st = status_type.to_string();
            let cs = custom_status.to_string();
            let db = db_pres.clone();
            tokio::spawn(async move {
                pm.update_presence(&uid, presence::Status::from_str(&st), &cs)
                    .await;
                let _ = tokio::task::spawn_blocking(move || {
                    db.with_conn(|conn| db::update_user_status(conn, &uid, &st, &cs))
                })
                .await;
            });
        }));

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
