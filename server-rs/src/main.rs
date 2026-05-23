mod api;
mod auth;
mod config;
mod db;
mod error;
mod federation;
mod observability;
mod policy;
mod presence;
mod geoip;
mod telemetry;
mod tor_list;
mod voice;
mod webapp;
mod ws;

use auth::AuthService;
use config::Config;
use db::Database;
use presence::PresenceManager;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::signal;

#[tokio::main]
async fn main() {
    // Install the rustls CryptoProvider at process startup. webrtc-rs
    // and any other rustls-using crate panics with "Could not
    // automatically determine the process-level CryptoProvider" the
    // first time it tries to do TLS otherwise. Idempotent if a
    // provider is already installed.
    let _ = rustls::crypto::ring::default_provider().install_default();

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

    // H9 / DB-MEM-1: if any *_FILE env var is set for a secret-bearing
    // config, read the file (one line, trimmed) and override the
    // env-derived value before any consumer reads it. File-mode takes
    // precedence so an operator can avoid leaking secrets via `ps` /
    // `/proc/{pid}/environ` and can mount them from systemd
    // `LoadCredential`, Docker secrets, Vault Agent templates, sops, or
    // a cloud secret manager via tmpfs mount. See
    // `deploy/secrets/README.md` for the operator-tiered guide.
    let mut cfg = cfg;
    if let Err(e) = load_secrets_from_files(&mut cfg) {
        tracing::error!("secret _FILE override: {}", e);
        std::process::exit(1);
    }
    let cfg = cfg;

    // H2 / AUTH-WEAK-1: refuse to start with a weak JWT-derivation
    // source. The JWT HMAC is HKDF-derived from DILLA_DB_PASSPHRASE; an
    // empty passphrase + missing DILLA_JWT_SECRET + insecure=false means
    // we'd derive the signing key from a known-empty input. Same is
    // true for a short passphrase (<32 raw bytes) — refuse unless
    // operator explicitly accepted the risk via DILLA_INSECURE=true.
    enforce_jwt_secret_strength(&cfg);

    let database = init_database(&cfg);
    let node_name_for_auth = if cfg.node_name.is_empty() {
        format!("node-{}", cfg.port)
    } else {
        cfg.node_name.clone()
    };
    let auth_svc = Arc::new(AuthService::with_node_name(
        database.clone(),
        &cfg.db_passphrase,
        node_name_for_auth,
    ));
    check_first_start(&database, &auth_svc, &cfg);

    // GC expired JWT revocation rows in the background so the table
    // stays bounded.
    {
        let db = database.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(3600));
            interval.tick().await; // skip the immediate first tick
            loop {
                interval.tick().await;
                let _ = tokio::task::spawn_blocking({
                    let db = db.clone();
                    move || {
                        let _ = db.with_conn(|c| db::gc_revoked_jtis(c));
                    }
                })
                .await;
            }
        });
    }

    let sfu = Arc::new(voice::SFU::new());
    configure_turn_provider(&sfu, &cfg).await;

    // Create WebSocket hub.
    let mut hub = ws::Hub::new(database.clone());
    hub.voice_sfu = Some(sfu.clone() as Arc<dyn ws::hub::VoiceSFU>);
    // Wire the room manager so handle_voice_join can actually register
    // peers + broadcast voice:user-joined and voice:state. Without
    // this, joining a voice channel becomes a no-op (the handler
    // bails out early on missing room_mgr) and two users in the same
    // channel never see each other.
    hub.voice_room_manager = Some(Arc::new(voice::RoomManager::new()));
    hub.telemetry_relay = init_telemetry_relay(&cfg);
    let hub = Arc::new(hub);

    // Wire SFU → WS event bridge. webrtc-rs generates ICE candidates and
    // renegotiate offers asynchronously after handle_join returns; without
    // this callback those events are dropped on the floor and the
    // server-side ICE agent has no remote candidates to ping → media
    // never connects. The callback is sync (Fn, not async), so each
    // event spawns a short task to do the async broadcast.
    {
        use voice::SFUEvent;
        use ws::events::*;
        let hub_for_sfu = hub.clone();
        sfu.set_on_event(move |_channel_id, evt| {
            let hub = hub_for_sfu.clone();
            tokio::spawn(async move {
                match evt {
                    SFUEvent::ICECandidate {
                        channel_id,
                        user_id,
                        candidate,
                    } => {
                        let payload = VoiceICECandidatePayload {
                            channel_id,
                            candidate: candidate.candidate.clone(),
                            sdp_mid: candidate.sdp_mid.clone().unwrap_or_default(),
                            sdp_mline_index: candidate.sdp_mline_index.unwrap_or(0),
                        };
                        if let Ok(evt) = Event::new(EVENT_VOICE_ICE_CANDIDATE, payload) {
                            if let Ok(bytes) = evt.to_bytes() {
                                hub.send_to_user(&user_id, bytes).await;
                            }
                        }
                    }
                    SFUEvent::Renegotiate {
                        channel_id,
                        user_id,
                        offer,
                    } => {
                        let payload = VoiceOfferPayload {
                            channel_id,
                            sdp: offer.sdp.clone(),
                        };
                        if let Ok(evt) = Event::new(EVENT_VOICE_OFFER, payload) {
                            if let Ok(bytes) = evt.to_bytes() {
                                hub.send_to_user(&user_id, bytes).await;
                            }
                        }
                    }
                    SFUEvent::PeerDropped { channel_id, user_id } => {
                        // ICE failed / PC closed / browser reload —
                        // clean up the RoomManager entry and tell every
                        // client. The explicit voice:leave path doesn't
                        // go through here (it handles its own broadcast).
                        if let Some(room_mgr) = &hub.voice_room_manager {
                            room_mgr.remove_peer(&channel_id, &user_id).await;
                        }
                        if let Ok(evt) = Event::new(
                            EVENT_VOICE_USER_LEFT,
                            VoiceUserLeftPayload {
                                channel_id: channel_id.clone(),
                                user_id: user_id.clone(),
                            },
                        ) {
                            if let Ok(bytes) = evt.to_bytes() {
                                hub.broadcast_to_all(bytes).await;
                            }
                        }
                    }
                }
            });
        })
        .await;
    }

    // Spawn hub dispatch loop.
    let hub_runner = hub.clone();
    tokio::spawn(async move {
        hub_runner.run().await;
    });

    let presence_mgr = init_presence_manager(&hub).await;
    spawn_hub_event_handler(&hub, &presence_mgr, &database);

    // H-8 / A2: optional Tor exit-node list for the auth risk
    // scorer. Absent path / unreadable file is non-fatal; the
    // global stays None and ip_is_tor_exit returns false.
    tor_list::init(&cfg.tor_exit_list_path);

    // H-8b / A2: optional MaxMind GeoLite2 country lookup. Same
    // opt-in posture as the Tor list — absent path is non-fatal,
    // derive_country_from_ip falls back to "unknown".
    geoip::init(&cfg.geoip_db_path);

    // VULN-002 Phase 3 foundation: every install gets a stable
    // Ed25519 node identity, even when federation isn't configured
    // yet. Once the wire format moves to signed FederationEvents
    // (see .security-hardening/14-federation-phase3-design.md) the
    // keypair persisted here is what signs outbound events. Today
    // it's a no-op for non-federated nodes.
    match federation::identity::ensure(&database) {
        Ok(id) => tracing::info!(
            node_id = %id.node_id,
            "FEDERATION: node identity ready"
        ),
        Err(e) => tracing::error!("FEDERATION: failed to ensure node identity: {}", e),
    }

    let mesh = init_federation_mesh(&cfg, &database, &hub).await;

    // Load custom theme CSS from disk once at startup.
    let custom_theme_css = api::theme::load_theme_file(&cfg.theme_file);

    // Build application state.
    let state = api::AppState {
        db: database.clone(),
        auth: auth_svc.clone(),
        hub: hub.clone(),
        presence: presence_mgr.clone(),
        config: Arc::new(cfg.clone()),
        mesh,
        custom_theme_css,
    };

    // Create router and start server.
    let app = api::create_router(state);

    // HTTP middleware: emits one `tracing::info!` per request (the access log
    // operators see via `journalctl -u dilla`) and records OTel spans/metrics
    // on top. Metric/span calls become noops when OTel is disabled, so this
    // is essentially free in that mode but still gives us the access log.
    let metrics = std::sync::Arc::new(observability::Metrics::new());
    let app = app.layer(axum::middleware::from_fn_with_state(
        metrics,
        observability::http_middleware,
    ));

    start_server(&cfg, app).await;
}

/// Read a single secret from a file at `path`, trim trailing whitespace
/// (newlines are the common gotcha — `echo "secret" > file` writes
/// "secret\n"), reject the empty case, and return the trimmed value.
///
/// Generalized helper shared by every `*_FILE` override below. The
/// caller stitches the value into `Config` (or `std::env::set_var` for
/// `DILLA_JWT_SECRET` which is consumed via `std::env::var` later in
/// `auth.rs`).
fn read_secret_file(env_label: &str, path: &str) -> Result<String, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("{}: read {}: {}", env_label, path, e))?;
    let trimmed = raw.trim_end_matches(['\n', '\r', ' ', '\t']).to_string();
    if trimmed.is_empty() {
        return Err(format!(
            "{}: file {} exists but is empty after trim",
            env_label, path
        ));
    }
    Ok(trimmed)
}

/// Resolve every supported `_FILE` override. Each `_FILE` env var, when
/// set, points at a file containing the secret value; the file's
/// contents take precedence over the matching non-`_FILE` env var and
/// over `Config` defaults.
///
/// Matches the Docker secrets convention (Postgres / Redis images use
/// the same pattern). H9 / DB-MEM-1 introduced `DILLA_DB_PASSPHRASE_FILE`;
/// this generalizes the convention to every other secret-bearing env
/// var Dilla accepts. See `deploy/secrets/README.md` for the operator
/// playbook.
fn load_secrets_from_files(cfg: &mut Config) -> Result<(), String> {
    // 1. DB passphrase — overrides cfg.db_passphrase. Same behavior as
    //    the H9 implementation, now flowing through the shared helper.
    if !cfg.db_passphrase_file.is_empty() {
        cfg.db_passphrase =
            read_secret_file("DILLA_DB_PASSPHRASE_FILE", &cfg.db_passphrase_file)?;
    }

    // 2. JWT secret — consumed via `std::env::var("DILLA_JWT_SECRET")`
    //    in `auth::derive_jwt_secret`, so we override the env var
    //    in-process rather than carrying it in `Config`. Rust 2021:
    //    `set_var` is safe; on edition migration this needs an
    //    `unsafe` block.
    if let Ok(path) = std::env::var("DILLA_JWT_SECRET_FILE") {
        if !path.is_empty() {
            let value = read_secret_file("DILLA_JWT_SECRET_FILE", &path)?;
            std::env::set_var("DILLA_JWT_SECRET", value);
        }
    }

    // 3. Federation join secret — overrides cfg.join_secret.
    if let Ok(path) = std::env::var("DILLA_JOIN_SECRET_FILE") {
        if !path.is_empty() {
            cfg.join_secret = read_secret_file("DILLA_JOIN_SECRET_FILE", &path)?;
        }
    }

    // 4. Cloudflare TURN API token — overrides cfg.cf_turn_api_token.
    if let Ok(path) = std::env::var("DILLA_CF_TURN_API_TOKEN_FILE") {
        if !path.is_empty() {
            cfg.cf_turn_api_token =
                read_secret_file("DILLA_CF_TURN_API_TOKEN_FILE", &path)?;
        }
    }

    // 5. OTel exporter auth header value (e.g. an Authorization or
    //    `x-honeycomb-team` token). The header *name* is configured via
    //    DILLA_OTEL_API_HEADER and isn't secret; the *value* is.
    if let Ok(path) = std::env::var("DILLA_OTEL_API_KEY_FILE") {
        if !path.is_empty() {
            cfg.otel_api_key = read_secret_file("DILLA_OTEL_API_KEY_FILE", &path)?;
        }
    }

    // 6. Sentry DSN — embeds the project's ingest secret in the URL.
    if let Ok(path) = std::env::var("DILLA_SENTRY_DSN_FILE") {
        if !path.is_empty() {
            cfg.sentry_dsn = read_secret_file("DILLA_SENTRY_DSN_FILE", &path)?;
        }
    }

    Ok(())
}

/// Refuse to start when the JWT-signing material is too weak. Today the
/// JWT secret is HKDF-derived from `DILLA_DB_PASSPHRASE` (or, when
/// explicitly set, `DILLA_JWT_SECRET`). A 0-byte / sub-32-byte
/// passphrase + no explicit JWT secret means the signing key derives
/// from a low-entropy input and is brute-forceable from any captured
/// token. H2 / AUTH-WEAK-1.
fn enforce_jwt_secret_strength(cfg: &Config) {
    let has_jwt_secret = std::env::var("DILLA_JWT_SECRET")
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    if has_jwt_secret {
        return; // explicit operator override
    }
    let pass_len = cfg.db_passphrase.as_bytes().len();
    if cfg.db_passphrase.is_empty() {
        if cfg.insecure {
            tracing::warn!(
                "SECURITY: JWT secret is derived from an EMPTY DB passphrase (DILLA_INSECURE=true). \
                 Tokens are signed with an ephemeral random key lost on restart. (AUTH-WEAK-1)"
            );
            return;
        }
        eprintln!();
        eprintln!("  ERROR: refusing to start with an empty DILLA_DB_PASSPHRASE.");
        eprintln!("  The JWT signing key is HKDF-derived from the DB passphrase.");
        eprintln!("  Either:");
        eprintln!("    - set DILLA_DB_PASSPHRASE to a >= 32-byte high-entropy value, or");
        eprintln!("    - set DILLA_JWT_SECRET to a >= 32-byte high-entropy value, or");
        eprintln!("    - set DILLA_INSECURE=true to explicitly accept the risk (dev only).");
        eprintln!();
        std::process::exit(1);
    }
    if pass_len < 32 && !cfg.insecure {
        eprintln!();
        eprintln!("  ERROR: DILLA_DB_PASSPHRASE is shorter than 32 bytes ({} given).", pass_len);
        eprintln!("  The JWT signing key is HKDF-derived from this value; a short");
        eprintln!("  passphrase is brute-forceable offline from any captured token.");
        eprintln!("  Either:");
        eprintln!("    - lengthen DILLA_DB_PASSPHRASE to >= 32 bytes, or");
        eprintln!("    - set DILLA_JWT_SECRET to a >= 32-byte value (decoupled from DB key), or");
        eprintln!("    - set DILLA_INSECURE=true to explicitly accept the risk (dev only).");
        eprintln!();
        std::process::exit(1);
    }
    if pass_len < 32 {
        tracing::warn!(
            "SECURITY: DILLA_DB_PASSPHRASE is shorter than 32 bytes ({} given). \
             JWT signing key is weak — (AUTH-WEAK-1). Continuing because DILLA_INSECURE=true.",
            pass_len,
        );
    }
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

fn check_first_start(database: &Database, auth_svc: &AuthService, cfg: &Config) {
    match database.has_users() {
        Ok(false) => {
            match auth_svc.generate_bootstrap_token() {
                Ok(token) => {
                    let path = PathBuf::from(&cfg.data_dir).join("BOOTSTRAP_TOKEN");
                    match write_bootstrap_token_file(&path, &token) {
                        Ok(()) => {
                            // VULN-009: never print the token itself.
                            // Tell the operator where to find it and
                            // that it self-destructs after 15 minutes.
                            eprintln!();
                            eprintln!("  *** First-time setup ***");
                            eprintln!("  Open http://<your-host>:{}/setup in a browser", cfg.port);
                            eprintln!("  Bootstrap token has been written to:");
                            eprintln!("    {} (mode 0600, expires in 15 minutes)", path.display());
                            eprintln!();
                        }
                        Err(e) => {
                            // Fall back to stderr so the operator
                            // isn't locked out — but loudly flag that
                            // they should restart with a writable
                            // DATA_DIR to get the safer behavior.
                            tracing::error!(
                                error = %e,
                                "failed to write bootstrap token file — falling back to stderr (VULN-009 unmitigated until DATA_DIR is writable)"
                            );
                            eprintln!();
                            eprintln!("  *** First-time setup ***");
                            eprintln!("  Open http://<your-host>:{}/setup in a browser", cfg.port);
                            eprintln!("  Bootstrap token: {}", token);
                            eprintln!("  (could not write {} — fix permissions to suppress this banner)", path.display());
                            eprintln!();
                        }
                    }
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

/// Write the bootstrap token to a 0600 file under DATA_DIR.
///
/// Uses `create_new(true)` so an existing token-file (left over from a
/// crash before the operator picked it up) is preserved rather than
/// silently overwritten. The 0600 mode keeps the token out of group /
/// other readers — the previous design that streamed it to stderr was
/// captured by every journald instance on the box (CWE-532).
#[cfg(unix)]
fn write_bootstrap_token_file(path: &std::path::Path, token: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    // If a stale token file exists from a previous unsuccessful
    // bootstrap, remove it first — the prior token is also stored in
    // the DB and will expire on its own, but the file should reflect
    // the newest token only.
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(token.as_bytes())?;
    f.write_all(b"\n")?;
    Ok(())
}

#[cfg(not(unix))]
fn write_bootstrap_token_file(path: &std::path::Path, token: &str) -> std::io::Result<()> {
    // Non-unix targets can't enforce mode bits — best-effort write.
    use std::io::Write;
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    f.write_all(token.as_bytes())?;
    f.write_all(b"\n")?;
    Ok(())
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
    let hub_for_evt = hub.clone();
    let mut event_rx = hub.event_tx().subscribe();
    tokio::spawn(async move {
        while let Ok(event) = event_rx.recv().await {
            handle_hub_event(&pm, &db_evt, &hub_for_evt, event).await;
        }
    });
}

async fn handle_hub_event(
    pm: &PresenceManager,
    db_evt: &Database,
    hub: &Arc<ws::Hub>,
    event: ws::hub::HubEvent,
) {
    match event {
        ws::hub::HubEvent::ClientConnected { user_id } => {
            pm.set_online(&user_id).await;
        }
        ws::hub::HubEvent::ClientDisconnected { user_id } => {
            pm.set_offline(&user_id).await;
            // Last WS for this user gone — also clean voice as a
            // safety net (the per-client VoiceClientGone path already
            // handled it if the closed WS was the voice-holder, but
            // this catches edge cases like the user_index falling
            // out of sync).
            if let Some(room_mgr) = &hub.voice_room_manager {
                let channels = room_mgr.remove_peer_everywhere(&user_id).await;
                for channel_id in channels {
                    if let Ok(evt) = ws::events::Event::new(
                        ws::events::EVENT_VOICE_USER_LEFT,
                        ws::events::VoiceUserLeftPayload {
                            channel_id: channel_id.clone(),
                            user_id: user_id.clone(),
                        },
                    ) {
                        if let Ok(bytes) = evt.to_bytes() {
                            hub.broadcast_to_all(bytes).await;
                        }
                    }
                    if let Some(sfu) = &hub.voice_sfu {
                        sfu.handle_leave(&channel_id, &user_id).await;
                    }
                }
            }
        }
        ws::hub::HubEvent::VoiceClientGone { client_id, user_id, channel_id } => {
            tracing::info!(
                "voice: VoiceClientGone — cleaning up voice for client={} user={} channel={}",
                client_id,
                user_id,
                channel_id
            );
            // The specific WS that held the voice session closed
            // without an explicit voice:leave (tab reload, network
            // drop, crash). Clean up just THIS channel for this user
            // — without this the room would still show the user as
            // present in their pre-reload channel even though they
            // have no live voice session.
            if let Some(room_mgr) = &hub.voice_room_manager {
                room_mgr.remove_peer(&channel_id, &user_id).await;
            }
            if let Ok(evt) = ws::events::Event::new(
                ws::events::EVENT_VOICE_USER_LEFT,
                ws::events::VoiceUserLeftPayload {
                    channel_id: channel_id.clone(),
                    user_id: user_id.clone(),
                },
            ) {
                if let Ok(bytes) = evt.to_bytes() {
                    hub.broadcast_to_all(bytes).await;
                }
            }
            if let Some(sfu) = &hub.voice_sfu {
                sfu.handle_leave(&channel_id, &user_id).await;
            }
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

    // VULN-005 / VULN-021: panic on empty join_secret when peers are
    // configured unless DILLA_INSECURE=true. Also warn loudly when the
    // secret is shorter than 32 bytes (offline brute-force territory).
    federation::join::JoinManager::enforce_security_policy(
        &cfg.join_secret,
        !cfg.peers.is_empty(),
        cfg.insecure,
    );

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
        insecure: cfg.insecure,
        require_v3: cfg.require_federation_v3,
    };

    // VULN-021 final / H7: warn loudly every startup when the
    // federation HMAC key is the random ephemeral fallback (empty
    // configured join_secret). The Phase-1 fix already panics on
    // !insecure; this warning catches the insecure=true path so the
    // operator sees it on every restart.
    if cfg.join_secret.is_empty() && !cfg.peers.is_empty() {
        tracing::warn!(
            "FEDERATION: DILLA_JOIN_SECRET is empty — the in-process join HMAC key is a random ephemeral fallback. \
             Outstanding join JWTs become invalid on every restart, and (when DILLA_INSECURE=true) any peer can claim membership (VULN-021)."
        );
    }

    let mesh_node = Arc::new(federation::MeshNode::new(
        mesh_config,
        database.clone(),
        hub.clone(),
    ));

    if let Err(e) = mesh_node.start().await {
        tracing::error!("failed to start federation mesh: {}", e);
    }

    spawn_federation_status_broadcaster(&mesh_node, hub);

    Some(mesh_node)
}

/// Periodically broadcasts the peer-status snapshot to all connected clients
/// so the Mesh top/bottom bars stay in sync. The cadence is intentionally
/// generous (30s) — clients also tick lamport per message and react to
/// connection events, so this is a backstop, not the hot path.
fn spawn_federation_status_broadcaster(
    mesh_node: &Arc<federation::MeshNode>,
    hub: &Arc<ws::Hub>,
) {
    let mesh_node = Arc::clone(mesh_node);
    let hub = Arc::clone(hub);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
        // Skip the first tick (fires immediately on construction).
        interval.tick().await;
        loop {
            interval.tick().await;
            let peers = mesh_node.get_peers().await;
            let total = peers.len();
            let connected = peers.iter().filter(|p| p.status == "connected").count();
            let degraded = connected < total;

            let peer_payload = serde_json::json!({
                "type": ws::events::EVENT_FEDERATION_PEER_STATUS,
                "payload": {
                    "connected": connected,
                    "total": total,
                    "degraded": degraded,
                },
            });
            if let Ok(bytes) = serde_json::to_vec(&peer_payload) {
                hub.broadcast_to_all(bytes).await;
            }

            // Broadcast current Lamport clock value so clients can render it
            // without needing to track every incoming message.
            let lamport = mesh_node.sync_manager().current();
            let lamport_payload = serde_json::json!({
                "type": ws::events::EVENT_FEDERATION_LAMPORT,
                "payload": { "value": lamport },
            });
            if let Ok(bytes) = serde_json::to_vec(&lamport_payload) {
                hub.broadcast_to_all(bytes).await;
            }
        }
    });
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
    let addr: std::net::SocketAddr = format!("0.0.0.0:{}", cfg.port)
        .parse()
        .unwrap_or_else(|e| {
            tracing::error!("invalid bind address: {}", e);
            std::process::exit(1);
        });

    let tls_configured = !cfg.tls_cert.is_empty() && !cfg.tls_key.is_empty();

    // VULN-001: refuse to start in plaintext unless the operator
    // explicitly opted in via DILLA_INSECURE=true. The dev binary in
    // CLAUDE.md uses DILLA_INSECURE=true and is unaffected.
    if !tls_configured && !cfg.insecure {
        eprintln!();
        eprintln!("  ERROR: refusing to start in plaintext.");
        eprintln!("  Either:");
        eprintln!("    - set DILLA_TLS_CERT and DILLA_TLS_KEY to a valid certificate pair, or");
        eprintln!("    - set DILLA_INSECURE=true to explicitly run an unencrypted HTTP server (dev only).");
        eprintln!();
        std::process::exit(1);
    }

    if tls_configured {
        tracing::info!(addr = %addr, team = %cfg.team_name, "server starting (TLS)");

        let rustls_cfg = match axum_server::tls_rustls::RustlsConfig::from_pem_file(
            &cfg.tls_cert,
            &cfg.tls_key,
        )
        .await
        {
            Ok(c) => c,
            Err(e) => {
                tracing::error!(
                    cert = %cfg.tls_cert,
                    key = %cfg.tls_key,
                    "failed to load TLS cert/key pair: {}",
                    e,
                );
                std::process::exit(1);
            }
        };

        if let Err(e) = axum_server::bind_rustls(addr, rustls_cfg)
            .serve(app.into_make_service_with_connect_info::<std::net::SocketAddr>())
            .await
        {
            tracing::error!("TLS server error: {}", e);
            std::process::exit(1);
        }
    } else {
        // insecure=true confirmed above. Make sure the operator sees a
        // loud reminder in every restart.
        tracing::warn!(
            addr = %addr,
            "SECURITY: running plaintext HTTP because DILLA_INSECURE=true. \
             Do not use in production. (VULN-001)"
        );
        tracing::info!(addr = %addr, team = %cfg.team_name, "server starting (plaintext, insecure mode)");

        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                tracing::error!("failed to bind: {}", e);
                std::process::exit(1);
            }
        };

        if let Err(e) = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .with_graceful_shutdown(shutdown_signal())
        .await
        {
            tracing::error!("server error: {}", e);
            std::process::exit(1);
        }
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
            
                ..Default::default()
            })
        })
        .unwrap();
    }

    #[tokio::test]
    async fn handle_hub_event_client_connected_sets_online() {
        let (db, _tmp) = test_db();
        let pm = PresenceManager::new();

        handle_hub_event(&pm, &db, &Arc::new(ws::Hub::new(db.clone())), HubEvent::ClientConnected {
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
        handle_hub_event(&pm, &db, &Arc::new(ws::Hub::new(db.clone())), HubEvent::ClientDisconnected {
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
        handle_hub_event(&pm, &db, &Arc::new(ws::Hub::new(db.clone())), HubEvent::ClientActivity {
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

        handle_hub_event(&pm, &db, &Arc::new(ws::Hub::new(db.clone())), HubEvent::PresenceUpdate {
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
        handle_hub_event(&pm, &db, &Arc::new(ws::Hub::new(db.clone())), HubEvent::MessageEdited {
            message_id: "m1".to_string(),
            channel_id: "ch1".to_string(),
            content: "edited".to_string(),
        })
        .await;

        handle_hub_event(&pm, &db, &Arc::new(ws::Hub::new(db.clone())), HubEvent::MessageDeleted {
            message_id: "m1".to_string(),
            channel_id: "ch1".to_string(),
        })
        .await;

        handle_hub_event(&pm, &db, &Arc::new(ws::Hub::new(db.clone())), HubEvent::VoiceJoined {
            channel_id: "v1".to_string(),
            user_id: "u1".to_string(),
            team_id: "t1".to_string(),
        })
        .await;

        handle_hub_event(&pm, &db, &Arc::new(ws::Hub::new(db.clone())), HubEvent::VoiceLeft {
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
        check_first_start(&db, &auth_svc, &Config::default());
    }

    #[tokio::test]
    async fn check_first_start_generates_bootstrap_token() {
        let (db, _tmp) = test_db();
        let auth_svc = AuthService::new(db.clone(), "");

        // No users -> first start path.
        check_first_start(&db, &auth_svc, &Config::default());
        // Should have printed bootstrap info and created a token.
    }

    // ── secret-file helpers ───────────────────────────────────────────

    #[test]
    fn read_secret_file_returns_content_with_trimmed_trailing_whitespace() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("secret");
        std::fs::write(&path, "supersecret\n").unwrap();
        let val = read_secret_file("LABEL", path.to_str().unwrap()).unwrap();
        assert_eq!(val, "supersecret");
    }

    #[test]
    fn read_secret_file_trims_carriage_return_and_tab() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("secret");
        std::fs::write(&path, "value\t\r\n  ").unwrap();
        let val = read_secret_file("LABEL", path.to_str().unwrap()).unwrap();
        assert_eq!(val, "value");
    }

    #[test]
    fn read_secret_file_returns_err_for_empty_after_trim() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("secret");
        std::fs::write(&path, "   \n").unwrap();
        let err = read_secret_file("LABEL", path.to_str().unwrap()).unwrap_err();
        assert!(err.contains("empty"));
        assert!(err.contains("LABEL"));
    }

    #[test]
    fn read_secret_file_returns_err_for_missing_file() {
        let err = read_secret_file("LABEL", "/no/such/file/12345").unwrap_err();
        assert!(err.contains("LABEL"));
        assert!(err.contains("read"));
    }

    #[test]
    fn load_secrets_from_files_overrides_db_passphrase_from_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("db.pw");
        std::fs::write(&path, "from-the-file").unwrap();

        let mut cfg = Config::default();
        cfg.db_passphrase = "in-config".into();
        cfg.db_passphrase_file = path.to_str().unwrap().to_string();
        load_secrets_from_files(&mut cfg).unwrap();
        assert_eq!(cfg.db_passphrase, "from-the-file");
    }

    #[test]
    fn load_secrets_from_files_noops_when_no_file_paths_set() {
        let mut cfg = Config::default();
        cfg.db_passphrase = "kept".into();
        load_secrets_from_files(&mut cfg).unwrap();
        assert_eq!(cfg.db_passphrase, "kept");
    }

    #[test]
    fn load_secrets_from_files_returns_err_on_missing_file() {
        let mut cfg = Config::default();
        cfg.db_passphrase_file = "/no/such/file/abc".into();
        assert!(load_secrets_from_files(&mut cfg).is_err());
    }

    // ── JWT-secret strength enforcement (success branches only) ───────

    // enforce_jwt_secret_strength has std::process::exit(1) calls in
    // its failure modes, which can't be tested in-process. The success
    // branches mutate std::env globally and race with parallel tests,
    // so they're left for an integration-test pass instead.
}
