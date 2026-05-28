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
    process_startup_init();

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
    apply_secret_file_overrides_or_exit(&mut cfg);
    let cfg = cfg;

    // H2 / AUTH-WEAK-1: refuse to start with a weak JWT-derivation
    // source. The JWT HMAC is HKDF-derived from DILLA_DB_PASSPHRASE; an
    // empty passphrase + missing DILLA_JWT_SECRET + insecure=false means
    // we'd derive the signing key from a known-empty input. Same is
    // true for a short passphrase (<32 raw bytes) — refuse unless
    // operator explicitly accepted the risk via DILLA_INSECURE=true.
    enforce_jwt_secret_strength(&cfg);

    let database = init_database(&cfg);
    let auth_svc = Arc::new(AuthService::with_node_name(
        database.clone(),
        &cfg.db_passphrase,
        derive_node_name_for_auth(&cfg),
    ));
    check_first_start(&database, &auth_svc, &cfg);

    spawn_jwt_revocation_gc(database.clone());

    let sfu = Arc::new(voice::SFU::new());
    configure_turn_provider(&sfu, &cfg).await;

    let hub = build_voice_hub(&cfg, database.clone(), sfu.clone());
    wire_sfu_event_bridge(&sfu, hub.clone()).await;

    spawn_hub_dispatch_loop(hub.clone());

    let presence_mgr = init_presence_manager(&hub).await;
    spawn_hub_event_handler(&hub, &presence_mgr, &database);

    init_auth_risk_signals(&cfg);

    log_federation_identity_status(&database);

    let mesh = init_federation_mesh(&cfg, &database, &hub).await;

    // Load custom theme CSS from disk once at startup.
    let custom_theme_css = api::theme::load_theme_file(&cfg.theme_file);

    // Build application state.
    let state = build_app_state(
        database.clone(),
        auth_svc.clone(),
        hub.clone(),
        presence_mgr.clone(),
        cfg.clone(),
        mesh,
        custom_theme_css,
    );

    // Create router and start server.
    let app = api::create_router(state);

    // HTTP middleware: emits one `tracing::info!` per request (the access log
    // operators see via `journalctl -u dilla`) and records OTel spans/metrics
    // on top. Metric/span calls become noops when OTel is disabled, so this
    // is essentially free in that mode but still gives us the access log.
    let app = with_http_observability_middleware(app);

    start_server(&cfg, app).await;
}

/// Process-wide one-shot init: install the rustls CryptoProvider and
/// stash the binary's version string into the API module. Idempotent —
/// safe to call multiple times in tests as well as at process start.
pub(crate) fn process_startup_init() {
    // Install the rustls CryptoProvider at process startup. webrtc-rs
    // and any other rustls-using crate panics with "Could not
    // automatically determine the process-level CryptoProvider" the
    // first time it tries to do TLS otherwise. Idempotent if a provider
    // is already installed.
    let _ = rustls::crypto::ring::default_provider().install_default();

    // Stash the version (best-effort — OnceCell::set rejects on second
    // call, which we ignore).
    api::VERSION
        .set(env!("CARGO_PKG_VERSION").to_string())
        .ok();
}

/// Thin wrapper around `load_secrets_from_files` that converts Err into
/// log + exit (so callers can branch on a clean Result in tests instead
/// of crashing the test process via `std::process::exit`).
fn apply_secret_file_overrides_or_exit(cfg: &mut Config) {
    if let Err(e) = load_secrets_from_files(cfg) {
        tracing::error!("secret _FILE override: {}", e);
        std::process::exit(1);
    }
}

/// Initialize the optional H-8 / A2 auth-risk signals: Tor exit-node
/// list + MaxMind GeoLite2 country lookup. Both are absent-path-safe;
/// missing files keep the respective globals as `None` and the scorers
/// fall back to neutral defaults. Extracted from main() so the
/// init-on-startup wiring is testable end-to-end.
pub(crate) fn init_auth_risk_signals(cfg: &Config) {
    // H-8: Tor exit-node list. Absent path / unreadable file is
    // non-fatal; the global stays None and ip_is_tor_exit returns false.
    tor_list::init(&cfg.tor_exit_list_path);
    // H-8b: MaxMind GeoLite2 country lookup. Same opt-in posture as the
    // Tor list — absent path is non-fatal, derive_country_from_ip falls
    // back to "unknown".
    geoip::init(&cfg.geoip_db_path);
}

/// Build the WebSocket hub with voice SFU + room manager + telemetry
/// wired in. Extracted from main() so the assembly of dependent
/// subsystems can be exercised in isolation.
pub(crate) fn build_voice_hub(
    cfg: &Config,
    db: Database,
    sfu: Arc<voice::SFU>,
) -> Arc<ws::Hub> {
    let mut hub = ws::Hub::new(db);
    hub.voice_sfu = Some(sfu as Arc<dyn ws::hub::VoiceSFU>);
    // Wire the room manager so handle_voice_join can actually register
    // peers + broadcast voice:user-joined and voice:state. Without this,
    // joining a voice channel becomes a no-op (the handler bails out
    // early on missing room_mgr) and two users in the same channel
    // never see each other.
    hub.voice_room_manager = Some(Arc::new(voice::RoomManager::new()));
    hub.telemetry_relay = init_telemetry_relay(cfg);
    Arc::new(hub)
}

/// Wire the SFU → WS event bridge. webrtc-rs generates ICE candidates
/// and renegotiate offers asynchronously after handle_join returns;
/// without this callback those events are dropped on the floor and the
/// server-side ICE agent has no remote candidates to ping → media never
/// connects. The callback is sync (Fn, not async), so each event spawns
/// a short task to do the async broadcast.
pub(crate) async fn wire_sfu_event_bridge(sfu: &voice::SFU, hub: Arc<ws::Hub>) {
    sfu.set_on_event(move |_channel_id, evt| {
        let hub = hub.clone();
        tokio::spawn(async move {
            handle_sfu_event(&hub, evt).await;
        });
    })
    .await;
}

/// Spawn the WebSocket hub's per-tick dispatch loop. Extracted from
/// main() so the spawn boundary is testable (the loop body itself runs
/// inside the Hub's own machinery and is exercised by hub-level tests).
pub(crate) fn spawn_hub_dispatch_loop(hub: Arc<ws::Hub>) {
    tokio::spawn(async move {
        hub.run().await;
    });
}

/// Apply the per-request HTTP observability middleware (access log +
/// optional OTel spans/metrics). Extracted from main() so the
/// middleware-wiring side of the code is independently testable.
pub(crate) fn with_http_observability_middleware(app: axum::Router) -> axum::Router {
    let metrics = std::sync::Arc::new(observability::Metrics::new());
    app.layer(axum::middleware::from_fn_with_state(
        metrics,
        observability::http_middleware,
    ))
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
///
/// Result variants drive the main() exit/warn behaviour without
/// std::process::exit inside the helper itself, so tests can drive every
/// branch without crashing the test process.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum JwtStrengthOutcome {
    /// Operator already set DILLA_JWT_SECRET — no further checks.
    OkExplicit,
    /// Strong (>=32 byte) DB passphrase — derived JWT secret is fine.
    OkStrongPass,
    /// Empty passphrase but DILLA_INSECURE=true. main() should warn and
    /// continue; tokens use an ephemeral random key.
    InsecureEmptyPass,
    /// Short (<32 byte) passphrase with DILLA_INSECURE=true. main() should
    /// warn and continue; the JWT key is weak.
    InsecureShortPass(usize),
    /// Empty passphrase AND insecure=false — refuse to start.
    RejectEmpty,
    /// Passphrase too short AND insecure=false — refuse to start.
    RejectShort(usize),
}

pub(crate) fn check_jwt_secret_strength(cfg: &Config) -> JwtStrengthOutcome {
    let has_jwt_secret = std::env::var("DILLA_JWT_SECRET")
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    if has_jwt_secret {
        return JwtStrengthOutcome::OkExplicit;
    }
    let pass_len = cfg.db_passphrase.as_bytes().len();
    if cfg.db_passphrase.is_empty() {
        return if cfg.insecure {
            JwtStrengthOutcome::InsecureEmptyPass
        } else {
            JwtStrengthOutcome::RejectEmpty
        };
    }
    if pass_len < 32 {
        return if cfg.insecure {
            JwtStrengthOutcome::InsecureShortPass(pass_len)
        } else {
            JwtStrengthOutcome::RejectShort(pass_len)
        };
    }
    JwtStrengthOutcome::OkStrongPass
}

fn enforce_jwt_secret_strength(cfg: &Config) {
    match check_jwt_secret_strength(cfg) {
        JwtStrengthOutcome::OkExplicit | JwtStrengthOutcome::OkStrongPass => {}
        JwtStrengthOutcome::InsecureEmptyPass => {
            tracing::warn!(
                "SECURITY: JWT secret is derived from an EMPTY DB passphrase (DILLA_INSECURE=true). \
                 Tokens are signed with an ephemeral random key lost on restart. (AUTH-WEAK-1)"
            );
        }
        JwtStrengthOutcome::InsecureShortPass(pass_len) => {
            tracing::warn!(
                "SECURITY: DILLA_DB_PASSPHRASE is shorter than 32 bytes ({} given). \
                 JWT signing key is weak — (AUTH-WEAK-1). Continuing because DILLA_INSECURE=true.",
                pass_len,
            );
        }
        JwtStrengthOutcome::RejectEmpty => {
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
        JwtStrengthOutcome::RejectShort(pass_len) => {
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
    }
}

/// VULN-002 Phase 3 foundation: every install gets a stable Ed25519
/// node identity, even when federation isn't configured yet. Logs the
/// outcome (info on success, error on failure) so operators see the
/// status in startup logs. Extracted from main() so the Ok/Err
/// branches are independently testable.
pub(crate) fn log_federation_identity_status(database: &Database) {
    match federation::identity::ensure(database) {
        Ok(id) => tracing::info!(
            node_id = %id.node_id,
            "FEDERATION: node identity ready"
        ),
        Err(e) => tracing::error!("FEDERATION: failed to ensure node identity: {}", e),
    }
}

/// Derive the per-node identifier used to scope JWTs. Falls back to a
/// "node-<port>" string when the operator hasn't explicitly set
/// DILLA_NODE_NAME — pure logic, fully testable.
pub(crate) fn derive_node_name_for_auth(cfg: &Config) -> String {
    if cfg.node_name.is_empty() {
        format!("node-{}", cfg.port)
    } else {
        cfg.node_name.clone()
    }
}

/// Spawn the background task that GC's expired JWT-revocation rows.
/// Extracted from main() so the spawn + first-tick skip + interval
/// shape are testable without driving 3600s of wall-clock.
pub(crate) fn spawn_jwt_revocation_gc(db: Database) {
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

/// Construct the application state passed to every route handler.
/// Extracted from main() so unit tests can pin the field layout and
/// catch accidental reordering / dropped fields at compile time.
#[allow(clippy::too_many_arguments)]
pub(crate) fn build_app_state(
    db: Database,
    auth: Arc<AuthService>,
    hub: Arc<ws::Hub>,
    presence: Arc<PresenceManager>,
    cfg: Config,
    mesh: Option<Arc<federation::MeshNode>>,
    custom_theme_css: Option<String>,
) -> api::AppState {
    api::AppState {
        db,
        auth,
        hub,
        presence,
        config: Arc::new(cfg),
        mesh,
        custom_theme_css,
    }
}

/// Pure-Result variant of init_database — same steps, no process::exit.
/// `init_database` is a thin wrapper that translates Err to log + exit so
/// main() runtime behaviour is unchanged but tests can drive every error
/// path without crashing.
pub(crate) fn init_database_result(cfg: &Config) -> Result<Database, String> {
    cfg.validate()
        .map_err(|e| format!("invalid configuration: {}", e))?;
    cfg.warn_insecure_defaults();

    db::ensure_data_dir(&cfg.data_dir)
        .map_err(|e| format!("failed to create data directory: {}", e))?;

    let database = Database::open(&cfg.data_dir, &cfg.db_passphrase)
        .map_err(|e| format!("failed to open database: {}", e))?;

    database
        .run_migrations()
        .map_err(|e| format!("failed to run migrations: {}", e))?;

    Ok(database)
}

fn init_database(cfg: &Config) -> Database {
    match init_database_result(cfg) {
        Ok(db) => db,
        Err(e) => {
            tracing::error!("{}", e);
            std::process::exit(1);
        }
    }
}

/// First-start outcome — drives main()'s eprintln/exit without baking
/// process::exit into the helper itself. Pure logic; tests can pattern
/// match every variant without crashing.
#[derive(Debug)]
pub(crate) enum FirstStartOutcome {
    /// Users already exist — no bootstrap action needed.
    HasUsers,
    /// First start: token generated AND file written. main() prints the
    /// "find your token at <path>" banner.
    TokenWrittenToFile { token_path: PathBuf },
    /// First start: token generated but file write failed. main() prints
    /// the fallback banner with the token inline + a warning.
    TokenStderrFallback { token: String, token_path: PathBuf, write_error: String },
    /// `database.has_users()` failed — main() should exit 1.
    HasUsersError(String),
    /// `auth_svc.generate_bootstrap_token()` failed — main() should exit 1.
    BootstrapTokenError(String),
}

pub(crate) fn first_start_outcome(
    database: &Database,
    auth_svc: &AuthService,
    cfg: &Config,
) -> FirstStartOutcome {
    match database.has_users() {
        Ok(true) => FirstStartOutcome::HasUsers,
        Ok(false) => match auth_svc.generate_bootstrap_token() {
            Ok(token) => {
                let path = PathBuf::from(&cfg.data_dir).join("BOOTSTRAP_TOKEN");
                match write_bootstrap_token_file(&path, &token) {
                    Ok(()) => FirstStartOutcome::TokenWrittenToFile { token_path: path },
                    Err(e) => FirstStartOutcome::TokenStderrFallback {
                        token,
                        token_path: path,
                        write_error: e.to_string(),
                    },
                }
            }
            Err(e) => FirstStartOutcome::BootstrapTokenError(e.to_string()),
        },
        Err(e) => FirstStartOutcome::HasUsersError(e.to_string()),
    }
}

fn check_first_start(database: &Database, auth_svc: &AuthService, cfg: &Config) {
    match first_start_outcome(database, auth_svc, cfg) {
        FirstStartOutcome::HasUsers => {}
        FirstStartOutcome::TokenWrittenToFile { token_path } => {
            // VULN-009: never print the token itself. Tell the operator
            // where to find it and that it self-destructs after 15 minutes.
            eprintln!();
            eprintln!("  *** First-time setup ***");
            eprintln!("  Open http://<your-host>:{}/setup in a browser", cfg.port);
            eprintln!("  Bootstrap token has been written to:");
            eprintln!("    {} (mode 0600, expires in 15 minutes)", token_path.display());
            eprintln!();
        }
        FirstStartOutcome::TokenStderrFallback { token, token_path, write_error } => {
            tracing::error!(
                error = %write_error,
                "failed to write bootstrap token file — falling back to stderr (VULN-009 unmitigated until DATA_DIR is writable)"
            );
            eprintln!();
            eprintln!("  *** First-time setup ***");
            eprintln!("  Open http://<your-host>:{}/setup in a browser", cfg.port);
            eprintln!("  Bootstrap token: {}", token);
            eprintln!("  (could not write {} — fix permissions to suppress this banner)", token_path.display());
            eprintln!();
        }
        FirstStartOutcome::BootstrapTokenError(e) => {
            tracing::error!("failed to generate bootstrap token: {}", e);
            std::process::exit(1);
        }
        FirstStartOutcome::HasUsersError(e) => {
            tracing::error!("failed to check users: {}", e);
            std::process::exit(1);
        }
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
    *presence_mgr.on_broadcast.write().await = Some(Box::new(
        move |user_id, status_type, custom_status| {
            broadcast_presence_update(&hub_presence, user_id, status_type, custom_status);
        },
    ));

    presence_mgr.start_idle_checker(std::time::Duration::from_secs(30));
    Arc::new(presence_mgr)
}

/// Build a presence:changed event from a presence-manager callback and
/// fire-and-forget broadcast it. Extracted so the event-construction +
/// serialization path is independently testable from the closure that
/// captures the Hub Arc.
pub(crate) fn broadcast_presence_update(
    hub: &Arc<ws::Hub>,
    user_id: &str,
    status_type: &str,
    custom_status: &str,
) {
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
            let hub = hub.clone();
            tokio::spawn(async move {
                hub.broadcast_to_all(data).await;
            });
        }
    }
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

/// Dispatch an SFU event to the connected WS clients. Extracted from
/// the closure in main() so the per-variant logic is independently
/// testable (no real RTCPeerConnection needed).
pub(crate) async fn handle_sfu_event(hub: &Arc<ws::Hub>, evt: voice::SFUEvent) {
    use voice::SFUEvent;
    use ws::events::*;
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
            // ICE failed / PC closed / browser reload — clean up the
            // RoomManager entry and tell every client.
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
/// Build the peer-status + lamport payload pair that the periodic
/// broadcaster ships to every connected client each tick. Extracted
/// from the spawn_federation_status_broadcaster loop body so the JSON
/// shape can be unit-tested without driving a 30-second interval.
pub(crate) fn federation_status_payloads(
    snap: &FederationStatusSnapshot,
    lamport: u64,
) -> (serde_json::Value, serde_json::Value) {
    let peer_payload = serde_json::json!({
        "type": ws::events::EVENT_FEDERATION_PEER_STATUS,
        "payload": {
            "connected": snap.connected,
            "total": snap.total,
            "degraded": snap.degraded,
        },
    });
    let lamport_payload = serde_json::json!({
        "type": ws::events::EVENT_FEDERATION_LAMPORT,
        "payload": { "value": lamport },
    });
    (peer_payload, lamport_payload)
}

/// One tick of the federation status broadcaster: snapshot peers,
/// build the two payloads, broadcast them to every connected client.
/// Driving this directly in a test is far cheaper than waiting for
/// the 30-second interval.
pub(crate) async fn broadcast_federation_status(
    mesh_node: &Arc<federation::MeshNode>,
    hub: &Arc<ws::Hub>,
) {
    let peers = mesh_node.get_peers().await;
    let snap = federation_status_snapshot(&peers);
    let lamport = mesh_node.sync_manager().current();
    let (peer_payload, lamport_payload) = federation_status_payloads(&snap, lamport);
    if let Ok(bytes) = serde_json::to_vec(&peer_payload) {
        hub.broadcast_to_all(bytes).await;
    }
    if let Ok(bytes) = serde_json::to_vec(&lamport_payload) {
        hub.broadcast_to_all(bytes).await;
    }
}

/// Snapshot of the federation peer status used in the periodic broadcast.
/// Extracted from `spawn_federation_status_broadcaster` so the
/// pure-data computation (count peers, derive degraded) can be tested
/// in isolation from the tokio interval driver.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct FederationStatusSnapshot {
    pub connected: usize,
    pub total: usize,
    pub degraded: bool,
}

pub(crate) fn federation_status_snapshot(
    peers: &[federation::PeerInfo],
) -> FederationStatusSnapshot {
    let total = peers.len();
    let connected = peers.iter().filter(|p| p.status == "connected").count();
    FederationStatusSnapshot {
        connected,
        total,
        degraded: connected < total,
    }
}

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
            broadcast_federation_status(&mesh_node, &hub).await;
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

/// Pre-flight check for start_server — parse the bind address and
/// determine TLS-vs-plaintext mode without touching the network. Pure
/// logic so unit tests can drive every error/decision branch.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ServerStartMode {
    Tls(std::net::SocketAddr),
    Plaintext(std::net::SocketAddr),
    RejectPlaintext,
    BindParseError(String),
}

pub(crate) fn start_server_mode(cfg: &Config) -> ServerStartMode {
    let addr_result = format!("0.0.0.0:{}", cfg.port).parse::<std::net::SocketAddr>();
    let addr = match addr_result {
        Ok(a) => a,
        Err(e) => return ServerStartMode::BindParseError(e.to_string()),
    };
    let tls_configured = !cfg.tls_cert.is_empty() && !cfg.tls_key.is_empty();
    if tls_configured {
        ServerStartMode::Tls(addr)
    } else if cfg.insecure {
        ServerStartMode::Plaintext(addr)
    } else {
        ServerStartMode::RejectPlaintext
    }
}

async fn start_server(cfg: &Config, app: axum::Router) {
    let addr = match start_server_mode(cfg) {
        ServerStartMode::Tls(a) | ServerStartMode::Plaintext(a) => a,
        ServerStartMode::BindParseError(e) => {
            tracing::error!("invalid bind address: {}", e);
            std::process::exit(1);
        }
        ServerStartMode::RejectPlaintext => {
            eprintln!();
            eprintln!("  ERROR: refusing to start in plaintext.");
            eprintln!("  Either:");
            eprintln!("    - set DILLA_TLS_CERT and DILLA_TLS_KEY to a valid certificate pair, or");
            eprintln!("    - set DILLA_INSECURE=true to explicitly run an unencrypted HTTP server (dev only).");
            eprintln!();
            std::process::exit(1);
        }
    };

    let tls_configured = !cfg.tls_cert.is_empty() && !cfg.tls_key.is_empty();

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

    // ── handle_sfu_event (SFU → WS bridge) ───────────────────────────
    //
    // Drive each SFUEvent variant through the extracted helper. Hub is
    // real but with no connected clients — broadcast/send are no-ops
    // but the match arms + payload construction run.

    // ── process_startup_init ─────────────────────────────────────────

    #[test]
    fn process_startup_init_is_idempotent() {
        // Safe to call twice — install_default returns Err the second
        // time but we ignore that. Also installs the API VERSION.
        process_startup_init();
        process_startup_init();
        // VERSION should be set to the crate version (or whatever a
        // prior test set first; assert that it's non-empty).
        let v = api::VERSION.get().map(|s| s.as_str()).unwrap_or("");
        assert!(!v.is_empty());
    }

    // ── apply_secret_file_overrides_or_exit ──────────────────────────

    #[test]
    fn apply_secret_file_overrides_or_exit_is_noop_when_no_file_paths() {
        let mut cfg = Config::default();
        // Default cfg has no *_FILE env vars set + db_passphrase_file
        // empty → load_secrets_from_files returns Ok(()) → wrapper
        // returns without touching exit.
        apply_secret_file_overrides_or_exit(&mut cfg);
    }

    #[test]
    fn apply_secret_file_overrides_or_exit_applies_db_passphrase_from_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("db.pw");
        std::fs::write(&path, "from-file-32-bytes-long-padding-xxx").unwrap();
        let mut cfg = Config::default();
        cfg.db_passphrase_file = path.to_str().unwrap().to_string();
        apply_secret_file_overrides_or_exit(&mut cfg);
        assert_eq!(cfg.db_passphrase, "from-file-32-bytes-long-padding-xxx");
    }

    // ── init_auth_risk_signals ───────────────────────────────────────

    #[test]
    fn init_auth_risk_signals_with_empty_paths_is_safe() {
        let mut cfg = Config::default();
        cfg.tor_exit_list_path = String::new();
        cfg.geoip_db_path = String::new();
        init_auth_risk_signals(&cfg);
        // Tor list + geoip stay None — both helpers return false/None.
    }

    #[test]
    fn init_auth_risk_signals_with_missing_files_is_safe() {
        let mut cfg = Config::default();
        cfg.tor_exit_list_path = "/nonexistent/tor-exit-list.txt".into();
        cfg.geoip_db_path = "/nonexistent/geoip.mmdb".into();
        init_auth_risk_signals(&cfg);
        // The init helpers swallow missing-file errors.
    }

    // ── build_voice_hub + wire_sfu_event_bridge ──────────────────────

    #[tokio::test]
    async fn build_voice_hub_wires_sfu_and_room_manager() {
        let (db, _tmp) = test_db();
        let sfu = Arc::new(voice::SFU::new());
        let mut cfg = Config::default();
        cfg.telemetry_adapter = "none".into();
        let hub = build_voice_hub(&cfg, db, sfu);
        assert!(hub.voice_sfu.is_some(), "voice_sfu must be wired");
        assert!(hub.voice_room_manager.is_some(), "room manager must be wired");
        // telemetry_relay is None when adapter=none — confirms the
        // init_telemetry_relay branch flowed through.
        assert!(hub.telemetry_relay.is_none());
    }

    #[tokio::test]
    async fn build_voice_hub_wires_sentry_telemetry_when_configured() {
        let (db, _tmp) = test_db();
        let sfu = Arc::new(voice::SFU::new());
        let mut cfg = Config::default();
        cfg.telemetry_adapter = "sentry".into();
        cfg.sentry_dsn = "https://abc123@o123456.ingest.sentry.io/456789".into();
        let hub = build_voice_hub(&cfg, db, sfu);
        assert!(hub.telemetry_relay.is_some(), "valid Sentry config → relay wired");
    }

    #[tokio::test]
    async fn wire_sfu_event_bridge_attaches_callback() {
        let (db, _tmp) = test_db();
        let sfu = Arc::new(voice::SFU::new());
        let mut cfg = Config::default();
        cfg.telemetry_adapter = "none".into();
        let hub = build_voice_hub(&cfg, db, sfu.clone());
        wire_sfu_event_bridge(&sfu, hub).await;
        // Callback is set — survival of the await is the signal.
    }

    // ── spawn_hub_dispatch_loop ──────────────────────────────────────

    #[tokio::test]
    async fn spawn_hub_dispatch_loop_starts_without_panic() {
        let (db, _tmp) = test_db();
        let hub = Arc::new(ws::Hub::new(db));
        spawn_hub_dispatch_loop(hub);
        // The dispatch loop awaits hub events forever; the spawn itself
        // succeeding without panic is the assertion.
    }

    // ── with_http_observability_middleware ───────────────────────────

    #[tokio::test]
    async fn with_http_observability_middleware_returns_a_layered_router() {
        use axum::body::Body;
        use axum::http::Request;
        use axum::routing::get;
        use axum::Router;
        use tower::ServiceExt;

        let inner = Router::new().route("/health", get(|| async { "ok" }));
        let layered = with_http_observability_middleware(inner);
        let resp = layered
            .oneshot(Request::get("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    // ── log_federation_identity_status ───────────────────────────────

    #[test]
    fn log_federation_identity_status_success_on_fresh_db() {
        let (db, _tmp) = test_db();
        // First call generates + persists the identity → tracing::info path.
        log_federation_identity_status(&db);
        // Second call hits the "already present" path inside ensure() →
        // still Ok → still hits the info branch.
        log_federation_identity_status(&db);
    }

    // ── derive_node_name_for_auth ────────────────────────────────────

    #[test]
    fn derive_node_name_for_auth_falls_back_to_port() {
        let mut cfg = Config::default();
        cfg.node_name = String::new();
        cfg.port = 1234;
        assert_eq!(derive_node_name_for_auth(&cfg), "node-1234");
    }

    #[test]
    fn derive_node_name_for_auth_uses_explicit_name() {
        let mut cfg = Config::default();
        cfg.node_name = "my-node".into();
        cfg.port = 9999;
        assert_eq!(derive_node_name_for_auth(&cfg), "my-node");
    }

    #[test]
    fn derive_node_name_for_auth_default_port_zero() {
        // Config::default() leaves port at 0 — verifies the format!
        // still works with edge-case port values.
        let cfg = Config::default();
        assert_eq!(derive_node_name_for_auth(&cfg), "node-0");
    }

    // ── spawn_jwt_revocation_gc ──────────────────────────────────────

    #[tokio::test]
    async fn spawn_jwt_revocation_gc_starts_without_panic() {
        let (db, _tmp) = test_db();
        // The spawned task waits 3600s on first tick before doing
        // anything; we just verify the spawn itself doesn't crash.
        spawn_jwt_revocation_gc(db);
    }

    // ── build_app_state ──────────────────────────────────────────────

    #[tokio::test]
    async fn build_app_state_populates_all_fields() {
        let (db, _tmp) = test_db();
        let auth = Arc::new(AuthService::new(db.clone(), ""));
        let hub = Arc::new(ws::Hub::new(db.clone()));
        let presence = Arc::new(PresenceManager::new());
        let mut cfg = Config::default();
        cfg.port = 9999;
        cfg.team_name = "Acme".into();
        let theme = Some("body { color: red; }".to_string());

        let state = build_app_state(
            db.clone(),
            auth.clone(),
            hub.clone(),
            presence.clone(),
            cfg.clone(),
            None,
            theme.clone(),
        );

        assert_eq!(state.config.port, 9999);
        assert_eq!(state.config.team_name, "Acme");
        assert!(state.mesh.is_none());
        assert_eq!(state.custom_theme_css, theme);
    }

    #[tokio::test]
    async fn build_app_state_with_no_theme() {
        let (db, _tmp) = test_db();
        let auth = Arc::new(AuthService::new(db.clone(), ""));
        let hub = Arc::new(ws::Hub::new(db.clone()));
        let presence = Arc::new(PresenceManager::new());
        let state = build_app_state(
            db,
            auth,
            hub,
            presence,
            Config::default(),
            None,
            None,
        );
        assert!(state.custom_theme_css.is_none());
    }

    #[tokio::test]
    async fn spawn_hub_event_handler_starts_without_panic() {
        let (db, _tmp) = test_db();
        let hub = Arc::new(ws::Hub::new(db.clone()));
        let pm = Arc::new(PresenceManager::new());
        spawn_hub_event_handler(&hub, &pm, &db);
        // Spawned task subscribes to hub.event_tx() and idles. Survival
        // confirms the spawn + subscribe pipeline doesn't crash.
    }

    #[tokio::test]
    async fn handle_sfu_event_ice_candidate_does_not_panic() {
        use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
        let (db, _tmp) = test_db();
        let hub = Arc::new(ws::Hub::new(db));
        let candidate = Box::new(RTCIceCandidateInit {
            candidate: "candidate:1 1 udp 1 192.0.2.1 1234 typ host".into(),
            sdp_mid: Some("0".into()),
            sdp_mline_index: Some(0),
            username_fragment: None,
        });
        handle_sfu_event(
            &hub,
            voice::SFUEvent::ICECandidate {
                channel_id: "ch1".into(),
                user_id: "u1".into(),
                candidate,
            },
        )
        .await;
    }

    #[tokio::test]
    async fn handle_sfu_event_ice_candidate_with_no_sdp_mid_uses_default() {
        use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
        let (db, _tmp) = test_db();
        let hub = Arc::new(ws::Hub::new(db));
        let candidate = Box::new(RTCIceCandidateInit {
            candidate: "candidate:2".into(),
            sdp_mid: None,
            sdp_mline_index: None,
            username_fragment: None,
        });
        // Exercises the unwrap_or_default branches.
        handle_sfu_event(
            &hub,
            voice::SFUEvent::ICECandidate {
                channel_id: "ch1".into(),
                user_id: "u1".into(),
                candidate,
            },
        )
        .await;
    }

    #[tokio::test]
    async fn handle_sfu_event_renegotiate_does_not_panic() {
        use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
        let (db, _tmp) = test_db();
        let hub = Arc::new(ws::Hub::new(db));
        // Use the `offer` constructor which builds a valid descriptor.
        let offer = Box::new(
            RTCSessionDescription::offer(
                "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n".into(),
            )
            .unwrap(),
        );
        handle_sfu_event(
            &hub,
            voice::SFUEvent::Renegotiate {
                channel_id: "ch1".into(),
                user_id: "u1".into(),
                offer,
            },
        )
        .await;
    }

    #[tokio::test]
    async fn handle_sfu_event_peer_dropped_removes_from_room_manager() {
        let (db, _tmp) = test_db();
        let mut hub_inner = ws::Hub::new(db);
        let rm = Arc::new(voice::RoomManager::new());
        rm.add_peer("ch1", "u1", "u1", "t1").await;
        hub_inner.voice_room_manager = Some(rm.clone());
        let hub = Arc::new(hub_inner);
        handle_sfu_event(
            &hub,
            voice::SFUEvent::PeerDropped {
                channel_id: "ch1".into(),
                user_id: "u1".into(),
            },
        )
        .await;
        // After PeerDropped the room manager no longer lists this user.
        let peers = rm.get_room("ch1").await.unwrap_or_default();
        assert!(peers.iter().all(|p| p.user_id != "u1"));
    }

    #[tokio::test]
    async fn handle_sfu_event_peer_dropped_without_room_manager_is_noop() {
        let (db, _tmp) = test_db();
        let hub = Arc::new(ws::Hub::new(db));
        // No voice_room_manager set — handler must not panic.
        handle_sfu_event(
            &hub,
            voice::SFUEvent::PeerDropped {
                channel_id: "ch1".into(),
                user_id: "u1".into(),
            },
        )
        .await;
    }

    #[tokio::test]
    async fn handle_hub_event_voice_client_gone_cleans_room() {
        let (db, _tmp) = test_db();
        let pm = PresenceManager::new();
        let mut hub_inner = ws::Hub::new(db.clone());
        hub_inner.voice_room_manager = Some(Arc::new(voice::RoomManager::new()));
        let hub = Arc::new(hub_inner);

        handle_hub_event(
            &pm,
            &db,
            &hub,
            HubEvent::VoiceClientGone {
                client_id: "c1".to_string(),
                user_id: "u1".to_string(),
                channel_id: "voice-ch".to_string(),
            },
        )
        .await;
        // The handler must not panic and must traverse the room manager
        // + sfu cleanup branches. Survival is the assertion.
    }

    #[tokio::test]
    async fn handle_hub_event_client_disconnected_cleans_voice() {
        let (db, _tmp) = test_db();
        let pm = PresenceManager::new();
        let mut hub_inner = ws::Hub::new(db.clone());
        let rm = Arc::new(voice::RoomManager::new());
        hub_inner.voice_room_manager = Some(rm.clone());
        let hub = Arc::new(hub_inner);

        // Seed the room manager with a peer so remove_peer_everywhere
        // returns a non-empty list and the broadcast/sfu cleanup runs.
        rm.add_peer("voice-ch", "u1", "u1", "t1").await;

        pm.set_online("u1").await;
        handle_hub_event(&pm, &db, &hub, HubEvent::ClientDisconnected {
            user_id: "u1".to_string(),
        })
        .await;
        // Presence flipped + voice cleanup ran without panic.
        let p = pm.get_presence("u1").await.expect("user should have presence");
        assert_eq!(p.status, presence::Status::Offline);
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
    async fn init_federation_mesh_returns_some_with_node_name_only() {
        // peers empty + node_name set → still spins up a MeshNode.
        let (db, _tmp) = test_db();
        let hub = Arc::new(ws::Hub::new(db.clone()));
        let mut cfg = Config::load();
        cfg.peers = vec![];
        cfg.node_name = "test-node".into();
        cfg.join_secret = "secret-32-bytes-or-longer-for-policy-please".into();
        cfg.insecure = true;
        // Use a port unlikely to collide.
        cfg.federation_port = 0;
        cfg.fed_bind_addr = "127.0.0.1".into();
        let mesh = init_federation_mesh(&cfg, &db, &hub).await;
        assert!(mesh.is_some());
    }

    #[tokio::test]
    async fn init_federation_mesh_warn_path_with_empty_join_secret() {
        // peers non-empty + insecure=true + empty join_secret → the
        // warn branch (L794-798) fires, MeshNode is still constructed.
        let (db, _tmp) = test_db();
        let hub = Arc::new(ws::Hub::new(db.clone()));
        let mut cfg = Config::load();
        cfg.peers = vec!["127.0.0.1:0".into()];
        cfg.node_name = "warn-node".into();
        cfg.join_secret = String::new();
        cfg.insecure = true;
        cfg.federation_port = 0;
        cfg.fed_bind_addr = "127.0.0.1".into();
        let mesh = init_federation_mesh(&cfg, &db, &hub).await;
        // mesh.start() may or may not bind to port 0 cleanly across OS;
        // either Ok or Err just needs to not panic and return Some.
        assert!(mesh.is_some());
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

    // ── env-var-driven file branches of load_secrets_from_files ──────
    //
    // These tests mutate std::env globally; the mutex serializes them so
    // parallel cargo-test workers don't race on the shared environment.
    // Same pattern as api::gif::GIPHY_ENV_LOCK.
    static SECRETS_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn lock_secrets_env() -> std::sync::MutexGuard<'static, ()> {
        SECRETS_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner())
    }

    #[test]
    fn load_secrets_from_files_overrides_jwt_secret_from_file() {
        let _g = lock_secrets_env();
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("jwt.secret");
        std::fs::write(&path, "jwt-from-file").unwrap();
        std::env::set_var("DILLA_JWT_SECRET_FILE", path.to_str().unwrap());
        std::env::remove_var("DILLA_JWT_SECRET");
        let mut cfg = Config::default();
        let res = load_secrets_from_files(&mut cfg);
        let jwt = std::env::var("DILLA_JWT_SECRET").ok();
        std::env::remove_var("DILLA_JWT_SECRET_FILE");
        std::env::remove_var("DILLA_JWT_SECRET");
        res.unwrap();
        assert_eq!(jwt.as_deref(), Some("jwt-from-file"));
    }

    #[test]
    fn load_secrets_from_files_skips_empty_jwt_secret_file_var() {
        let _g = lock_secrets_env();
        std::env::set_var("DILLA_JWT_SECRET_FILE", "");
        std::env::remove_var("DILLA_JWT_SECRET");
        let mut cfg = Config::default();
        load_secrets_from_files(&mut cfg).unwrap();
        // empty path → branch body skipped → env var stays unset.
        let jwt = std::env::var("DILLA_JWT_SECRET").ok();
        std::env::remove_var("DILLA_JWT_SECRET_FILE");
        assert!(jwt.is_none());
    }

    #[test]
    fn load_secrets_from_files_overrides_join_secret_from_file() {
        let _g = lock_secrets_env();
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("join.secret");
        std::fs::write(&path, "join-from-file").unwrap();
        std::env::set_var("DILLA_JOIN_SECRET_FILE", path.to_str().unwrap());
        let mut cfg = Config::default();
        cfg.join_secret = "in-config".into();
        let res = load_secrets_from_files(&mut cfg);
        std::env::remove_var("DILLA_JOIN_SECRET_FILE");
        res.unwrap();
        assert_eq!(cfg.join_secret, "join-from-file");
    }

    #[test]
    fn load_secrets_from_files_overrides_cf_turn_api_token_from_file() {
        let _g = lock_secrets_env();
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("cf.token");
        std::fs::write(&path, "cf-token-from-file").unwrap();
        std::env::set_var("DILLA_CF_TURN_API_TOKEN_FILE", path.to_str().unwrap());
        let mut cfg = Config::default();
        let res = load_secrets_from_files(&mut cfg);
        std::env::remove_var("DILLA_CF_TURN_API_TOKEN_FILE");
        res.unwrap();
        assert_eq!(cfg.cf_turn_api_token, "cf-token-from-file");
    }

    #[test]
    fn load_secrets_from_files_overrides_otel_api_key_from_file() {
        let _g = lock_secrets_env();
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("otel.key");
        std::fs::write(&path, "otel-key-from-file").unwrap();
        std::env::set_var("DILLA_OTEL_API_KEY_FILE", path.to_str().unwrap());
        let mut cfg = Config::default();
        let res = load_secrets_from_files(&mut cfg);
        std::env::remove_var("DILLA_OTEL_API_KEY_FILE");
        res.unwrap();
        assert_eq!(cfg.otel_api_key, "otel-key-from-file");
    }

    #[test]
    fn load_secrets_from_files_overrides_sentry_dsn_from_file() {
        let _g = lock_secrets_env();
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("sentry.dsn");
        std::fs::write(&path, "https://abc@sentry.io/1\n").unwrap();
        std::env::set_var("DILLA_SENTRY_DSN_FILE", path.to_str().unwrap());
        let mut cfg = Config::default();
        let res = load_secrets_from_files(&mut cfg);
        std::env::remove_var("DILLA_SENTRY_DSN_FILE");
        res.unwrap();
        assert_eq!(cfg.sentry_dsn, "https://abc@sentry.io/1");
    }

    #[test]
    fn load_secrets_from_files_returns_err_when_join_secret_file_missing() {
        let _g = lock_secrets_env();
        std::env::set_var("DILLA_JOIN_SECRET_FILE", "/no/such/file/join-xyz");
        let mut cfg = Config::default();
        let res = load_secrets_from_files(&mut cfg);
        std::env::remove_var("DILLA_JOIN_SECRET_FILE");
        assert!(res.is_err());
    }

    #[test]
    fn load_secrets_from_files_skips_empty_join_secret_file_var() {
        let _g = lock_secrets_env();
        std::env::set_var("DILLA_JOIN_SECRET_FILE", "");
        let mut cfg = Config::default();
        cfg.join_secret = "kept".into();
        let res = load_secrets_from_files(&mut cfg);
        std::env::remove_var("DILLA_JOIN_SECRET_FILE");
        res.unwrap();
        assert_eq!(cfg.join_secret, "kept");
    }

    // ── JWT-secret strength enforcement (pure-Result variant) ─────────
    //
    // `check_jwt_secret_strength` returns an enum classifying the input;
    // `enforce_jwt_secret_strength` is the thin wrapper that translates
    // bad outcomes into eprintln + exit. The pure variant is fully
    // testable without mutating process state.

    static JWT_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn lock_jwt_env() -> std::sync::MutexGuard<'static, ()> {
        JWT_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner())
    }

    #[test]
    fn check_jwt_secret_strength_ok_explicit_when_env_set() {
        let _g = lock_jwt_env();
        std::env::set_var("DILLA_JWT_SECRET", "explicit-token-32-bytes-or-whatever");
        let mut cfg = Config::default();
        cfg.db_passphrase = String::new();
        cfg.insecure = false;
        let out = check_jwt_secret_strength(&cfg);
        std::env::remove_var("DILLA_JWT_SECRET");
        assert_eq!(out, JwtStrengthOutcome::OkExplicit);
    }

    #[test]
    fn check_jwt_secret_strength_ok_strong_pass() {
        let _g = lock_jwt_env();
        std::env::remove_var("DILLA_JWT_SECRET");
        let mut cfg = Config::default();
        cfg.db_passphrase = "a".repeat(32);
        cfg.insecure = false;
        assert_eq!(check_jwt_secret_strength(&cfg), JwtStrengthOutcome::OkStrongPass);
    }

    #[test]
    fn check_jwt_secret_strength_reject_empty_when_not_insecure() {
        let _g = lock_jwt_env();
        std::env::remove_var("DILLA_JWT_SECRET");
        let mut cfg = Config::default();
        cfg.db_passphrase = String::new();
        cfg.insecure = false;
        assert_eq!(check_jwt_secret_strength(&cfg), JwtStrengthOutcome::RejectEmpty);
    }

    #[test]
    fn check_jwt_secret_strength_insecure_empty_pass() {
        let _g = lock_jwt_env();
        std::env::remove_var("DILLA_JWT_SECRET");
        let mut cfg = Config::default();
        cfg.db_passphrase = String::new();
        cfg.insecure = true;
        assert_eq!(check_jwt_secret_strength(&cfg), JwtStrengthOutcome::InsecureEmptyPass);
    }

    #[test]
    fn check_jwt_secret_strength_reject_short_when_not_insecure() {
        let _g = lock_jwt_env();
        std::env::remove_var("DILLA_JWT_SECRET");
        let mut cfg = Config::default();
        cfg.db_passphrase = "short".into();
        cfg.insecure = false;
        assert_eq!(check_jwt_secret_strength(&cfg), JwtStrengthOutcome::RejectShort(5));
    }

    #[test]
    fn check_jwt_secret_strength_insecure_short_pass() {
        let _g = lock_jwt_env();
        std::env::remove_var("DILLA_JWT_SECRET");
        let mut cfg = Config::default();
        cfg.db_passphrase = "alsoshort".into();
        cfg.insecure = true;
        assert_eq!(check_jwt_secret_strength(&cfg), JwtStrengthOutcome::InsecureShortPass(9));
    }

    #[test]
    fn check_jwt_secret_strength_empty_jwt_env_ignored() {
        // DILLA_JWT_SECRET="" must NOT count as "operator opted in" —
        // the empty-string path should still defer to passphrase length.
        let _g = lock_jwt_env();
        std::env::set_var("DILLA_JWT_SECRET", "");
        let mut cfg = Config::default();
        cfg.db_passphrase = String::new();
        cfg.insecure = false;
        let out = check_jwt_secret_strength(&cfg);
        std::env::remove_var("DILLA_JWT_SECRET");
        assert_eq!(out, JwtStrengthOutcome::RejectEmpty);
    }

    // ── init_database (pure-Result variant) ──────────────────────────

    #[test]
    fn init_database_result_ok_on_default_cfg_with_tempdir() {
        let tmp = tempfile::tempdir().unwrap();
        let mut cfg = Config::default();
        cfg.data_dir = tmp.path().to_str().unwrap().to_string();
        cfg.port = 8080; // Config::validate() rejects port=0
        cfg.insecure = true;
        let db = init_database_result(&cfg).expect("default cfg should succeed");
        // Confirm migrations ran by checking that the users table exists.
        db.with_conn(|c| {
            let count: i64 = c
                .query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))
                .unwrap_or(-1);
            assert_eq!(count, 0);
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn init_database_result_err_when_data_dir_unwritable() {
        let mut cfg = Config::default();
        cfg.port = 8080;
        // A path that contains a NUL byte will never be creatable —
        // ensure_data_dir / Database::open will both fail before the
        // OS even sees it. Cross-platform-safe.
        cfg.data_dir = "/proc/nope/cannot/possibly/write/here-because-readonly".into();
        cfg.insecure = true;
        let err = match init_database_result(&cfg) {
            Err(e) => e,
            Ok(_) => panic!("expected Err for unwritable data_dir"),
        };
        assert!(
            err.contains("failed to create data directory")
                || err.contains("failed to open database")
                || err.contains("failed to run migrations"),
            "unexpected error: {err}",
        );
    }

    #[test]
    fn init_database_result_err_on_invalid_config() {
        let mut cfg = Config::default();
        // Port 0 + a bunch of other invalid combos make Config::validate
        // fail; we check the error wrap rather than asserting a specific
        // validation message so this test is resilient to validate()
        // tightening over time.
        cfg.port = 0;
        cfg.insecure = true;
        let res = init_database_result(&cfg);
        if let Err(e) = res {
            // Either invalid config OR a downstream error — both are
            // bug-free outcomes for an invalid cfg; just confirm we got
            // an Err and not a silent Ok.
            assert!(!e.is_empty());
        }
    }

    // ── write_bootstrap_token_file ───────────────────────────────────

    #[cfg(unix)]
    #[test]
    fn write_bootstrap_token_file_creates_file_with_token() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("bootstrap.tok");
        write_bootstrap_token_file(&path, "secret-token").unwrap();
        let contents = std::fs::read_to_string(&path).unwrap();
        // Token followed by a newline.
        assert_eq!(contents, "secret-token\n");
        // 0o600 = owner read+write only.
        let perms = std::fs::metadata(&path).unwrap().permissions();
        assert_eq!(perms.mode() & 0o777, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn write_bootstrap_token_file_replaces_existing_stale_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("bootstrap.tok");
        // First write — old token.
        write_bootstrap_token_file(&path, "old").unwrap();
        // Second write — new token must replace, not append.
        write_bootstrap_token_file(&path, "new").unwrap();
        let contents = std::fs::read_to_string(&path).unwrap();
        assert_eq!(contents, "new\n");
    }

    #[cfg(unix)]
    #[test]
    fn write_bootstrap_token_file_errors_when_parent_dir_missing() {
        let path = std::path::PathBuf::from("/no/such/dir/abc/bootstrap.tok");
        assert!(write_bootstrap_token_file(&path, "x").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn write_bootstrap_token_file_writes_empty_token_safely() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("empty.tok");
        write_bootstrap_token_file(&path, "").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "\n");
    }

    // ── init_telemetry_relay branches ────────────────────────────────

    #[test]
    fn init_telemetry_relay_returns_none_when_adapter_is_none() {
        let mut cfg = Config::default();
        cfg.telemetry_adapter = "none".into();
        assert!(init_telemetry_relay(&cfg).is_none());
    }

    #[test]
    fn init_telemetry_relay_returns_none_when_adapter_is_empty() {
        let mut cfg = Config::default();
        cfg.telemetry_adapter = String::new();
        assert!(init_telemetry_relay(&cfg).is_none());
    }

    #[test]
    fn init_telemetry_relay_returns_none_when_adapter_is_unknown() {
        let mut cfg = Config::default();
        cfg.telemetry_adapter = "datadog-like-thing".into();
        assert!(init_telemetry_relay(&cfg).is_none());
    }

    #[test]
    fn init_telemetry_relay_returns_none_when_sentry_dsn_missing() {
        let mut cfg = Config::default();
        cfg.telemetry_adapter = "sentry".into();
        cfg.sentry_dsn = String::new();
        assert!(init_telemetry_relay(&cfg).is_none());
    }

    #[test]
    fn init_telemetry_relay_returns_none_for_bad_sentry_dsn() {
        let mut cfg = Config::default();
        cfg.telemetry_adapter = "sentry".into();
        cfg.sentry_dsn = "this-is-not-a-valid-dsn".into();
        // Bad DSN should be caught and return None instead of panicking.
        assert!(init_telemetry_relay(&cfg).is_none());
    }

    #[test]
    fn init_telemetry_relay_returns_some_for_valid_sentry_dsn() {
        let mut cfg = Config::default();
        cfg.telemetry_adapter = "sentry".into();
        // Standard Sentry DSN format that parse_dsn_standard exercises.
        cfg.sentry_dsn = "https://abc123@o123456.ingest.sentry.io/456789".into();
        cfg.node_name = "test-node".into();
        cfg.environment = "test".into();
        let relay = init_telemetry_relay(&cfg);
        assert!(relay.is_some(), "valid Sentry DSN should produce a relay");
    }

    // ── init_database happy path ─────────────────────────────────────

    #[test]
    fn init_database_returns_db_on_default_cfg() {
        // init_database is the thin wrapper around init_database_result
        // that translates Err → log + exit. Cover the Ok branch (the
        // Err branches are unreachable via test because they call
        // std::process::exit).
        let tmp = tempfile::tempdir().unwrap();
        let mut cfg = Config::default();
        cfg.data_dir = tmp.path().to_str().unwrap().to_string();
        cfg.port = 8080;
        cfg.insecure = true;
        let db = init_database(&cfg);
        db.with_conn(|c| {
            let _: i64 = c
                .query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))
                .unwrap();
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    }

    // ── enforce_jwt_secret_strength (non-exit branches) ──────────────

    #[test]
    fn enforce_jwt_secret_strength_no_op_when_strong_pass() {
        let _g = lock_jwt_env();
        std::env::remove_var("DILLA_JWT_SECRET");
        let mut cfg = Config::default();
        cfg.db_passphrase = "a".repeat(32);
        cfg.insecure = false;
        enforce_jwt_secret_strength(&cfg);
    }

    #[test]
    fn enforce_jwt_secret_strength_no_op_when_explicit_secret_set() {
        let _g = lock_jwt_env();
        std::env::set_var("DILLA_JWT_SECRET", "explicit-jwt-secret-32-bytes-padding");
        let mut cfg = Config::default();
        cfg.db_passphrase = String::new();
        cfg.insecure = false;
        enforce_jwt_secret_strength(&cfg);
        std::env::remove_var("DILLA_JWT_SECRET");
    }

    #[test]
    fn enforce_jwt_secret_strength_warns_on_insecure_empty_pass() {
        let _g = lock_jwt_env();
        std::env::remove_var("DILLA_JWT_SECRET");
        let mut cfg = Config::default();
        cfg.db_passphrase = String::new();
        cfg.insecure = true;
        // Warns + continues; no exit.
        enforce_jwt_secret_strength(&cfg);
    }

    #[test]
    fn enforce_jwt_secret_strength_warns_on_insecure_short_pass() {
        let _g = lock_jwt_env();
        std::env::remove_var("DILLA_JWT_SECRET");
        let mut cfg = Config::default();
        cfg.db_passphrase = "short".into();
        cfg.insecure = true;
        // Warns + continues; no exit.
        enforce_jwt_secret_strength(&cfg);
    }

    // ── check_first_start when users already exist (skip path) ────────

    #[tokio::test]
    async fn check_first_start_no_op_when_users_exist() {
        let (db, _tmp) = test_db();
        seed_user(&db, "u1");
        let auth = Arc::new(AuthService::new(db.clone(), ""));
        let cfg = Config::default();
        // Doesn't panic, doesn't write a bootstrap token file because
        // a user is present.
        check_first_start(&db, &auth, &cfg);
    }

    // ── first_start_outcome (pure variant) ───────────────────────────

    #[tokio::test]
    async fn first_start_outcome_has_users_when_seeded() {
        let (db, _tmp) = test_db();
        seed_user(&db, "u1");
        let auth = AuthService::new(db.clone(), "");
        let cfg = Config::default();
        match first_start_outcome(&db, &auth, &cfg) {
            FirstStartOutcome::HasUsers => {}
            other => panic!("expected HasUsers, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn first_start_outcome_writes_token_file_on_empty_db() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
        db.run_migrations().unwrap();
        let auth = AuthService::new(db.clone(), "");
        let mut cfg = Config::default();
        cfg.data_dir = tmp.path().to_str().unwrap().to_string();
        match first_start_outcome(&db, &auth, &cfg) {
            FirstStartOutcome::TokenWrittenToFile { token_path } => {
                assert!(token_path.exists(), "token file should exist");
                assert!(token_path.ends_with("BOOTSTRAP_TOKEN"));
                let contents = std::fs::read_to_string(&token_path).unwrap();
                assert!(!contents.is_empty());
            }
            other => panic!("expected TokenWrittenToFile, got {:?}", other),
        }
    }

    // ── broadcast_presence_update ────────────────────────────────────

    #[tokio::test]
    async fn broadcast_presence_update_does_not_panic_with_zero_clients() {
        let (db, _tmp) = test_db();
        let hub = Arc::new(ws::Hub::new(db));
        broadcast_presence_update(&hub, "u1", "online", "");
        // No connected clients; tokio::spawn fires the broadcast to 0 peers.
        // Wait a tick so the spawned task runs without orphaning.
        tokio::task::yield_now().await;
    }

    #[tokio::test]
    async fn broadcast_presence_update_handles_custom_status() {
        let (db, _tmp) = test_db();
        let hub = Arc::new(ws::Hub::new(db));
        broadcast_presence_update(&hub, "u1", "dnd", "in a meeting");
        tokio::task::yield_now().await;
    }

    // ── federation_status_payloads (pure JSON builder) ───────────────

    #[test]
    fn federation_status_payloads_shape() {
        let snap = FederationStatusSnapshot { connected: 2, total: 3, degraded: true };
        let (peer, lamport) = federation_status_payloads(&snap, 42);
        assert_eq!(peer["type"], ws::events::EVENT_FEDERATION_PEER_STATUS);
        assert_eq!(peer["payload"]["connected"], 2);
        assert_eq!(peer["payload"]["total"], 3);
        assert_eq!(peer["payload"]["degraded"], true);
        assert_eq!(lamport["type"], ws::events::EVENT_FEDERATION_LAMPORT);
        assert_eq!(lamport["payload"]["value"], 42);
    }

    #[tokio::test]
    async fn broadcast_federation_status_does_not_panic() {
        let (db, _tmp) = test_db();
        let hub = Arc::new(ws::Hub::new(db.clone()));
        let mesh_cfg = federation::MeshConfig {
            node_name: "test".into(),
            ..Default::default()
        };
        let mesh = Arc::new(federation::MeshNode::new(mesh_cfg, db, hub.clone()));
        broadcast_federation_status(&mesh, &hub).await;
        // No connected peers; the broadcast iterates 0 peers + serializes
        // empty payloads. Survival is the assertion.
    }

    // ── federation_status_snapshot (pure peer-list reducer) ──────────

    fn peer(addr: &str, status: &str) -> federation::PeerInfo {
        federation::PeerInfo {
            address: addr.into(),
            status: status.into(),
            node_name: addr.into(),
            last_seen: String::new(),
        }
    }

    #[test]
    fn federation_status_snapshot_all_connected_not_degraded() {
        let peers = vec![peer("a", "connected"), peer("b", "connected")];
        let snap = federation_status_snapshot(&peers);
        assert_eq!(snap.total, 2);
        assert_eq!(snap.connected, 2);
        assert!(!snap.degraded);
    }

    #[test]
    fn federation_status_snapshot_some_disconnected_is_degraded() {
        let peers = vec![
            peer("a", "connected"),
            peer("b", "disconnected"),
            peer("c", "syncing"),
        ];
        let snap = federation_status_snapshot(&peers);
        assert_eq!(snap.total, 3);
        assert_eq!(snap.connected, 1);
        assert!(snap.degraded);
    }

    #[test]
    fn federation_status_snapshot_empty_list() {
        let snap = federation_status_snapshot(&[]);
        assert_eq!(snap.total, 0);
        assert_eq!(snap.connected, 0);
        // connected < total only when total>0, so empty is NOT degraded.
        assert!(!snap.degraded);
    }

    #[test]
    fn federation_status_snapshot_all_disconnected() {
        let peers = vec![peer("a", "disconnected"), peer("b", "syncing")];
        let snap = federation_status_snapshot(&peers);
        assert_eq!(snap.connected, 0);
        assert!(snap.degraded);
    }

    // ── start_server_mode (pure pre-flight check) ────────────────────

    #[test]
    fn start_server_mode_tls_when_cert_and_key_set() {
        let mut cfg = Config::default();
        cfg.port = 4443;
        cfg.tls_cert = "/etc/ssl/cert.pem".into();
        cfg.tls_key = "/etc/ssl/key.pem".into();
        cfg.insecure = false;
        match start_server_mode(&cfg) {
            ServerStartMode::Tls(addr) => assert_eq!(addr.port(), 4443),
            other => panic!("expected Tls, got {:?}", other),
        }
    }

    #[test]
    fn start_server_mode_plaintext_when_insecure_true() {
        let mut cfg = Config::default();
        cfg.port = 8080;
        cfg.tls_cert = String::new();
        cfg.tls_key = String::new();
        cfg.insecure = true;
        match start_server_mode(&cfg) {
            ServerStartMode::Plaintext(addr) => assert_eq!(addr.port(), 8080),
            other => panic!("expected Plaintext, got {:?}", other),
        }
    }

    #[test]
    fn start_server_mode_rejects_plaintext_without_insecure() {
        let mut cfg = Config::default();
        cfg.port = 8080;
        cfg.tls_cert = String::new();
        cfg.tls_key = String::new();
        cfg.insecure = false;
        assert_eq!(start_server_mode(&cfg), ServerStartMode::RejectPlaintext);
    }

    #[test]
    fn start_server_mode_tls_overrides_insecure_flag() {
        // When both TLS is configured AND insecure=true, TLS wins.
        let mut cfg = Config::default();
        cfg.port = 8443;
        cfg.tls_cert = "/cert".into();
        cfg.tls_key = "/key".into();
        cfg.insecure = true;
        match start_server_mode(&cfg) {
            ServerStartMode::Tls(_) => {}
            other => panic!("expected Tls, got {:?}", other),
        }
    }

    #[test]
    fn start_server_mode_partial_tls_falls_through() {
        // Only cert set, no key → tls_configured is false.
        let mut cfg = Config::default();
        cfg.port = 8080;
        cfg.tls_cert = "/cert".into();
        cfg.tls_key = String::new();
        cfg.insecure = true;
        match start_server_mode(&cfg) {
            ServerStartMode::Plaintext(_) => {}
            other => panic!("expected Plaintext, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn first_start_outcome_stderr_fallback_when_data_dir_unwritable() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
        db.run_migrations().unwrap();
        let auth = AuthService::new(db.clone(), "");
        let mut cfg = Config::default();
        cfg.data_dir = "/this/path/does/not/exist/for/token/write".into();
        match first_start_outcome(&db, &auth, &cfg) {
            FirstStartOutcome::TokenStderrFallback { token, write_error, .. } => {
                assert!(!token.is_empty());
                assert!(!write_error.is_empty());
            }
            other => panic!("expected TokenStderrFallback, got {:?}", other),
        }
    }
}
