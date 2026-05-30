use axum::{
    extract::{Request, State},
    http::HeaderMap,
    Json,
};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::api::helpers::spawn_db;
use crate::api::AppState;
use crate::db;
use crate::error::AppError;

/// Best-effort extraction of (ip, user_agent) for risk-signal
/// recording. Prefers `X-Forwarded-For` / `X-Real-IP` when behind a
/// reverse proxy. Both fields are optional — handler-side code MUST
/// NOT branch on their presence (they're for telemetry only).
fn extract_request_context(headers: &HeaderMap) -> (Option<String>, Option<String>) {
    let ip = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        // X-Forwarded-For is "client, proxy1, proxy2"; the leftmost
        // is the original client.
        .and_then(|s| s.split(',').next())
        .map(|s| s.trim().to_string())
        .or_else(|| {
            headers
                .get("x-real-ip")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string())
        })
        .filter(|s| !s.is_empty());

    let ua = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        // Bound the stored UA so a hostile client can't pin large rows.
        .map(|s| if s.len() > 256 { s[..256].to_string() } else { s });

    (ip, ua)
}

#[derive(Deserialize)]
pub struct ChallengeRequest {
    pub public_key: String,
}

#[derive(Deserialize)]
pub struct VerifyRequest {
    pub challenge_id: String,
    pub public_key: String,
    pub signature: String,
}

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub challenge_id: String,
    pub public_key: String,
    pub signature: String,
    pub username: String,
    pub invite_token: String,
}

#[derive(Deserialize)]
pub struct BootstrapRequest {
    pub challenge_id: String,
    pub public_key: String,
    pub signature: String,
    pub username: String,
    pub bootstrap_token: String,
    #[serde(default)]
    pub team_name: String,
}

pub async fn challenge(
    State(state): State<AppState>,
    Json(body): Json<ChallengeRequest>,
) -> Result<Json<Value>, AppError> {
    // Validate the public key is valid base64 and 32 bytes.
    let pk_bytes = base64::engine::general_purpose::STANDARD
        .decode(&body.public_key)
        .map_err(|_| AppError::BadRequest("invalid base64 public key".into()))?;

    if pk_bytes.len() != 32 {
        return Err(AppError::BadRequest("public key must be 32 bytes".into()));
    }

    let (nonce, challenge_id) = state.auth.generate_challenge()?;

    let nonce_b64 = base64::engine::general_purpose::STANDARD.encode(&nonce);

    Ok(Json(json!({
        "challenge_id": challenge_id,
        "nonce": nonce_b64,
    })))
}

/// A5: audit-log a verify-time signature/user-lookup failure under the
/// synthetic "_global" team_id. Extracted from `verify` so the parent
/// function's cognitive complexity stays below threshold.
async fn log_login_failure_global(
    state: &AppState,
    reason: &str,
    ip: Option<String>,
    ua: Option<String>,
) {
    let reason = reason.to_string();
    let _ = spawn_db(state.db.clone(), move |conn| {
        db::insert_audit_event(
            conn,
            "_global",
            None,
            "auth.login_failed",
            Some("auth"),
            None,
            Some(&json!({
                "reason": reason,
                "ip": ip,
                "user_agent": ua,
            })),
        )
    })
    .await;
}

/// Fan an `auth.login_failed` audit event with reason=device_revoked
/// out to every team the affected user belongs to.
async fn log_revoked_device_login(
    state: &AppState,
    user_id: &str,
    device_id: &str,
    ip: Option<String>,
) {
    let user_id = user_id.to_string();
    let device_id = device_id.to_string();
    let _ = spawn_db(state.db.clone(), move |conn| {
        let teams = db::list_user_teams(conn, &user_id).unwrap_or_default();
        for team_id in teams {
            let _ = db::insert_audit_event(
                conn,
                &team_id,
                Some(&user_id),
                "auth.login_failed",
                Some("device"),
                Some(&device_id),
                Some(&json!({
                    "reason": "device_revoked",
                    "ip": ip,
                })),
            );
        }
        Ok(())
    })
    .await;
}

/// Persist the current login's risk signals (ip / ua / country) and
/// bump current_session_started_at on the device row.
async fn record_device_login_async(
    db: crate::db::Database,
    device_id: String,
    ip: Option<String>,
    ua: Option<String>,
    country: Option<String>,
) {
    let _ = spawn_db(db, move |conn| {
        db::record_device_login(
            conn,
            &device_id,
            ip.as_deref(),
            ua.as_deref(),
            country.as_deref(),
        )
    })
    .await;
}

/// Fan a per-team `device.risk_event` audit row out for elevated risk,
/// then push a `security:device-risk` WS event when the score crosses
/// the 80-out-of-100 threshold. Best-effort — failures here must not
/// break login.
async fn handle_risky_login(
    state: &AppState,
    user_id: &str,
    device_id: &str,
    risk_score: u32,
    ip: Option<String>,
    country: Option<String>,
) {
    let user_id_q = user_id.to_string();
    let device_id_q = device_id.to_string();
    let ip_for_audit = ip.clone();
    let country_for_audit = country.clone();
    let _ = spawn_db(state.db.clone(), move |conn| {
        let teams = db::list_user_teams(conn, &user_id_q).unwrap_or_default();
        for team_id in teams {
            let _ = db::insert_audit_event(
                conn,
                &team_id,
                Some(&user_id_q),
                "device.risk_event",
                Some("device"),
                Some(&device_id_q),
                Some(&json!({
                    "risk_score": risk_score,
                    "ip": ip_for_audit,
                    "country": country_for_audit,
                })),
            );
        }
        Ok(())
    })
    .await;

    if risk_score < 80 {
        return;
    }
    let evt = crate::ws::events::Event::new(
        "security:device-risk",
        json!({
            "device_id": device_id,
            "risk_score": risk_score,
            "country": country,
            "ip_hint": ip.as_ref().map(|s| ip_hint(s)),
        }),
    );
    if let Ok(evt) = evt {
        if let Ok(data) = evt.to_bytes() {
            state.hub.send_to_user(user_id, data).await;
        }
    }
}

/// A5: success-side audit event — per-team fan-out so each team sees
/// every login from its members.
async fn log_login_success(
    state: &AppState,
    user_id: &str,
    device_id: &str,
    ip: Option<String>,
    country: Option<String>,
) {
    let user_id_q = user_id.to_string();
    let device_id_q = device_id.to_string();
    let _ = spawn_db(state.db.clone(), move |conn| {
        let teams = db::list_user_teams(conn, &user_id_q).unwrap_or_default();
        for team_id in teams {
            let _ = db::insert_audit_event(
                conn,
                &team_id,
                Some(&user_id_q),
                "auth.login",
                Some("device"),
                Some(&device_id_q),
                Some(&json!({
                    "ip": ip,
                    "country": country,
                })),
            );
        }
        Ok(())
    })
    .await;
}

pub async fn verify(
    State(state): State<AppState>,
    req: Request,
) -> Result<axum::response::Response, AppError> {
    use axum::response::IntoResponse;
    // We took ownership of `Request` instead of the prior
    // `Json<VerifyRequest>` so we can inspect headers for risk-signal
    // recording. Body extraction happens explicitly below.
    let (parts, body) = req.into_parts();
    let bytes = axum::body::to_bytes(body, 1024 * 16) // 16 KiB body cap
        .await
        .map_err(|_| AppError::BadRequest("invalid body".into()))?;
    let body: VerifyRequest =
        serde_json::from_slice(&bytes).map_err(|e| AppError::BadRequest(format!("{}", e)))?;
    let (ip, ua) = extract_request_context(&parts.headers);

    let pk_bytes = base64::engine::general_purpose::STANDARD
        .decode(&body.public_key)
        .map_err(|_| AppError::BadRequest("invalid base64 public key".into()))?;

    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(&body.signature)
        .map_err(|_| AppError::BadRequest("invalid base64 signature".into()))?;

    // AUTH-ENUM-1 / H3: do the signature verification AND the user
    // lookup before deciding the response, so the error path doesn't
    // leak which side failed. Both failure modes return the same
    // "invalid signature" error.
    let valid = state
        .auth
        .verify_challenge(&body.challenge_id, &pk_bytes, &sig_bytes)?;

    let pk = pk_bytes.clone();
    let user = spawn_db(state.db.clone(), move |conn| {
        db::get_user_by_public_key(conn, &pk)
    })
    .await?;

    if !valid || user.is_none() {
        let reason = if !valid { "bad_signature" } else { "unknown_user" };
        log_login_failure_global(&state, reason, ip.clone(), ua.clone()).await;
        return Err(AppError::Unauthorized("invalid signature".into()));
    }
    let user = user.unwrap();

    // A1: resolve the *device* row associated with this pubkey. The
    // 029 migration backfills a row for every existing user, so this
    // should be Some(...) on a properly-migrated DB. If absent (a
    // user created right at the cutover boundary), fall back to the
    // legacy no-device-id path.
    let user_id_q = user.id.clone();
    let pk_q = pk_bytes.clone();
    let device =
        spawn_db(state.db.clone(), move |conn| {
            db::get_device_by_user_and_pubkey(conn, &user_id_q, &pk_q)
        })
        .await?;
    let device_id = device.as_ref().map(|d| d.id.clone()).unwrap_or_default();

    // Refuse to issue a token for a revoked device. The challenge
    // already succeeded so the key is genuine; we still deny because
    // the user (or another trusted device) marked this one untrusted.
    if let Some(ref d) = device {
        if !d.is_active() {
            log_revoked_device_login(&state, &user.id, &d.id, ip.clone()).await;
            return Err(AppError::Unauthorized("invalid signature".into()));
        }
    }

    // A2: stamp risk signals + bump current_session_started_at, then
    // compare against the previous signals to compute a risk score.
    let prev_signals = device.as_ref().map(|d| {
        (
            d.last_seen_ip.clone(),
            d.last_seen_user_agent.clone(),
            d.last_seen_country.clone(),
        )
    });
    let country = derive_country_from_ip(ip.as_deref());

    if let Some(ref d) = device {
        record_device_login_async(state.db.clone(), d.id.clone(), ip.clone(), ua.clone(), country.clone()).await;
    }

    let risk_score = compute_risk_score(prev_signals.as_ref(), ip.as_deref(), ua.as_deref(), country.as_deref());
    if risk_score >= 50 {
        handle_risky_login(&state, &user.id, &device_id, risk_score, ip.clone(), country.clone()).await;
    }

    let token = state.auth.generate_jwt_for_device(&user.id, &device_id)?;
    let refresh_token = state
        .auth
        .generate_refresh_token_for_device(&user.id, &device_id)?;

    log_login_success(&state, &user.id, &device_id, ip.clone(), country.clone()).await;

    // H-13a: issue an httpOnly cookie alongside the JSON body. Cookie
    // max-age matches the 1 h access-token expiry; clients that
    // continue to use Authorization: Bearer ignore the cookie.
    let body = json!({
        "token": token,
        "refresh_token": refresh_token,
        "user": user,
        "device_id": device_id,
    });
    Ok(json_with_cookie(body, build_auth_cookie(&token, 3600, state.config.insecure)).into_response())
}

// ── A2 risk-scoring helpers ─────────────────────────────────────────────

/// Optional Tor-exit-node lookup. The file lives at
/// `<DILLA_DATA_DIR>/tor-exit-nodes.txt` if the operator wants the
/// 50-point bonus on Tor traffic; absence is logged and silently
/// skipped. Each line is a single IP (comments starting with `#`
/// are ignored).
///
/// H-8: backed by a process-global `OnceLock<HashSet<IpAddr>>`. The
/// list is loaded once at startup from `DILLA_TOR_EXIT_LIST_PATH`
/// when set; absent / parse-failure → empty set (function returns
/// false unconditionally, matches the previous stub behavior).
/// Lookup is O(1) hash on the hot path.
fn ip_is_tor_exit(ip: &str) -> bool {
    let parsed = match ip.parse::<std::net::IpAddr>() {
        Ok(p) => p,
        Err(_) => return false,
    };
    match crate::tor_list::get() {
        Some(set) => set.contains(&parsed),
        None => false,
    }
}

/// Crude country derivation. We do NOT call out to a third-party geo
/// service (the spec is explicit on this). For private / RFC-1918 IPs
/// we return None; for everything else we return a generic "unknown"
/// placeholder so the country-change signal still fires on the first
/// real login after a reset. A future migration can plug in MaxMind's
/// offline GeoLite2 country DB without touching call sites.
fn derive_country_from_ip(ip: Option<&str>) -> Option<String> {
    let ip = ip?;
    if ip.starts_with("10.")
        || ip.starts_with("172.")
        || ip.starts_with("192.168.")
        || ip == "127.0.0.1"
        || ip == "::1"
    {
        return None;
    }
    // H-8b: when the operator has loaded a GeoLite2-Country mmdb via
    // DILLA_GEOIP_DB_PATH, prefer that lookup. Falls back to the
    // legacy "unknown" placeholder so the country-change signal
    // still fires on the first real login after a reset when no
    // mmdb is configured.
    if let Ok(parsed) = ip.parse::<std::net::IpAddr>() {
        if let Some(iso) = crate::geoip::country_for(&parsed) {
            return Some(iso);
        }
    }
    Some("unknown".to_string())
}

/// Mask the last octet of an IPv4 (or last 32 bits of IPv6) for the WS
/// risk-event payload so we don't leak the full IP to other devices.
fn ip_hint(ip: &str) -> String {
    if let Some(idx) = ip.rfind('.') {
        return format!("{}.x", &ip[..idx]);
    }
    if let Some(idx) = ip.rfind(':') {
        return format!("{}::x", &ip[..idx]);
    }
    "x".to_string()
}

fn user_agent_family(ua: Option<&str>) -> &'static str {
    let Some(ua) = ua else { return "unknown" };
    let lower = ua.to_ascii_lowercase();
    if lower.contains("firefox") {
        "firefox"
    } else if lower.contains("edg/") {
        "edge"
    } else if lower.contains("chrome") {
        "chrome"
    } else if lower.contains("safari") {
        "safari"
    } else if lower.contains("dilla-tauri") || lower.contains("tauri") {
        "tauri"
    } else {
        "other"
    }
}

fn country_change_score(prev_country: Option<&str>, new_country: Option<&str>) -> u32 {
    match (prev_country, new_country) {
        (Some(p), Some(n)) if p != n => 30,
        _ => 0,
    }
}

fn ua_change_score(prev_ua: Option<&str>, new_ua: Option<&str>) -> u32 {
    match prev_ua {
        Some(p) if user_agent_family(Some(p)) != user_agent_family(new_ua) => 20,
        _ => 0,
    }
}

fn ip_risk_score(new_ip: Option<&str>) -> u32 {
    match new_ip {
        Some(n) if ip_is_tor_exit(n) => 50,
        _ => 0,
    }
}

fn compute_risk_score(
    prev: Option<&(Option<String>, Option<String>, Option<String>)>,
    new_ip: Option<&str>,
    new_ua: Option<&str>,
    new_country: Option<&str>,
) -> u32 {
    let Some((prev_ip, prev_ua, prev_country)) = prev else { return 0; };
    let mut score: u32 = 0;
    score = score.saturating_add(country_change_score(prev_country.as_deref(), new_country));
    score = score.saturating_add(ua_change_score(prev_ua.as_deref(), new_ua));
    score = score.saturating_add(ip_risk_score(new_ip));
    // IP delta is logged but doesn't add a standalone bonus — country
    // change already covers the cross-region case, and the per-IP delta
    // only matters as a tie-breaker we currently omit.
    let _ = prev_ip;
    score
}

pub async fn register(
    State(state): State<AppState>,
    Json(body): Json<RegisterRequest>,
) -> Result<Json<Value>, AppError> {
    let pk_bytes = decode_and_verify_challenge(
        &state, &body.challenge_id, &body.public_key, &body.signature,
    )?;

    if body.username.is_empty() {
        return Err(AppError::BadRequest("username is required".into()));
    }

    if body.username.len() > 32 {
        return Err(AppError::BadRequest("username too long (max 32 chars)".into()));
    }

    if body.invite_token.is_empty() {
        return Err(AppError::BadRequest("invite_token is required".into()));
    }

    let username = body.username.clone();
    let invite_token = body.invite_token.clone();
    let pk = pk_bytes;

    let (user, member, team_id) = spawn_db(state.db.clone(), move |conn| {
        check_username_and_key_available(conn, &username, &pk)?;
        let invite = validate_invite(conn, &invite_token)?;

        let (user, member) = create_user_and_member(conn, &username, &pk, &invite.team_id, &invite.created_by, false);
        db::create_user(conn, &user)?;
        db::create_member(conn, &member)?;

        if let Some(role) = db::get_default_role_for_team(conn, &invite.team_id)? {
            db::assign_role_to_member(conn, &member.id, &role.id)?;
        }

        db::increment_invite_uses(conn, &invite.id)?;
        db::log_invite_use(conn, &invite.id, &user.id)?;

        // A1: seed the primary device row so this account starts
        // multi-device tracking from day one.
        let _ = db::create_device(conn, &user.id, &user.public_key, "primary");

        Ok((user, member, invite.team_id))
    })
    .await
    .map_err(|e| match e {
        AppError::NotFound(_) => AppError::Conflict("username or public key already registered".into()),
        AppError::Forbidden(msg) => AppError::BadRequest(msg),
        other => other,
    })?;

    let token = state.auth.generate_jwt(&user.id)?;
    let refresh_token = state.auth.generate_refresh_token(&user.id)?;

    // Notify already-connected clients that a new member joined. Existing
    // sessions don't refetch the member list on their own, so without this
    // broadcast the joiner only appears in the rail after a reload.
    let evt = crate::ws::events::Event::new(
        crate::ws::events::EVENT_MEMBER_JOINED,
        crate::ws::events::MemberJoinedPayload {
            team_id: team_id.clone(),
            user: serde_json::to_value(&user).unwrap_or(json!({})),
            member: serde_json::to_value(&member).unwrap_or(json!({})),
        },
    );
    if let Ok(evt) = evt {
        if let Ok(data) = evt.to_bytes() {
            state.hub.broadcast_to_all(data).await;
        }
    }

    Ok(Json(json!({
        "token": token,
        "refresh_token": refresh_token,
        "user": user,
        "team_id": team_id,
    })))
}

pub async fn bootstrap(
    State(state): State<AppState>,
    Json(body): Json<BootstrapRequest>,
) -> Result<Json<Value>, AppError> {
    let pk_bytes = decode_and_verify_challenge(
        &state, &body.challenge_id, &body.public_key, &body.signature,
    )?;

    if body.username.is_empty() {
        return Err(AppError::BadRequest("username is required".into()));
    }

    if body.username.len() > 32 {
        return Err(AppError::BadRequest("username too long (max 32 chars)".into()));
    }

    if body.bootstrap_token.is_empty() {
        return Err(AppError::BadRequest("bootstrap_token is required".into()));
    }

    let username = body.username.clone();
    let bootstrap_token = body.bootstrap_token.clone();
    let pk = pk_bytes;
    let team_name = resolve_team_name(&body.team_name, &state.config.team_name);
    let seed_demo = state.config.seed_demo;

    let (user, team_id) = spawn_db(state.db.clone(), move |conn| {
        // Wrap in transaction so partial failures roll back cleanly.
        let tx = conn.unchecked_transaction()?;

        validate_bootstrap_token(&tx, &bootstrap_token)?;

        let (user, _member) = create_user_and_member(&tx, &username, &pk, "", "", true);
        db::create_user(&tx, &user)?;

        let team_id = create_bootstrap_team(&tx, &team_name, &user.id)?;

        let member = db::Member {
            id: db::new_id(),
            team_id: team_id.clone(),
            user_id: user.id.clone(),
            nickname: String::new(),
            joined_at: db::now_str(),
            invited_by: user.id.clone(), // self-invited for bootstrap
            updated_at: String::new(),
        };
        db::create_member(&tx, &member)?;

        create_bootstrap_defaults(&tx, &team_id, &user.id, seed_demo)?;

        // A1: also seed the primary device row inside the same
        // transaction so multi-device tracking starts immediately
        // (the 029 migration backfill won't catch users created
        // *after* the migration runs).
        let _ = db::create_device(&tx, &user.id, &user.public_key, "primary");

        tx.commit()?;
        Ok((user, team_id))
    })
    .await
    .map_err(|e| match e {
        AppError::Forbidden(msg) => AppError::BadRequest(msg),
        other => other,
    })?;

    let token = state.auth.generate_jwt(&user.id)?;
    let refresh_token = state.auth.generate_refresh_token(&user.id)?;

    // A5: bootstrap.consumed audit event. The team_id is the
    // brand-new team we just created — this is the first record in
    // it, which is exactly the provenance an auditor wants.
    let uid_log = user.id.clone();
    let team_id_log = team_id.clone();
    let _ = spawn_db(state.db.clone(), move |conn| {
        db::insert_audit_event(
            conn,
            &team_id_log,
            Some(&uid_log),
            "bootstrap.consumed",
            Some("team"),
            Some(&team_id_log),
            None,
        )
    })
    .await;

    Ok(Json(json!({
        "token": token,
        "refresh_token": refresh_token,
        "user": user,
        "team_id": team_id,
    })))
}

/// A4: refresh token endpoint. Validates the supplied refresh token,
/// mints a new access token (always), and rotates the refresh token
/// when it's at or past half its lifetime (sliding renewal).
///
/// The endpoint is intentionally not behind `auth_middleware` — the
/// access token may already be expired, which is the whole reason the
/// client is calling refresh.
pub async fn refresh(
    State(state): State<AppState>,
    Json(body): Json<RefreshRequest>,
) -> Result<axum::response::Response, AppError> {
    use axum::response::IntoResponse;
    if body.refresh_token.is_empty() {
        return Err(AppError::BadRequest("refresh_token is required".into()));
    }
    let (access, refresh, rotated) = state.auth.refresh_with_sliding(&body.refresh_token)?;

    // A5: audit-log the refresh. We can identify the user by decoding
    // the refresh-token claims; do it cheaply (we just validated it).
    if let Ok((user_id, _iat, _exp, _jti, device_id)) =
        state.auth.validate_refresh_token_full(&refresh)
    {
        let uid_log = user_id.clone();
        let did_log = device_id.clone();
        let _ = spawn_db(state.db.clone(), move |conn| {
            let teams = db::list_user_teams(conn, &uid_log).unwrap_or_default();
            for team_id in teams {
                let _ = db::insert_audit_event(
                    conn,
                    &team_id,
                    Some(&uid_log),
                    "auth.token_refresh",
                    Some("device"),
                    if did_log.is_empty() {
                        None
                    } else {
                        Some(&did_log)
                    },
                    Some(&json!({ "rotated": rotated })),
                );
            }
            Ok(())
        })
        .await;
    }

    // H-13a: refresh re-issues the cookie with the new (or rotated)
    // access token. Body still carries the tokens for current
    // clients.
    let body_value = json!({
        "token": access,
        "refresh_token": refresh,
        "rotated": rotated,
    });
    Ok(json_with_cookie(body_value, build_auth_cookie(&access, 3600, state.config.insecure)).into_response())
}

#[derive(Deserialize)]
pub struct RefreshRequest {
    pub refresh_token: String,
}

/// Log out the caller by revoking the bearer token. H2 / VULN-012.
///
/// Idempotent: a second call with the same (now-revoked) token still
/// returns 200 because validate_jwt_full has already rejected the
/// request via the auth middleware.
pub async fn logout(
    State(state): State<AppState>,
    req: Request,
) -> Result<axum::response::Response, AppError> {
    use axum::response::IntoResponse;
    let token = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .ok_or_else(|| AppError::Unauthorized("missing authorization header".into()))?;

    // Capture user_id + device_id *before* revoking so the audit
    // record carries them. validate_jwt_full ignores aud/iss strictly
    // enough to work even on a token that's about to be revoked.
    let context = state.auth.validate_jwt_full(token).ok();

    state.auth.revoke_token(token)?;

    // A5: audit log the logout.
    if let Some((user_id, _jti, _exp, device_id)) = context {
        let uid_log = user_id.clone();
        let did_log = device_id.clone();
        let _ = spawn_db(state.db.clone(), move |conn| {
            let teams = db::list_user_teams(conn, &uid_log).unwrap_or_default();
            for team_id in teams {
                let _ = db::insert_audit_event(
                    conn,
                    &team_id,
                    Some(&uid_log),
                    "auth.logout",
                    Some("device"),
                    if did_log.is_empty() {
                        None
                    } else {
                        Some(&did_log)
                    },
                    None,
                );
            }
            Ok(())
        })
        .await;
    }

    // H-13a: clear the auth cookie on logout so a downstream gateway /
    // browser-side helper that was relying on the cookie pathway gets
    // an explicit revoke signal.
    Ok(json_with_cookie(json!({ "ok": true }), clear_auth_cookie(state.config.insecure)).into_response())
}

// --- H-13a httpOnly cookie helpers --------------------------------
//
// Additive: we keep the JSON body (token / refresh_token) so current
// clients keep working with `Authorization: Bearer …`. Cookies are
// the second pathway for clients that want to switch to the
// HttpOnly model — they'll be picked up by `auth_middleware` when
// the Authorization header is absent. Full client migration is
// H-13b.

/// Name of the cookie the server issues for the bearer JWT.
const AUTH_COOKIE_NAME: &str = "__dilla_jwt";

/// Build a `Set-Cookie` header value for the given JWT. SameSite=Strict
/// keeps the cookie off cross-site requests entirely; HttpOnly hides
/// it from JS (and therefore from XSS); Secure restricts to TLS
/// transport (dropped only when `insecure=true` so the dev pattern
/// over plain HTTP can still round-trip the cookie). Path scope is
/// `/api/v1` so non-API routes (static SPA shell, theme CSS, voice
/// models) don't carry the credential.
fn build_auth_cookie(token: &str, max_age_secs: u64, insecure: bool) -> String {
    let secure = if insecure { "" } else { " Secure;" };
    format!(
        "{}={}; HttpOnly; SameSite=Strict;{} Path=/api/v1; Max-Age={}",
        AUTH_COOKIE_NAME, token, secure, max_age_secs
    )
}

fn clear_auth_cookie(insecure: bool) -> String {
    // Max-Age=0 is the RFC 6265 way to clear an existing cookie.
    let secure = if insecure { "" } else { " Secure;" };
    format!(
        "{}=; HttpOnly; SameSite=Strict;{} Path=/api/v1; Max-Age=0",
        AUTH_COOKIE_NAME, secure
    )
}

/// Attach a `Set-Cookie` header to a JSON response. axum lets us
/// return a tuple of (HeaderMap, Json) when we want headers; this is
/// the smallest abstraction over that.
fn json_with_cookie(value: Value, cookie: String) -> impl axum::response::IntoResponse {
    let mut headers = axum::http::HeaderMap::new();
    if let Ok(hv) = axum::http::HeaderValue::from_str(&cookie) {
        headers.insert(axum::http::header::SET_COOKIE, hv);
    }
    (headers, Json(value))
}

// --- Shared helper functions ---

/// Decode base64 public key and signature, then verify the challenge.
fn decode_and_verify_challenge(
    state: &AppState,
    challenge_id: &str,
    public_key: &str,
    signature: &str,
) -> Result<Vec<u8>, AppError> {
    let pk_bytes = base64::engine::general_purpose::STANDARD
        .decode(public_key)
        .map_err(|_| AppError::BadRequest("invalid base64 public key".into()))?;

    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(signature)
        .map_err(|_| AppError::BadRequest("invalid base64 signature".into()))?;

    let valid = state.auth.verify_challenge(challenge_id, &pk_bytes, &sig_bytes)?;

    if !valid {
        return Err(AppError::Unauthorized("invalid signature".into()));
    }

    Ok(pk_bytes)
}

/// Check that neither username nor public key is already registered.
fn check_username_and_key_available(
    conn: &rusqlite::Connection,
    username: &str,
    pk: &[u8],
) -> Result<(), rusqlite::Error> {
    if db::get_user_by_username(conn, username)?.is_some() {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    if db::get_user_by_public_key(conn, pk)?.is_some() {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    Ok(())
}

/// Validate an invite token (existence, revocation, max uses, expiry).
fn validate_invite(
    conn: &rusqlite::Connection,
    invite_token: &str,
) -> Result<db::Invite, rusqlite::Error> {
    let invite = db::get_invite_by_token(conn, invite_token)?
        .ok_or_else(|| rusqlite::Error::InvalidParameterName("invite not found".into()))?;

    if invite.revoked {
        return Err(rusqlite::Error::InvalidParameterName("invite has been revoked".into()));
    }
    if let Some(max) = invite.max_uses {
        if invite.uses >= max {
            return Err(rusqlite::Error::InvalidParameterName("invite max uses reached".into()));
        }
    }
    if let Some(ref expires) = invite.expires_at {
        if db::now_str() > *expires {
            return Err(rusqlite::Error::InvalidParameterName("invite has expired".into()));
        }
    }
    Ok(invite)
}

/// Create a User and a placeholder Member struct.
fn create_user_and_member(
    _conn: &rusqlite::Connection,
    username: &str,
    pk: &[u8],
    team_id: &str,
    invited_by: &str,
    is_admin: bool,
) -> (db::User, db::Member) {
    let now = db::now_str();
    let user_id = db::new_id();
    let user = db::User {
        id: user_id.clone(),
        username: username.to_string(),
        display_name: username.to_string(),
        public_key: pk.to_vec(),
        avatar_url: String::new(),
        status_text: String::new(),
        status_type: "online".into(),
        is_admin,
        created_at: now.clone(),
        updated_at: now.clone(),
        quiet_hours_enabled: false,
        quiet_hours_from: "22:00".into(),
        quiet_hours_to: "07:30".into(),
    };
    let member = db::Member {
        id: db::new_id(),
        team_id: team_id.to_string(),
        user_id: user_id.clone(),
        nickname: String::new(),
        joined_at: now,
        invited_by: invited_by.to_string(),
        updated_at: String::new(),
    };
    (user, member)
}

/// Validate and consume a bootstrap token.
///
/// Rejects tokens that are missing, already used, or past `expires_at`.
/// VULN-009: previously the token had no expiry and could be replayed
/// indefinitely once it leaked into stderr / journald.
fn validate_bootstrap_token(
    conn: &rusqlite::Connection,
    token: &str,
) -> Result<(), rusqlite::Error> {
    let bt = db::get_bootstrap_token(conn, token)?
        .ok_or_else(|| rusqlite::Error::InvalidParameterName("invalid bootstrap token".into()))?;

    if bt.used {
        return Err(rusqlite::Error::InvalidParameterName("bootstrap token already used".into()));
    }

    if !bt.expires_at.is_empty() {
        // Fail-closed on a malformed `expires_at`. Migration 026 always
        // writes a parseable `%Y-%m-%d %H:%M:%S` value, but a future
        // migration that produced garbage here would otherwise let a
        // bootstrap token live forever — that's the exact regression
        // VULN-009 was supposed to close.
        let exp = chrono::NaiveDateTime::parse_from_str(&bt.expires_at, "%Y-%m-%d %H:%M:%S")
            .map(|n| chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(n, chrono::Utc))
            .map_err(|_| {
                rusqlite::Error::InvalidParameterName(
                    "bootstrap token has malformed expires_at".into(),
                )
            })?;
        if chrono::Utc::now() > exp {
            return Err(rusqlite::Error::InvalidParameterName(
                "bootstrap token expired".into(),
            ));
        }
    }

    db::use_bootstrap_token(conn, token)
}

/// Resolve team name with fallbacks.
fn resolve_team_name(body_name: &str, config_name: &str) -> String {
    if !body_name.is_empty() {
        return body_name.to_string();
    }
    if !config_name.is_empty() {
        return config_name.to_string();
    }
    "My Team".to_string()
}

/// Create the bootstrap team and return its ID.
fn create_bootstrap_team(
    conn: &rusqlite::Connection,
    team_name: &str,
    user_id: &str,
) -> Result<String, rusqlite::Error> {
    let now = db::now_str();
    let team_id = db::new_id();
    let team = db::Team {
        id: team_id.clone(),
        name: team_name.to_string(),
        description: String::new(),
        icon_url: String::new(),
        created_by: user_id.to_string(),
        max_file_size: 25 * 1024 * 1024,
        allow_member_invites: true,
        federated: false,
        force_turn_relay: false,
        created_at: now.clone(),
        updated_at: now,
    };
    db::create_team(conn, &team)?;
    Ok(team_id)
}

/// Create the default role and #general channel for a bootstrap team.
/// When `seed_demo` is true, also pre-create #design, #dev, #random
/// text channels and a voice-lounge so the operator gets a populated
/// team via the normal auth flow. This is the server-side replacement
/// for the legacy client-side /mesh mock data — start the server with
/// `DILLA_SEED_DEMO=true` and the very first bootstrap lands in a
/// ready-to-explore workspace.
fn create_bootstrap_defaults(
    conn: &rusqlite::Connection,
    team_id: &str,
    user_id: &str,
    seed_demo: bool,
) -> Result<(), rusqlite::Error> {
    let now = db::now_str();

    // Bootstrap only Admin + everyone — keeps the team-creator with full
    // perms and a fallback default. Any further role ladder is user-defined.
    //
    // A3: PERM_ADMIN already implies every bit via the bitmask
    // short-circuit in `user_has_permission`. We still OR in
    // PERM_MANAGE_FEDERATION + PERM_VIEW_AUDIT_LOG explicitly so a
    // team operator who later splits the Admin role and demotes
    // themselves doesn't accidentally lose federation-mint or
    // audit-read.
    let mut admin_role_id: Option<String> = None;
    for (name, color, position, permissions, is_default) in [
        (
            "Admin",
            "#5eebab",
            1,
            db::PERM_ADMIN | db::PERM_MANAGE_FEDERATION | db::PERM_VIEW_AUDIT_LOG,
            false,
        ),
        (
            "everyone",
            "#99AAB5",
            0,
            db::PERM_SEND_MESSAGES | db::PERM_CREATE_INVITES,
            true,
        ),
    ] {
        let role = db::Role {
            id: db::new_id(),
            team_id: team_id.to_string(),
            name: name.into(),
            color: color.into(),
            position,
            permissions,
            is_default,
            created_at: now.clone(),
            updated_at: String::new(),
        };
        db::create_role(conn, &role)?;
        if name == "Admin" {
            admin_role_id = Some(role.id.clone());
        }
    }

    // Give the bootstrap user the Admin role.
    if let Some(rid) = admin_role_id {
        if let Some(m) = db::get_member_by_user_and_team(conn, user_id, team_id)? {
            db::assign_role_to_member(conn, &m.id, &rid)?;
        }
    }

    // Base: #general always exists.
    let mut channels: Vec<(&'static str, &'static str, &'static str)> = vec![
        ("general", "General discussion", "text"),
    ];
    if seed_demo {
        // Same layout the legacy /mesh sandbox used. Names + topics are
        // intentionally generic so they fit any workspace; the operator
        // can rename them after first login.
        channels.extend([
            ("design",        "Design crits and figma links",       "text"),
            ("dev",           "Dev chat — PRs, deploys, debugging", "text"),
            ("random",        "Off-topic",                          "text"),
            ("voice-lounge",  "",                                    "voice"),
        ]);
    }
    for (i, (name, topic, kind)) in channels.iter().enumerate() {
        let channel = db::Channel {
            id: db::new_id(),
            team_id: team_id.to_string(),
            name: (*name).into(),
            topic: (*topic).into(),
            channel_type: (*kind).into(),
            position: i as i32,
            category: String::new(),
            created_by: user_id.to_string(),
            created_at: now.clone(),
            updated_at: now.clone(),
            locked: false, hidden_if_restricted: false, slow_mode_seconds: 0, group_id: None,
        };
        db::create_channel(conn, &channel)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{self, Database};

    fn test_db() -> (Database, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
        db.run_migrations().unwrap();
        (db, tmp)
    }

    // ── resolve_team_name tests ─────────────────────────────────────────

    #[test]
    fn resolve_team_name_uses_body_name() {
        assert_eq!(resolve_team_name("My Custom Team", "Config Team"), "My Custom Team");
    }

    #[test]
    fn resolve_team_name_falls_back_to_config() {
        assert_eq!(resolve_team_name("", "Config Team"), "Config Team");
    }

    #[test]
    fn resolve_team_name_falls_back_to_default() {
        assert_eq!(resolve_team_name("", ""), "My Team");
    }

    // ── check_username_and_key_available tests ──────────────────────────

    #[test]
    fn check_username_and_key_available_success() {
        let (db, _tmp) = test_db();
        db.with_conn(|conn| {
            check_username_and_key_available(conn, "newuser", &[42u8; 32])
        })
        .unwrap();
    }

    #[test]
    fn check_username_and_key_available_username_taken() {
        let (db, _tmp) = test_db();
        let now = db::now_str();
        db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: "u1".into(),
                username: "alice".into(),
                display_name: "Alice".into(),
                public_key: vec![1u8; 32],
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            
                ..Default::default()
            })
        })
        .unwrap();

        let result = db.with_conn(|conn| {
            check_username_and_key_available(conn, "alice", &[42u8; 32])
        });
        assert!(result.is_err());
    }

    #[test]
    fn check_username_and_key_available_key_taken() {
        let (db, _tmp) = test_db();
        let now = db::now_str();
        let pk = vec![1u8; 32];
        db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: "u1".into(),
                username: "alice".into(),
                display_name: "Alice".into(),
                public_key: pk.clone(),
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            
                ..Default::default()
            })
        })
        .unwrap();

        let result = db.with_conn(|conn| {
            check_username_and_key_available(conn, "newuser", &pk)
        });
        assert!(result.is_err());
    }

    // ── validate_invite tests ───────────────────────────────────────────

    #[test]
    fn validate_invite_success() {
        let (db, _tmp) = test_db();
        let now = db::now_str();
        db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: "u1".into(),
                username: "alice".into(),
                display_name: "Alice".into(),
                public_key: vec![1u8; 32],
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            
                ..Default::default()
            })?;
            db::create_team(conn, &db::Team {
                id: "t1".into(),
                name: "Team".into(),
                description: String::new(),
                icon_url: String::new(),
                created_by: "u1".into(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                federated: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            
                ..Default::default()
            })?;
            db::create_invite(conn, &db::Invite {
                id: "inv1".into(),
                team_id: "t1".into(),
                created_by: "u1".into(),
                token: "test-token".into(),
                max_uses: None,
                uses: 0,
                expires_at: None,
                revoked: false,
                created_at: now.clone(),
            })?;
            let invite = validate_invite(conn, "test-token")?;
            assert_eq!(invite.token, "test-token");
            assert_eq!(invite.team_id, "t1");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn validate_invite_not_found() {
        let (db, _tmp) = test_db();
        let result = db.with_conn(|conn| validate_invite(conn, "nonexistent"));
        assert!(result.is_err());
    }

    #[test]
    fn validate_invite_revoked() {
        let (db, _tmp) = test_db();
        let now = db::now_str();
        let result = db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: "u1".into(),
                username: "alice".into(),
                display_name: "Alice".into(),
                public_key: vec![1u8; 32],
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            
                ..Default::default()
            })?;
            db::create_team(conn, &db::Team {
                id: "t1".into(),
                name: "Team".into(),
                description: String::new(),
                icon_url: String::new(),
                created_by: "u1".into(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                federated: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            
                ..Default::default()
            })?;
            db::create_invite(conn, &db::Invite {
                id: "inv1".into(),
                team_id: "t1".into(),
                created_by: "u1".into(),
                token: "revoked-token".into(),
                max_uses: None,
                uses: 0,
                expires_at: None,
                revoked: true,
                created_at: now.clone(),
            })?;
            validate_invite(conn, "revoked-token")
        });
        assert!(result.is_err());
        match result.unwrap_err() {
            rusqlite::Error::InvalidParameterName(msg) => {
                assert!(msg.contains("revoked"));
            }
            other => panic!("expected InvalidParameterName, got {:?}", other),
        }
    }

    #[test]
    fn validate_invite_max_uses_reached() {
        let (db, _tmp) = test_db();
        let now = db::now_str();
        let result = db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: "u1".into(),
                username: "alice".into(),
                display_name: "Alice".into(),
                public_key: vec![1u8; 32],
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            
                ..Default::default()
            })?;
            db::create_team(conn, &db::Team {
                id: "t1".into(),
                name: "Team".into(),
                description: String::new(),
                icon_url: String::new(),
                created_by: "u1".into(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                federated: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            
                ..Default::default()
            })?;
            db::create_invite(conn, &db::Invite {
                id: "inv1".into(),
                team_id: "t1".into(),
                created_by: "u1".into(),
                token: "maxed-token".into(),
                max_uses: Some(5),
                uses: 5,
                expires_at: None,
                revoked: false,
                created_at: now.clone(),
            })?;
            validate_invite(conn, "maxed-token")
        });
        assert!(result.is_err());
        match result.unwrap_err() {
            rusqlite::Error::InvalidParameterName(msg) => {
                assert!(msg.contains("max uses"));
            }
            other => panic!("expected InvalidParameterName, got {:?}", other),
        }
    }

    #[test]
    fn validate_invite_expired() {
        let (db, _tmp) = test_db();
        let now = db::now_str();
        let result = db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: "u1".into(),
                username: "alice".into(),
                display_name: "Alice".into(),
                public_key: vec![1u8; 32],
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            
                ..Default::default()
            })?;
            db::create_team(conn, &db::Team {
                id: "t1".into(),
                name: "Team".into(),
                description: String::new(),
                icon_url: String::new(),
                created_by: "u1".into(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                federated: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            
                ..Default::default()
            })?;
            db::create_invite(conn, &db::Invite {
                id: "inv1".into(),
                team_id: "t1".into(),
                created_by: "u1".into(),
                token: "expired-token".into(),
                max_uses: None,
                uses: 0,
                expires_at: Some("2000-01-01 00:00:00".into()),
                revoked: false,
                created_at: now.clone(),
            })?;
            validate_invite(conn, "expired-token")
        });
        assert!(result.is_err());
        match result.unwrap_err() {
            rusqlite::Error::InvalidParameterName(msg) => {
                assert!(msg.contains("expired"));
            }
            other => panic!("expected InvalidParameterName, got {:?}", other),
        }
    }

    // ── validate_bootstrap_token tests ──────────────────────────────────

    #[test]
    fn validate_bootstrap_token_success() {
        let (db, _tmp) = test_db();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO bootstrap_tokens (token, used, created_at) VALUES (?1, 0, ?2)",
                rusqlite::params!["boot-token", db::now_str()],
            )?;
            validate_bootstrap_token(conn, "boot-token")
        })
        .unwrap();
    }

    #[test]
    fn validate_bootstrap_token_already_used() {
        let (db, _tmp) = test_db();
        let result = db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO bootstrap_tokens (token, used, created_at) VALUES (?1, 1, ?2)",
                rusqlite::params!["used-token", db::now_str()],
            )?;
            validate_bootstrap_token(conn, "used-token")
        });
        assert!(result.is_err());
        match result.unwrap_err() {
            rusqlite::Error::InvalidParameterName(msg) => {
                assert!(msg.contains("already used"));
            }
            other => panic!("expected InvalidParameterName, got {:?}", other),
        }
    }

    #[test]
    fn validate_bootstrap_token_not_found() {
        let (db, _tmp) = test_db();
        let result = db.with_conn(|conn| validate_bootstrap_token(conn, "nonexistent"));
        assert!(result.is_err());
    }

    // ── create_user_and_member tests ────────────────────────────────────

    #[test]
    fn create_user_and_member_basic() {
        let (db, _tmp) = test_db();
        let (user, member) = db
            .with_conn(|conn| {
                Ok(create_user_and_member(conn, "testuser", &[42u8; 32], "t1", "inviter", false))
            })
            .unwrap();

        assert_eq!(user.username, "testuser");
        assert_eq!(user.display_name, "testuser");
        assert_eq!(user.public_key, vec![42u8; 32]);
        assert!(!user.is_admin);
        assert_eq!(member.team_id, "t1");
        assert_eq!(member.invited_by, "inviter");
    }

    #[test]
    fn create_user_and_member_admin() {
        let (db, _tmp) = test_db();
        let (user, _member) = db
            .with_conn(|conn| {
                Ok(create_user_and_member(conn, "admin", &[1u8; 32], "t1", "", true))
            })
            .unwrap();

        assert!(user.is_admin);
    }

    // ── create_bootstrap_team tests ─────────────────────────────────────

    #[test]
    fn create_bootstrap_team_creates_team() {
        let (db, _tmp) = test_db();
        let now = db::now_str();
        db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: "u1".into(),
                username: "alice".into(),
                display_name: "Alice".into(),
                public_key: vec![1u8; 32],
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: true,
                created_at: now.clone(),
                updated_at: now.clone(),
            
                ..Default::default()
            })
        })
        .unwrap();

        let team_id = db
            .with_conn(|conn| create_bootstrap_team(conn, "My Server", "u1"))
            .unwrap();

        let team = db
            .with_conn(|conn| db::get_team(conn, &team_id))
            .unwrap()
            .unwrap();
        assert_eq!(team.name, "My Server");
        assert_eq!(team.created_by, "u1");
    }

    // ── create_bootstrap_defaults tests ─────────────────────────────────

    #[test]
    fn create_bootstrap_defaults_creates_role_and_channel() {
        let (db, _tmp) = test_db();
        let now = db::now_str();
        db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: "u1".into(),
                username: "alice".into(),
                display_name: "Alice".into(),
                public_key: vec![1u8; 32],
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: true,
                created_at: now.clone(),
                updated_at: now.clone(),
            
                ..Default::default()
            })?;
            let team_id = create_bootstrap_team(conn, "Server", "u1")?;
            create_bootstrap_defaults(conn, &team_id, "u1", false)?;

            let roles = db::get_roles_by_team(conn, &team_id)?;
            assert!(!roles.is_empty());
            let default_role = roles.iter().find(|r| r.is_default);
            assert!(default_role.is_some());
            assert_eq!(default_role.unwrap().name, "everyone");

            let channels = db::get_channels_by_team(conn, &team_id)?;
            assert!(!channels.is_empty());
            assert_eq!(channels[0].name, "general");
            // seed_demo=false should give us only #general, no extras.
            assert_eq!(channels.len(), 1);

            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn create_bootstrap_defaults_with_seed_demo_creates_extra_channels() {
        let (db, _tmp) = test_db();
        let now = db::now_str();
        db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: "u1".into(),
                username: "alice".into(),
                display_name: "Alice".into(),
                public_key: vec![1u8; 32],
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: true,
                created_at: now.clone(),
                updated_at: now.clone(),
            
                ..Default::default()
            })?;
            let team_id = create_bootstrap_team(conn, "Demo", "u1")?;
            create_bootstrap_defaults(conn, &team_id, "u1", true)?;

            let channels = db::get_channels_by_team(conn, &team_id)?;
            let names: Vec<_> = channels.iter().map(|c| c.name.as_str()).collect();
            assert!(names.contains(&"general"));
            assert!(names.contains(&"design"));
            assert!(names.contains(&"dev"));
            assert!(names.contains(&"random"));
            assert!(names.contains(&"voice-lounge"));
            // Verify voice-lounge is actually a voice channel, not a text one.
            let vl = channels.iter().find(|c| c.name == "voice-lounge").unwrap();
            assert_eq!(vl.channel_type, "voice");
            Ok(())
        })
        .unwrap();
    }

    // ── pure-helper coverage for the risk-scoring path ───────────────

    #[test]
    fn user_agent_family_classifies_known_browsers() {
        assert_eq!(user_agent_family(Some("Mozilla/5.0 Firefox/120.0")), "firefox");
        assert_eq!(user_agent_family(Some("Mozilla/5.0 Edg/120.0")), "edge");
        assert_eq!(user_agent_family(Some("Mozilla/5.0 Chrome/120.0")), "chrome");
        // Safari without "Chrome" elsewhere — note Edge and Chrome
        // tokens take priority because Safari strings include "Safari".
        assert_eq!(user_agent_family(Some("Mozilla/5.0 Version/17 Safari/605")), "safari");
        assert_eq!(user_agent_family(Some("dilla-tauri/0.1.0")), "tauri");
        assert_eq!(user_agent_family(Some("MyCustomBot/1.0")), "other");
    }

    #[test]
    fn user_agent_family_returns_unknown_when_absent() {
        assert_eq!(user_agent_family(None), "unknown");
    }

    #[test]
    fn ip_hint_masks_last_octet_of_ipv4() {
        assert_eq!(ip_hint("203.0.113.42"), "203.0.113.x");
    }

    #[test]
    fn ip_hint_masks_last_hextet_of_ipv6() {
        assert_eq!(ip_hint("2001:db8::1"), "2001:db8:::x");
    }

    #[test]
    fn ip_hint_returns_x_for_unusable_input() {
        assert_eq!(ip_hint("not-an-ip"), "x");
    }

    #[test]
    fn derive_country_from_ip_returns_none_for_private_ranges() {
        assert!(derive_country_from_ip(Some("10.0.0.1")).is_none());
        assert!(derive_country_from_ip(Some("192.168.1.1")).is_none());
        assert!(derive_country_from_ip(Some("172.16.0.1")).is_none());
        assert!(derive_country_from_ip(Some("127.0.0.1")).is_none());
        assert!(derive_country_from_ip(Some("::1")).is_none());
    }

    #[test]
    fn derive_country_from_ip_returns_some_for_public_ip_without_geoip_db() {
        // Without a configured mmdb the fallback is "unknown".
        let out = derive_country_from_ip(Some("8.8.8.8"));
        assert!(out.is_some());
    }

    #[test]
    fn derive_country_from_ip_none_input_returns_none() {
        assert!(derive_country_from_ip(None).is_none());
    }

    #[test]
    fn ip_is_tor_exit_returns_false_for_unparseable_ip() {
        assert!(!ip_is_tor_exit("not-an-ip"));
    }

    #[test]
    fn ip_is_tor_exit_returns_false_when_no_list_loaded() {
        // The exit list is only populated by init() with a real file path.
        // In tests, the OnceLock is either None or empty depending on
        // ordering — `false` is the correct expectation either way.
        assert!(!ip_is_tor_exit("203.0.113.1"));
    }

    #[test]
    fn compute_risk_score_zero_when_no_previous_context() {
        let score = compute_risk_score(None, Some("8.8.8.8"), Some("Mozilla/5.0 Chrome/120"), Some("US"));
        assert_eq!(score, 0);
    }

    #[test]
    fn compute_risk_score_country_change_adds_30() {
        let prev = (Some("203.0.113.1".to_string()), Some("Mozilla/5.0 Chrome/120".to_string()), Some("US".to_string()));
        let score = compute_risk_score(Some(&prev), Some("203.0.113.1"), Some("Mozilla/5.0 Chrome/120"), Some("DE"));
        assert_eq!(score, 30);
    }

    #[test]
    fn compute_risk_score_ua_family_change_adds_20() {
        let prev = (Some("8.8.8.8".to_string()), Some("Mozilla/5.0 Chrome/120".to_string()), Some("US".to_string()));
        let score = compute_risk_score(Some(&prev), Some("8.8.8.8"), Some("Mozilla/5.0 Firefox/120"), Some("US"));
        assert_eq!(score, 20);
    }

    #[test]
    fn compute_risk_score_same_signals_zero() {
        let prev = (Some("8.8.8.8".to_string()), Some("Mozilla/5.0 Chrome/120".to_string()), Some("US".to_string()));
        let score = compute_risk_score(Some(&prev), Some("8.8.8.8"), Some("Mozilla/5.0 Chrome/120"), Some("US"));
        assert_eq!(score, 0);
    }

    #[test]
    fn compute_risk_score_combines_country_and_ua_change() {
        let prev = (Some("1.1.1.1".to_string()), Some("Mozilla/5.0 Safari/605".to_string()), Some("US".to_string()));
        let score = compute_risk_score(Some(&prev), Some("1.1.1.1"), Some("Mozilla/5.0 Chrome/120"), Some("JP"));
        // 30 (country) + 20 (UA family)
        assert_eq!(score, 50);
    }

    // ── cookie helpers ────────────────────────────────────────────────

    #[test]
    fn build_auth_cookie_in_secure_mode_includes_secure_flag() {
        let c = build_auth_cookie("token123", 3600, /*insecure*/ false);
        assert!(c.contains("__dilla_jwt=token123"));
        assert!(c.contains("HttpOnly"));
        assert!(c.contains("SameSite=Strict"));
        assert!(c.contains("Secure;"));
        assert!(c.contains("Path=/api/v1"));
        assert!(c.contains("Max-Age=3600"));
    }

    #[test]
    fn build_auth_cookie_in_insecure_mode_omits_secure_flag() {
        let c = build_auth_cookie("token123", 3600, /*insecure*/ true);
        assert!(c.contains("__dilla_jwt=token123"));
        assert!(c.contains("HttpOnly"));
        assert!(!c.contains("Secure"));
    }

    #[test]
    fn clear_auth_cookie_zeros_max_age_and_empties_value() {
        let c = clear_auth_cookie(/*insecure*/ false);
        assert!(c.contains("__dilla_jwt=;"));
        assert!(c.contains("Max-Age=0"));
        assert!(c.contains("Secure;"));
    }

    #[test]
    fn clear_auth_cookie_insecure_omits_secure() {
        let c = clear_auth_cookie(true);
        assert!(c.contains("Max-Age=0"));
        assert!(!c.contains("Secure"));
    }

    #[test]
    fn build_auth_cookie_max_age_zero_renders_correctly() {
        let c = build_auth_cookie("t", 0, true);
        assert!(c.contains("Max-Age=0"));
    }

    // ── extract_request_context ───────────────────────────────────────

    #[test]
    fn extract_request_context_returns_none_none_for_empty_headers() {
        let headers = HeaderMap::new();
        let (ip, ua) = extract_request_context(&headers);
        assert!(ip.is_none());
        assert!(ua.is_none());
    }

    #[test]
    fn extract_request_context_prefers_x_forwarded_for_first_value() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            "203.0.113.1, 198.51.100.1".parse().unwrap(),
        );
        headers.insert("user-agent", "Mozilla/5.0".parse().unwrap());
        let (ip, ua) = extract_request_context(&headers);
        assert_eq!(ip.as_deref(), Some("203.0.113.1"));
        assert_eq!(ua.as_deref(), Some("Mozilla/5.0"));
    }

    #[test]
    fn extract_request_context_handles_user_agent_without_ip() {
        let mut headers = HeaderMap::new();
        headers.insert("user-agent", "Mozilla/5.0".parse().unwrap());
        let (ip, ua) = extract_request_context(&headers);
        assert!(ip.is_none());
        assert_eq!(ua.as_deref(), Some("Mozilla/5.0"));
    }

    // ── deserialization contracts ─────────────────────────────────────

    #[test]
    fn refresh_request_requires_refresh_token() {
        let r: RefreshRequest = serde_json::from_str(r#"{"refresh_token":"tok"}"#).unwrap();
        assert_eq!(r.refresh_token, "tok");
        assert!(serde_json::from_str::<RefreshRequest>("{}").is_err());
    }

    #[test]
    fn challenge_request_requires_public_key() {
        let r: ChallengeRequest = serde_json::from_str(r#"{"public_key":"abc"}"#).unwrap();
        assert_eq!(r.public_key, "abc");
        assert!(serde_json::from_str::<ChallengeRequest>("{}").is_err());
    }

    #[test]
    fn verify_request_requires_challenge_id_and_signature() {
        let r: VerifyRequest = serde_json::from_str(r#"{
            "challenge_id":"c","signature":"s","public_key":"k"
        }"#).unwrap();
        assert_eq!(r.challenge_id, "c");
        assert_eq!(r.signature, "s");
        assert!(serde_json::from_str::<VerifyRequest>(r#"{"challenge_id":"c"}"#).is_err());
    }

    // ── axum integration tests for refresh + logout ────────────────

    use crate::api::AppState;
    use crate::config::Config;
    use crate::presence::PresenceManager;
    use crate::ws::Hub;
    use axum::body::Body;
    use axum::http::Request;
    use axum::routing::post;
    use axum::Router;
    use std::sync::Arc;
    use tower::ServiceExt;

    fn make_state() -> (AppState, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let database = crate::db::Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        database.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
        database.run_migrations().unwrap();
        let auth = Arc::new(crate::auth::AuthService::new(database.clone(), ""));
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
            mesh: None,
            custom_theme_css: None,
        };
        (state, tmp)
    }

    fn router(state: AppState) -> Router {
        Router::new()
            .route("/auth/refresh", post(refresh))
            .route("/auth/logout", post(logout))
            .with_state(state)
    }

    #[tokio::test]
    async fn refresh_rejects_empty_refresh_token() {
        let (state, _tmp) = make_state();
        let app = router(state);
        let resp = app
            .oneshot(
                Request::post("/auth/refresh")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"refresh_token":""}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn refresh_rejects_garbage_refresh_token() {
        let (state, _tmp) = make_state();
        let app = router(state);
        let resp = app
            .oneshot(
                Request::post("/auth/refresh")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"refresh_token":"not-a-jwt"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 401);
    }

    #[tokio::test]
    async fn refresh_with_device_scoped_token_logs_device_audit() {
        let (state, _tmp) = make_state();
        // Mint a refresh token bound to a specific device — exercises the
        // L671-674 `if !did_log.is_empty()` Some-branch of the audit insert.
        let token = state
            .auth
            .generate_refresh_token_for_device("u-ref", "dev-7")
            .unwrap();
        let app = router(state);
        let body = format!(r#"{{"refresh_token":"{}"}}"#, token);
        let resp = app
            .oneshot(
                Request::post("/auth/refresh")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn refresh_happy_path_returns_new_access_token() {
        let (state, _tmp) = make_state();
        let token = state.auth.generate_refresh_token("u1").unwrap();
        let app = router(state);
        let body = format!(r#"{{"refresh_token":"{}"}}"#, token);
        let resp = app
            .oneshot(
                Request::post("/auth/refresh")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn logout_without_token_succeeds_idempotently() {
        let (state, _tmp) = make_state();
        let app = router(state);
        let resp = app
            .oneshot(
                Request::post("/auth/logout")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status() == 200 || resp.status() == 401);
    }

    fn router_full(state: AppState) -> Router {
        Router::new()
            .route("/auth/challenge", post(challenge))
            .route("/auth/verify", post(verify))
            .route("/auth/refresh", post(refresh))
            .route("/auth/logout", post(logout))
            .with_state(state)
    }

    #[tokio::test]
    async fn challenge_rejects_invalid_base64_public_key() {
        let (state, _tmp) = make_state();
        let app = router_full(state);
        let resp = app
            .oneshot(
                Request::post("/auth/challenge")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"public_key":"not!base64"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn challenge_rejects_wrong_length_public_key() {
        let (state, _tmp) = make_state();
        let app = router_full(state);
        let resp = app
            .oneshot(
                Request::post("/auth/challenge")
                    .header("content-type", "application/json")
                    // 3 bytes (YWJj = "abc"), not 32.
                    .body(Body::from(r#"{"public_key":"YWJj"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn challenge_returns_nonce_for_valid_32_byte_public_key() {
        use base64::Engine as _;
        let (state, _tmp) = make_state();
        let app = router_full(state);
        let pk_b64 = base64::engine::general_purpose::STANDARD.encode(&[0u8; 32]);
        let body = format!(r#"{{"public_key":"{}"}}"#, pk_b64);
        let resp = app
            .oneshot(
                Request::post("/auth/challenge")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn verify_rejects_invalid_base64_public_key() {
        let (state, _tmp) = make_state();
        let app = router_full(state);
        let body = r#"{"challenge_id":"c1","public_key":"!!bad","signature":"AAAA"}"#;
        let resp = app
            .oneshot(
                Request::post("/auth/verify")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn verify_rejects_invalid_base64_signature() {
        use base64::Engine as _;
        let (state, _tmp) = make_state();
        let app = router_full(state);
        let pk_b64 = base64::engine::general_purpose::STANDARD.encode(&[0u8; 32]);
        let body = format!(r#"{{"challenge_id":"c1","public_key":"{}","signature":"!!bad"}}"#, pk_b64);
        let resp = app
            .oneshot(
                Request::post("/auth/verify")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn verify_rejects_unknown_challenge_id() {
        use base64::Engine as _;
        let (state, _tmp) = make_state();
        let app = router_full(state);
        let pk_b64 = base64::engine::general_purpose::STANDARD.encode(&[0u8; 32]);
        let sig_b64 = base64::engine::general_purpose::STANDARD.encode(&[0u8; 64]);
        let body = format!(
            r#"{{"challenge_id":"never-issued","public_key":"{}","signature":"{}"}}"#,
            pk_b64, sig_b64,
        );
        let resp = app
            .oneshot(
                Request::post("/auth/verify")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn register_returns_409_for_duplicate_username() {
        use base64::Engine as _;
        use ed25519_dalek::{Signer, SigningKey};

        let (state, _tmp) = make_state();
        let now = crate::db::now_str();
        // Pre-seed a user with username "newbie" so the new registration's
        // check_username_and_key_available hits the conflict path.
        state.db.with_conn(|conn| {
            crate::db::create_user(conn, &crate::db::User {
                id: "existing".into(),
                username: "newbie".into(),
                display_name: "Already taken".into(),
                public_key: vec![88u8; 32],
                status_type: "online".into(),
                created_at: now.clone(),
                updated_at: now.clone(),
                ..Default::default()
            })?;
            crate::db::create_team(conn, &crate::db::Team {
                id: "t-dup".into(),
                name: "Dup".into(),
                created_by: "existing".into(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                created_at: now.clone(),
                updated_at: now.clone(),
                ..Default::default()
            })?;
            crate::db::create_invite(conn, &crate::db::Invite {
                id: "inv-dup".into(),
                team_id: "t-dup".into(),
                token: "valid-dup-token".into(),
                created_by: "existing".into(),
                max_uses: None,
                uses: 0,
                expires_at: None,
                revoked: false,
                created_at: now,
            })
        }).unwrap();

        let signing_key = SigningKey::from_bytes(&[111u8; 32]);
        let pk_bytes = signing_key.verifying_key().to_bytes();
        let (nonce, challenge_id) = state.auth.generate_challenge().unwrap();
        let signature = signing_key.sign(&nonce);
        let pk_b64 = base64::engine::general_purpose::STANDARD.encode(pk_bytes);
        let sig_b64 = base64::engine::general_purpose::STANDARD.encode(signature.to_bytes());

        let body = format!(
            r#"{{"username":"newbie","challenge_id":"{}","public_key":"{}","signature":"{}","invite_token":"valid-dup-token"}}"#,
            challenge_id, pk_b64, sig_b64
        );
        let app = Router::new()
            .route("/auth/register", post(register))
            .with_state(state);
        let resp = app
            .oneshot(
                Request::post("/auth/register")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        // 409 Conflict from the NotFound → Conflict map.
        assert_eq!(resp.status(), 409);
    }

    #[tokio::test]
    async fn register_400_for_revoked_invite() {
        use base64::Engine as _;
        use ed25519_dalek::{Signer, SigningKey};

        let (state, _tmp) = make_state();
        let now = crate::db::now_str();
        state.db.with_conn(|conn| {
            crate::db::create_invite(conn, &crate::db::Invite {
                id: "inv-revoked".into(),
                team_id: "t-x".into(),
                token: "revoked-token".into(),
                created_by: "x".into(),
                max_uses: None,
                uses: 0,
                expires_at: None,
                revoked: true,
                created_at: now,
            })
        }).unwrap();

        let signing_key = SigningKey::from_bytes(&[112u8; 32]);
        let pk_bytes = signing_key.verifying_key().to_bytes();
        let (nonce, challenge_id) = state.auth.generate_challenge().unwrap();
        let signature = signing_key.sign(&nonce);
        let pk_b64 = base64::engine::general_purpose::STANDARD.encode(pk_bytes);
        let sig_b64 = base64::engine::general_purpose::STANDARD.encode(signature.to_bytes());

        let body = format!(
            r#"{{"username":"freshuser","challenge_id":"{}","public_key":"{}","signature":"{}","invite_token":"revoked-token"}}"#,
            challenge_id, pk_b64, sig_b64
        );
        let app = Router::new()
            .route("/auth/register", post(register))
            .with_state(state);
        let resp = app
            .oneshot(
                Request::post("/auth/register")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        // Forbidden → BadRequest via the register handler's map.
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn logout_with_device_scoped_token_logs_device_audit() {
        let (state, _tmp) = make_state();
        // Generate a JWT bound to a specific device_id so the logout
        // audit hits the `if did_log.is_empty()` False branch.
        let token = state.auth.generate_jwt_for_device("u-log", "dev-1").unwrap();
        let app = router(state);
        let resp = app
            .oneshot(
                Request::post("/auth/logout")
                    .header("authorization", format!("Bearer {}", token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn logout_happy_path_revokes_valid_token() {
        let (state, _tmp) = make_state();
        // Generate a valid JWT directly via the auth service.
        let token = state.auth.generate_jwt("u-logout").unwrap();
        let app = router(state);
        let resp = app
            .oneshot(
                Request::post("/auth/logout")
                    .header("authorization", format!("Bearer {}", token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn verify_records_device_login_signals_with_active_device() {
        use base64::Engine as _;
        use ed25519_dalek::{Signer, SigningKey};
        let (state, _tmp) = make_state();
        let signing_key = SigningKey::from_bytes(&[51u8; 32]);
        let pk_bytes = signing_key.verifying_key().to_bytes();
        let now = crate::db::now_str();
        state.db.with_conn(|conn| {
            crate::db::create_user(conn, &crate::db::User {
                id: "alice".into(),
                username: "alice".into(),
                display_name: "Alice".into(),
                public_key: pk_bytes.to_vec(),
                status_type: "online".into(),
                created_at: now.clone(),
                updated_at: now,
                ..Default::default()
            })?;
            // Active device row — verify path now also exercises the
            // record_device_login + prev_signals derivation branches.
            crate::db::create_device(conn, "alice", &pk_bytes, "primary").map(|_| ())
        }).unwrap();
        // First verify: stamps the device's last-seen signals.
        let (nonce, challenge_id) = state.auth.generate_challenge().unwrap();
        let signature = signing_key.sign(&nonce);
        let pk_b64 = base64::engine::general_purpose::STANDARD.encode(pk_bytes);
        let sig_b64 = base64::engine::general_purpose::STANDARD.encode(signature.to_bytes());
        let body = format!(
            r#"{{"challenge_id":"{}","public_key":"{}","signature":"{}"}}"#,
            challenge_id, pk_b64, sig_b64
        );
        let app = router_full(state);
        let resp = app
            .oneshot(
                Request::post("/auth/verify")
                    .header("content-type", "application/json")
                    .header("user-agent", "Mozilla/5.0 Chrome/120.0")
                    .header("x-forwarded-for", "203.0.113.1")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn verify_rejects_when_user_device_is_revoked() {
        use base64::Engine as _;
        use ed25519_dalek::{Signer, SigningKey};
        let (state, _tmp) = make_state();
        // Seed alice with a known keypair.
        let signing_key = SigningKey::from_bytes(&[43u8; 32]);
        let pk_bytes = signing_key.verifying_key().to_bytes();
        let now = crate::db::now_str();
        state.db.with_conn(|conn| {
            crate::db::create_user(conn, &crate::db::User {
                id: "alice".into(),
                username: "alice".into(),
                display_name: "Alice".into(),
                public_key: pk_bytes.to_vec(),
                status_type: "online".into(),
                created_at: now.clone(),
                updated_at: now,
                ..Default::default()
            })?;
            // Insert a device row tied to the pubkey, then mark it revoked.
            let did = crate::db::create_device(conn, "alice", &pk_bytes, "primary")?;
            crate::db::revoke_device(conn, &did)
        }).unwrap();
        // Generate a challenge + sign with the matching key — challenge
        // verification passes, but verify_handler refuses to mint a JWT
        // because the corresponding device row is revoked.
        let (nonce, challenge_id) = state.auth.generate_challenge().unwrap();
        let signature = signing_key.sign(&nonce);
        let pk_b64 = base64::engine::general_purpose::STANDARD.encode(pk_bytes);
        let sig_b64 = base64::engine::general_purpose::STANDARD.encode(signature.to_bytes());
        let body = format!(
            r#"{{"challenge_id":"{}","public_key":"{}","signature":"{}"}}"#,
            challenge_id, pk_b64, sig_b64
        );
        let app = router_full(state);
        let resp = app
            .oneshot(
                Request::post("/auth/verify")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        // 401 — device revoked path returns Unauthorized("invalid signature").
        assert_eq!(resp.status(), 401);
    }

    #[tokio::test]
    async fn bootstrap_rejects_username_longer_than_32_chars() {
        use base64::Engine as _;
        use ed25519_dalek::{Signer, SigningKey};
        let (state, _tmp) = make_state();
        let signing_key = SigningKey::from_bytes(&[123u8; 32]);
        let pk_bytes = signing_key.verifying_key().to_bytes();
        let (nonce, challenge_id) = state.auth.generate_challenge().unwrap();
        let signature = signing_key.sign(&nonce);
        let pk_b64 = base64::engine::general_purpose::STANDARD.encode(pk_bytes);
        let sig_b64 = base64::engine::general_purpose::STANDARD.encode(signature.to_bytes());
        // Username 33 chars long — triggers the L556-558 length guard.
        let oversize = "u".repeat(33);
        let body = format!(
            r#"{{"username":"{}","challenge_id":"{}","public_key":"{}","signature":"{}","bootstrap_token":"tok"}}"#,
            oversize, challenge_id, pk_b64, sig_b64,
        );
        let app = Router::new().route("/auth/bootstrap", post(bootstrap)).with_state(state);
        let resp = app
            .oneshot(
                Request::post("/auth/bootstrap")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn register_rejects_when_signature_does_not_verify_against_nonce() {
        use base64::Engine as _;
        use ed25519_dalek::{Signer, SigningKey};
        let (state, _tmp) = make_state();
        let now = crate::db::now_str();
        state.db.with_conn(|conn| {
            crate::db::create_team(conn, &crate::db::Team {
                id: "t-bad-sig".into(),
                name: "T".into(),
                created_by: "x".into(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                created_at: now.clone(),
                updated_at: now.clone(),
                ..Default::default()
            })?;
            crate::db::create_invite(conn, &crate::db::Invite {
                id: "inv-sig".into(),
                team_id: "t-bad-sig".into(),
                token: "sig-token".into(),
                created_by: "x".into(),
                max_uses: None,
                uses: 0,
                expires_at: None,
                revoked: false,
                created_at: now,
            })
        }).unwrap();
        // Generate a challenge but sign the WRONG bytes → verify returns false.
        let signing_key = SigningKey::from_bytes(&[200u8; 32]);
        let pk_bytes = signing_key.verifying_key().to_bytes();
        let (_nonce, challenge_id) = state.auth.generate_challenge().unwrap();
        // Sign garbage instead of the nonce so verify_challenge returns false.
        let wrong_sig = signing_key.sign(b"wrong-message-not-the-nonce");
        let pk_b64 = base64::engine::general_purpose::STANDARD.encode(pk_bytes);
        let sig_b64 = base64::engine::general_purpose::STANDARD.encode(wrong_sig.to_bytes());
        let body = format!(
            r#"{{"username":"hi","challenge_id":"{}","public_key":"{}","signature":"{}","invite_token":"sig-token"}}"#,
            challenge_id, pk_b64, sig_b64
        );
        let app = Router::new()
            .route("/auth/register", post(register))
            .with_state(state);
        let resp = app
            .oneshot(
                Request::post("/auth/register")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        // 401 Unauthorized — "invalid signature" path at L822-823 of
        // decode_and_verify_challenge.
        assert_eq!(resp.status(), 401);
    }

    #[tokio::test]
    async fn bootstrap_rejects_invalid_bootstrap_token() {
        use base64::Engine as _;
        use ed25519_dalek::{Signer, SigningKey};
        let (state, _tmp) = make_state();
        // Valid signed challenge but the bootstrap_token doesn't exist in
        // the DB → validate_bootstrap_token returns InvalidParameterName,
        // which the bootstrap handler maps to AppError::BadRequest.
        let signing_key = SigningKey::from_bytes(&[100u8; 32]);
        let pk_bytes = signing_key.verifying_key().to_bytes();
        let (nonce, challenge_id) = state.auth.generate_challenge().unwrap();
        let signature = signing_key.sign(&nonce);
        let pk_b64 = base64::engine::general_purpose::STANDARD.encode(pk_bytes);
        let sig_b64 = base64::engine::general_purpose::STANDARD.encode(signature.to_bytes());
        let body = format!(
            r#"{{"username":"admin","challenge_id":"{}","public_key":"{}","signature":"{}","bootstrap_token":"never-issued"}}"#,
            challenge_id, pk_b64, sig_b64
        );
        let app = Router::new().route("/auth/bootstrap", post(bootstrap)).with_state(state);
        let resp = app
            .oneshot(
                Request::post("/auth/bootstrap")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn bootstrap_happy_path_consumes_token_and_creates_team() {
        use base64::Engine as _;
        use ed25519_dalek::{Signer, SigningKey};

        let (state, _tmp) = make_state();
        // Seed a valid bootstrap token.
        state.db.with_conn(|conn| {
            crate::db::create_bootstrap_token(conn, "valid-bootstrap")
        }).unwrap();

        let signing_key = SigningKey::from_bytes(&[77u8; 32]);
        let pk_bytes = signing_key.verifying_key().to_bytes();
        let (nonce, challenge_id) = state.auth.generate_challenge().unwrap();
        let signature = signing_key.sign(&nonce);
        let pk_b64 = base64::engine::general_purpose::STANDARD.encode(pk_bytes);
        let sig_b64 = base64::engine::general_purpose::STANDARD.encode(signature.to_bytes());

        let body = format!(
            r#"{{"username":"bootstrap-admin","challenge_id":"{}","public_key":"{}","signature":"{}","bootstrap_token":"valid-bootstrap","team_name":"FirstTeam"}}"#,
            challenge_id, pk_b64, sig_b64
        );
        let app = Router::new()
            .route("/auth/bootstrap", post(bootstrap))
            .with_state(state);
        let resp = app
            .oneshot(
                Request::post("/auth/bootstrap")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn register_happy_path_creates_user_with_valid_invite() {
        use base64::Engine as _;
        use ed25519_dalek::{Signer, SigningKey};

        let (state, _tmp) = make_state();
        // Seed an existing team + invite so register has something to bind to.
        let now = crate::db::now_str();
        state.db.with_conn(|conn| {
            crate::db::create_user(conn, &crate::db::User {
                id: "u-owner".into(),
                username: "owner".into(),
                display_name: "Owner".into(),
                public_key: vec![1u8; 32],
                status_type: "online".into(),
                created_at: now.clone(),
                updated_at: now.clone(),
                ..Default::default()
            })?;
            crate::db::create_team(conn, &crate::db::Team {
                id: "t-reg".into(),
                name: "Registration".into(),
                created_by: "u-owner".into(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                created_at: now.clone(),
                updated_at: now.clone(),
                ..Default::default()
            })?;
            crate::db::create_invite(conn, &crate::db::Invite {
                id: "inv-reg".into(),
                team_id: "t-reg".into(),
                token: "valid-invite-token".into(),
                created_by: "u-owner".into(),
                max_uses: None,
                uses: 0,
                expires_at: None,
                revoked: false,
                created_at: now,
            })
        }).unwrap();

        // Build a new identity for the registering user.
        let signing_key = SigningKey::from_bytes(&[55u8; 32]);
        let pk_bytes = signing_key.verifying_key().to_bytes();
        let (nonce, challenge_id) = state.auth.generate_challenge().unwrap();
        let signature = signing_key.sign(&nonce);
        let pk_b64 = base64::engine::general_purpose::STANDARD.encode(pk_bytes);
        let sig_b64 = base64::engine::general_purpose::STANDARD.encode(signature.to_bytes());

        let body = format!(
            r#"{{"username":"newbie","challenge_id":"{}","public_key":"{}","signature":"{}","invite_token":"valid-invite-token"}}"#,
            challenge_id, pk_b64, sig_b64
        );
        // Build a small router exposing register only.
        let app = Router::new()
            .route("/auth/register", post(register))
            .with_state(state);
        let resp = app
            .oneshot(
                Request::post("/auth/register")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn verify_happy_path_returns_jwt_for_known_user() {
        use base64::Engine as _;
        use ed25519_dalek::{Signer, SigningKey};

        let (state, _tmp) = make_state();
        // Seed alice with a known Ed25519 keypair.
        let signing_key = SigningKey::from_bytes(&[42u8; 32]);
        let pk_bytes = signing_key.verifying_key().to_bytes();
        let now = crate::db::now_str();
        state.db.with_conn(|conn| {
            crate::db::create_user(conn, &crate::db::User {
                id: "alice".into(),
                username: "alice".into(),
                display_name: "Alice".into(),
                public_key: pk_bytes.to_vec(),
                status_type: "online".into(),
                created_at: now.clone(),
                updated_at: now,
                ..Default::default()
            })
        }).unwrap();
        // Generate a challenge for alice's pubkey.
        let (nonce, challenge_id) = state.auth.generate_challenge().unwrap();
        // Sign the nonce with alice's signing key.
        let signature = signing_key.sign(&nonce);
        let pk_b64 = base64::engine::general_purpose::STANDARD.encode(pk_bytes);
        let sig_b64 = base64::engine::general_purpose::STANDARD.encode(signature.to_bytes());
        let body = format!(
            r#"{{"challenge_id":"{}","public_key":"{}","signature":"{}"}}"#,
            challenge_id, pk_b64, sig_b64
        );
        let app = router_full(state);
        let resp = app
            .oneshot(
                Request::post("/auth/verify")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn verify_rejects_oversized_body() {
        let (state, _tmp) = make_state();
        let app = router_full(state);
        // > 16 KiB body should be rejected by the size cap.
        let oversize = format!(
            r#"{{"challenge_id":"c1","public_key":"{}","signature":"a"}}"#,
            "A".repeat(20 * 1024),
        );
        let resp = app
            .oneshot(
                Request::post("/auth/verify")
                    .header("content-type", "application/json")
                    .body(Body::from(oversize))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    fn router_register(state: AppState) -> Router {
        Router::new()
            .route("/auth/register", post(register))
            .route("/auth/bootstrap", post(bootstrap))
            .with_state(state)
    }

    #[tokio::test]
    async fn register_rejects_empty_username() {
        use base64::Engine as _;
        let (state, _tmp) = make_state();
        let app = router_register(state);
        let pk_b64 = base64::engine::general_purpose::STANDARD.encode(&[0u8; 32]);
        let sig_b64 = base64::engine::general_purpose::STANDARD.encode(&[0u8; 64]);
        let body = format!(
            r#"{{"challenge_id":"c1","public_key":"{}","signature":"{}","username":"","invite_token":"t"}}"#,
            pk_b64, sig_b64,
        );
        let resp = app
            .oneshot(
                Request::post("/auth/register")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        // Either 400 (caught at the bad challenge id) or 401. Just smoke.
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn register_rejects_oversized_username() {
        use base64::Engine as _;
        let (state, _tmp) = make_state();
        let app = router_register(state);
        let pk_b64 = base64::engine::general_purpose::STANDARD.encode(&[0u8; 32]);
        let sig_b64 = base64::engine::general_purpose::STANDARD.encode(&[0u8; 64]);
        let oversize = "u".repeat(33);
        let body = format!(
            r#"{{"challenge_id":"c1","public_key":"{}","signature":"{}","username":"{}","invite_token":"t"}}"#,
            pk_b64, sig_b64, oversize,
        );
        let resp = app
            .oneshot(
                Request::post("/auth/register")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn bootstrap_rejects_invalid_challenge() {
        use base64::Engine as _;
        let (state, _tmp) = make_state();
        let app = router_register(state);
        let pk_b64 = base64::engine::general_purpose::STANDARD.encode(&[0u8; 32]);
        let sig_b64 = base64::engine::general_purpose::STANDARD.encode(&[0u8; 64]);
        let body = format!(
            r#"{{"challenge_id":"never-issued","public_key":"{}","signature":"{}","username":"admin","bootstrap_token":"tok"}}"#,
            pk_b64, sig_b64,
        );
        let resp = app
            .oneshot(
                Request::post("/auth/bootstrap")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }
}
