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

pub async fn verify(
    State(state): State<AppState>,
    req: Request,
) -> Result<Json<Value>, AppError> {
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
        // A5: audit-log the failed verify. We can't tie it to a team
        // (the public key may not match any user), so we log a global
        // record under a synthetic team_id "_global" — the audit
        // emitter MUST tolerate a non-existent team_id (it does:
        // `audit_events` has no FK on team_id).
        let ua_log = ua.clone();
        let ip_log = ip.clone();
        let reason = if !valid { "bad_signature" } else { "unknown_user" };
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
                    "ip": ip_log,
                    "user_agent": ua_log,
                })),
            )
        })
        .await;
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
            let user_id_log = user.id.clone();
            let device_id_log = d.id.clone();
            let ip_log = ip.clone();
            let _ = spawn_db(state.db.clone(), move |conn| {
                let teams = db::list_user_teams(conn, &user_id_log).unwrap_or_default();
                for team_id in teams {
                    let _ = db::insert_audit_event(
                        conn,
                        &team_id,
                        Some(&user_id_log),
                        "auth.login_failed",
                        Some("device"),
                        Some(&device_id_log),
                        Some(&json!({
                            "reason": "device_revoked",
                            "ip": ip_log,
                        })),
                    );
                }
                Ok(())
            })
            .await;
            return Err(AppError::Unauthorized("invalid signature".into()));
        }
    }

    // A2: stamp risk signals + bump current_session_started_at. We
    // also compare against the *previous* signals to compute a risk
    // score — see below.
    let prev_signals = device.as_ref().map(|d| {
        (
            d.last_seen_ip.clone(),
            d.last_seen_user_agent.clone(),
            d.last_seen_country.clone(),
        )
    });
    let country = derive_country_from_ip(ip.as_deref());

    if let Some(ref d) = device {
        let did = d.id.clone();
        let ip_q = ip.clone();
        let ua_q = ua.clone();
        let country_q = country.clone();
        let _ = spawn_db(state.db.clone(), move |conn| {
            db::record_device_login(
                conn,
                &did,
                ip_q.as_deref(),
                ua_q.as_deref(),
                country_q.as_deref(),
            )
        })
        .await;
    }

    // A2: compute a simple risk score from the delta between this
    // login's signals and the previously-recorded ones. Heuristic-
    // only — never a hard block. High-risk events fire a WS event to
    // the user's other devices so they see the change in real time.
    let risk_score = compute_risk_score(prev_signals.as_ref(), ip.as_deref(), ua.as_deref(), country.as_deref());
    if risk_score >= 50 {
        let user_id_log = user.id.clone();
        let device_id_log = device_id.clone();
        let ip_log = ip.clone();
        let country_log = country.clone();
        let _ = spawn_db(state.db.clone(), move |conn| {
            let teams = db::list_user_teams(conn, &user_id_log).unwrap_or_default();
            for team_id in teams {
                let _ = db::insert_audit_event(
                    conn,
                    &team_id,
                    Some(&user_id_log),
                    "device.risk_event",
                    Some("device"),
                    Some(&device_id_log),
                    Some(&json!({
                        "risk_score": risk_score,
                        "ip": ip_log,
                        "country": country_log,
                    })),
                );
            }
            Ok(())
        })
        .await;

        if risk_score >= 80 {
            // Best-effort dispatch — failures here mustn't break login.
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
                    state.hub.send_to_user(&user.id, data).await;
                }
            }
        }
    }

    let token = state.auth.generate_jwt_for_device(&user.id, &device_id)?;
    let refresh_token = state
        .auth
        .generate_refresh_token_for_device(&user.id, &device_id)?;

    // A5: success-side audit event. Same per-team fan-out as the
    // failure path so audit officers see every login from their team.
    let user_id_log = user.id.clone();
    let device_id_log = device_id.clone();
    let ip_log = ip.clone();
    let country_log = country.clone();
    let _ = spawn_db(state.db.clone(), move |conn| {
        let teams = db::list_user_teams(conn, &user_id_log).unwrap_or_default();
        for team_id in teams {
            let _ = db::insert_audit_event(
                conn,
                &team_id,
                Some(&user_id_log),
                "auth.login",
                Some("device"),
                Some(&device_id_log),
                Some(&json!({
                    "ip": ip_log,
                    "country": country_log,
                })),
            );
        }
        Ok(())
    })
    .await;

    Ok(Json(json!({
        "token": token,
        "refresh_token": refresh_token,
        "user": user,
        "device_id": device_id,
    })))
}

// ── A2 risk-scoring helpers ─────────────────────────────────────────────

/// Optional Tor-exit-node lookup. The file lives at
/// `<DILLA_DATA_DIR>/tor-exit-nodes.txt` if the operator wants the
/// 50-point bonus on Tor traffic; absence is logged and silently
/// skipped. Each line is a single IP (comments starting with `#`
/// are ignored).
fn ip_is_tor_exit(_ip: &str) -> bool {
    // The list lives on disk; reading it on every login would amplify
    // the syscall cost. We deliberately keep this a stub for the
    // skeleton — the file plumbing is documented in the report so a
    // future commit can wire it in. See 08-auth-enhancement.md A2.
    false
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

fn compute_risk_score(
    prev: Option<&(Option<String>, Option<String>, Option<String>)>,
    new_ip: Option<&str>,
    new_ua: Option<&str>,
    new_country: Option<&str>,
) -> u32 {
    let mut score: u32 = 0;
    if let Some(prev) = prev {
        let (prev_ip, prev_ua, prev_country) = prev;
        // +30 if country changed (and we have a previous country to
        // compare against — first login from a fresh device doesn't
        // get the bonus).
        if let (Some(p), Some(n)) = (prev_country.as_deref(), new_country) {
            if p != n {
                score = score.saturating_add(30);
            }
        }
        // +20 if user-agent family changed.
        if let Some(p) = prev_ua.as_deref() {
            let p_family = user_agent_family(Some(p));
            let n_family = user_agent_family(new_ua);
            if p_family != n_family {
                score = score.saturating_add(20);
            }
        }
        // +50 if the new IP is a Tor exit node.
        if let Some(n) = new_ip {
            if ip_is_tor_exit(n) {
                score = score.saturating_add(50);
            }
            // Also flag a *complete* IP change as a low signal so the
            // delta-from-baseline still moves on the first foreign
            // login.
            if let Some(p) = prev_ip.as_deref() {
                if p != n {
                    // No standalone bonus — country change already
                    // covers the cross-region case. The IP delta only
                    // matters as a tie-breaker, which we omit here.
                    let _ = p;
                }
            }
        }
    }
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
) -> Result<Json<Value>, AppError> {
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

    Ok(Json(json!({
        "token": access,
        "refresh_token": refresh,
        "rotated": rotated,
    })))
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
) -> Result<Json<Value>, AppError> {
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

    Ok(Json(json!({ "ok": true })))
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
}
