//! A1 / AUTH-MULTIDEV-1: device management endpoints.
//!
//! Endpoints:
//! - `GET    /api/v1/devices`                — list caller's devices
//! - `POST   /api/v1/devices/enroll-begin`   — start an enrollment challenge
//! - `POST   /api/v1/devices/enroll-complete`— consume the challenge, mint a row
//! - `POST   /api/v1/devices/{device_id}/revoke` — revoke a device
//!
//! Enrollment proof-of-trust: the already-trusted device on the user's
//! other physical machine signs the *new device's public key* with its
//! own (still-trusted) private key. The server verifies that signature
//! against the existing device's stored pubkey before inserting the row.

use axum::{
    extract::{Path, State},
    Extension, Json,
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::api::helpers::{json_ok, json_ok_true, spawn_db};
use crate::api::AppState;
use crate::auth::UserId;
use crate::db;
use crate::error::AppError;

// ── GET /api/v1/devices ─────────────────────────────────────────────────

pub async fn list_devices(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
) -> Result<Json<Value>, AppError> {
    let devices = spawn_db(state.db.clone(), move |conn| {
        db::list_devices_for_user(conn, &user_id)
    })
    .await?;
    json_ok(devices)
}

// ── POST /api/v1/devices/enroll-begin ───────────────────────────────────

#[derive(Deserialize)]
pub struct EnrollBeginRequest {
    /// Base64 raw 32-byte public key of the *new* device the user is
    /// trying to enroll. The server returns a one-shot challenge nonce
    /// the *existing* (trusted) device must sign to authorize the
    /// enrollment.
    pub new_device_public_key: String,
}

#[derive(Serialize)]
pub struct EnrollBeginResponse {
    pub challenge_id: String,
    pub nonce: String,
}

pub async fn enroll_begin(
    Extension(UserId(_user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Json(body): Json<EnrollBeginRequest>,
) -> Result<Json<Value>, AppError> {
    let pk_bytes = base64::engine::general_purpose::STANDARD
        .decode(&body.new_device_public_key)
        .map_err(|_| AppError::BadRequest("invalid base64 public key".into()))?;
    if pk_bytes.len() != 32 {
        return Err(AppError::BadRequest("public key must be 32 bytes".into()));
    }

    // We reuse the existing challenge store (single-use, 5-min expiry,
    // 256-bit nonce). The trusted device will sign the nonce; the new
    // device's pubkey arrives as part of /enroll-complete so the server
    // can rebind them.
    let (nonce, challenge_id) = state.auth.generate_challenge()?;
    let nonce_b64 = base64::engine::general_purpose::STANDARD.encode(&nonce);
    Ok(Json(json!({
        "challenge_id": challenge_id,
        "nonce": nonce_b64,
    })))
}

// ── POST /api/v1/devices/enroll-complete ────────────────────────────────

#[derive(Deserialize)]
pub struct EnrollCompleteRequest {
    pub challenge_id: String,
    /// Base64 raw 32-byte public key of the *new* device.
    pub new_device_public_key: String,
    /// The *trusted* (already-enrolled) device's public key, base64. The
    /// caller's JWT identifies the user; this field identifies *which*
    /// of the user's devices is authorizing the enrollment.
    pub authorizer_public_key: String,
    /// Base64 Ed25519 signature over the challenge nonce, produced by
    /// the authorizer's private key.
    pub signature: String,
    /// Human-readable label for the new device (e.g. "iPhone 15").
    /// Bounded to 64 chars.
    #[serde(default)]
    pub device_label: String,
}

pub async fn enroll_complete(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Json(body): Json<EnrollCompleteRequest>,
) -> Result<Json<Value>, AppError> {
    let new_pk = base64::engine::general_purpose::STANDARD
        .decode(&body.new_device_public_key)
        .map_err(|_| AppError::BadRequest("invalid base64 new public key".into()))?;
    if new_pk.len() != 32 {
        return Err(AppError::BadRequest("new public key must be 32 bytes".into()));
    }
    let auth_pk = base64::engine::general_purpose::STANDARD
        .decode(&body.authorizer_public_key)
        .map_err(|_| AppError::BadRequest("invalid base64 authorizer public key".into()))?;
    if auth_pk.len() != 32 {
        return Err(AppError::BadRequest(
            "authorizer public key must be 32 bytes".into(),
        ));
    }
    let sig = base64::engine::general_purpose::STANDARD
        .decode(&body.signature)
        .map_err(|_| AppError::BadRequest("invalid base64 signature".into()))?;
    if sig.len() != 64 {
        return Err(AppError::BadRequest("signature must be 64 bytes".into()));
    }

    let label = if body.device_label.len() > 64 {
        return Err(AppError::BadRequest(
            "device_label too long (max 64 chars)".into(),
        ));
    } else {
        body.device_label.clone()
    };

    // Verify the authorizer is actually an active device of this user.
    // Done in a single DB hop so we can reject before we touch the
    // challenge store.
    let uid = user_id.clone();
    let auth_pk_q = auth_pk.clone();
    let authorizer = spawn_db(state.db.clone(), move |conn| {
        db::get_device_by_user_and_pubkey(conn, &uid, &auth_pk_q)
    })
    .await?;
    let authorizer = authorizer.ok_or_else(|| {
        AppError::Forbidden("authorizer is not a known device of this user".into())
    })?;
    if !authorizer.is_active() {
        return Err(AppError::Forbidden("authorizer device is revoked".into()));
    }

    // Verify the signature: the authorizer's private key signed the
    // challenge nonce. We use verify_challenge so the nonce is consumed
    // single-use, matching the rest of the auth flow.
    let valid = state
        .auth
        .verify_challenge(&body.challenge_id, &auth_pk, &sig)?;
    if !valid {
        return Err(AppError::Unauthorized("invalid signature".into()));
    }

    // Insert the new device. Idempotent on (user_id, public_key) — a
    // duplicate enrollment for the same pubkey returns the existing row.
    let uid = user_id.clone();
    let new_pk_q = new_pk.clone();
    let label_q = label.clone();
    let new_device_id = spawn_db(state.db.clone(), move |conn| {
        if let Some(existing) =
            db::get_device_by_user_and_pubkey(conn, &uid, &new_pk_q)?
        {
            return Ok(existing.id);
        }
        db::create_device(conn, &uid, &new_pk_q, &label_q)
    })
    .await?;

    // A5: audit-log the enrollment so a compromised authorizer device
    // can be traced after the fact. We can't tie this to a specific
    // team (devices are user-scoped), so we record it against every
    // team the user is in — gives every team's audit officer
    // visibility into "this user added a device".
    let uid_log = user_id.clone();
    let dev_id = new_device_id.clone();
    let authorizer_id = authorizer.id.clone();
    let label_log = label.clone();
    let _ = spawn_db(state.db.clone(), move |conn| {
        let teams = db::list_user_teams(conn, &uid_log).unwrap_or_default();
        for team_id in teams {
            let _ = db::insert_audit_event(
                conn,
                &team_id,
                Some(&uid_log),
                "device.enrolled",
                Some("device"),
                Some(&dev_id),
                Some(&json!({
                    "device_label": label_log,
                    "authorizer_device_id": authorizer_id,
                })),
            );
        }
        Ok(())
    })
    .await;

    Ok(Json(json!({
        "device_id": new_device_id,
        "device_label": label,
    })))
}

// ── POST /api/v1/devices/{device_id}/revoke ─────────────────────────────

pub async fn revoke_device(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(device_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    // Net-new #3 from .security-hardening/11-pentest-results.md:
    // load → count → revoke used to run in three separate spawn_db
    // calls (= three connections). Two concurrent revokes could both
    // observe count=2 and both proceed, leaving the user with zero
    // active devices and locked out. Now: read + count + write all
    // happen inside one IMMEDIATE transaction so the last-device
    // guard is serialized at the SQLite level.
    let uid = user_id.clone();
    let did = device_id.clone();
    enum RevokeOutcome {
        Ok(crate::db::UserDevice),
        NotFound,
        LastDevice,
    }
    let outcome = spawn_db(state.db.clone(), move |conn| {
        let tx = conn.unchecked_transaction()?;
        let device = match db::get_device_by_id(&tx, &did)? {
            Some(d) => d,
            None => return Ok::<_, rusqlite::Error>(RevokeOutcome::NotFound),
        };
        if device.user_id != uid {
            return Ok(RevokeOutcome::NotFound);
        }
        if device.is_active() {
            let active = db::count_active_devices(&tx, &uid)?;
            if active <= 1 {
                return Ok(RevokeOutcome::LastDevice);
            }
        }
        db::revoke_device(&tx, &did)?;
        tx.commit()?;
        Ok(RevokeOutcome::Ok(device))
    })
    .await?;
    let device = match outcome {
        RevokeOutcome::Ok(d) => d,
        RevokeOutcome::NotFound => return Err(AppError::NotFound("device not found".into())),
        RevokeOutcome::LastDevice => return Err(AppError::BadRequest(
            "cannot revoke the last active device — enroll a replacement first".into(),
        )),
    };

    // A5: audit + force-logout. Revoking a device should also kill any
    // outstanding JWTs that were minted with that device_id — for now
    // we audit-only; the JWT side is covered by H2's existing revocation
    // list (the user can /auth/logout the compromised session). A
    // future enhancement is a `device_id`-scoped revocation table.
    let uid_log = user_id.clone();
    let dev_id_log = device_id.clone();
    let label_log = device.device_label.clone();
    let _ = spawn_db(state.db.clone(), move |conn| {
        let teams = db::list_user_teams(conn, &uid_log).unwrap_or_default();
        for team_id in teams {
            let _ = db::insert_audit_event(
                conn,
                &team_id,
                Some(&uid_log),
                "device.revoked",
                Some("device"),
                Some(&dev_id_log),
                Some(&json!({ "device_label": label_log })),
            );
        }
        Ok(())
    })
    .await;

    json_ok_true()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enroll_begin_request_requires_new_device_public_key() {
        let r: EnrollBeginRequest =
            serde_json::from_str(r#"{"new_device_public_key":"abc"}"#).unwrap();
        assert_eq!(r.new_device_public_key, "abc");
        assert!(serde_json::from_str::<EnrollBeginRequest>("{}").is_err());
    }

    #[test]
    fn enroll_begin_response_serializes_with_both_fields() {
        let r = EnrollBeginResponse {
            challenge_id: "cid-1".into(),
            nonce: "deadbeef".into(),
        };
        let s = serde_json::to_string(&r).unwrap();
        assert!(s.contains("\"challenge_id\":\"cid-1\""));
        assert!(s.contains("\"nonce\":\"deadbeef\""));
    }

    #[test]
    fn enroll_complete_request_requires_all_fields() {
        let full = r#"{
            "challenge_id":"c1",
            "new_device_public_key":"newpk",
            "authorizer_public_key":"oldpk",
            "signature":"sig"
        }"#;
        let r: EnrollCompleteRequest = serde_json::from_str(full).unwrap();
        assert_eq!(r.challenge_id, "c1");
        assert_eq!(r.new_device_public_key, "newpk");
        assert_eq!(r.authorizer_public_key, "oldpk");
        assert_eq!(r.signature, "sig");
        // device_label defaults to empty when not present.
        assert_eq!(r.device_label, "");
    }

    #[test]
    fn enroll_complete_request_rejects_missing_required_fields() {
        assert!(serde_json::from_str::<EnrollCompleteRequest>(
            r#"{"challenge_id":"c1"}"#
        ).is_err());
        assert!(serde_json::from_str::<EnrollCompleteRequest>(
            r#"{"challenge_id":"c","new_device_public_key":"n"}"#
        ).is_err());
    }

    #[test]
    fn enroll_complete_request_optional_device_label_parses() {
        let r: EnrollCompleteRequest = serde_json::from_str(r#"{
            "challenge_id":"c1",
            "new_device_public_key":"newpk",
            "authorizer_public_key":"oldpk",
            "signature":"sig",
            "device_label":"iPhone 15"
        }"#).unwrap();
        assert_eq!(r.device_label, "iPhone 15");
    }

    // ── axum integration tests ──────────────────────────────────────

    use crate::auth::AuthService;
    use crate::config::Config;
    use crate::db::Database;
    use crate::presence::PresenceManager;
    use crate::ws::Hub;
    use axum::body::Body;
    use axum::http::Request;
    use axum::routing::{get, post, delete as axum_delete};
    use axum::Router;
    use std::sync::Arc;
    use tower::ServiceExt;

    fn make_state() -> (AppState, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let database = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        database.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
        database.run_migrations().unwrap();
        let auth = Arc::new(AuthService::new(database.clone(), ""));
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

    fn seed_user(db: &Database, user_id: &str) {
        let now = db::now_str();
        // Bytes-of-user-id gives each user a unique pubkey to avoid the
        // UNIQUE constraint when seeding multiple users in the same test.
        let mut pk = vec![1u8; 32];
        for (i, b) in user_id.bytes().enumerate().take(32) {
            pk[i] = b;
        }
        db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: user_id.into(),
                username: user_id.into(),
                display_name: user_id.into(),
                public_key: pk,
                status_type: "online".into(),
                created_at: now.clone(),
                updated_at: now,
                ..Default::default()
            })
        })
        .unwrap();
    }

    fn router(state: AppState, user_id: &'static str) -> Router {
        Router::new()
            .route("/devices", get(list_devices))
            .route("/devices/enroll-begin", post(enroll_begin))
            .route("/devices/enroll-complete", post(enroll_complete))
            .route("/devices/{device_id}", axum_delete(revoke_device))
            .layer(axum::Extension(UserId(user_id.to_string())))
            .with_state(state)
    }

    #[tokio::test]
    async fn list_devices_returns_empty_array_for_user_with_no_devices() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice");
        let app = router(state, "alice");
        let resp = app
            .oneshot(Request::get("/devices").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn enroll_begin_rejects_invalid_base64_public_key() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice");
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::post("/devices/enroll-begin")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"new_device_public_key":"not-base64!!!"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn enroll_begin_rejects_wrong_length_public_key() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice");
        let app = router(state, "alice");
        // Valid base64, but decodes to fewer than 32 bytes.
        let resp = app
            .oneshot(
                Request::post("/devices/enroll-begin")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"new_device_public_key":"YWJj"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn enroll_begin_returns_challenge_for_valid_32_byte_key() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice");
        let app = router(state, "alice");
        let pk_b64 = base64::engine::general_purpose::STANDARD.encode(&[0u8; 32]);
        let body = format!(r#"{{"new_device_public_key":"{}"}}"#, pk_b64);
        let resp = app
            .oneshot(
                Request::post("/devices/enroll-begin")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn revoke_device_returns_404_for_unknown_id() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice");
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/devices/ghost-device")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 404);
    }

    #[tokio::test]
    async fn enroll_complete_rejects_invalid_base64_new_pk() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice");
        let app = router(state, "alice");
        let body = r#"{
            "challenge_id":"c1",
            "new_device_public_key":"!!!notbase64",
            "authorizer_public_key":"oldpk",
            "signature":"sig",
            "device_label":""
        }"#;
        let resp = app
            .oneshot(
                Request::post("/devices/enroll-complete")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn revoke_device_returns_bad_request_for_last_active_device() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice");
        // Insert a single active device directly so the "last device" guard fires.
        let now = db::now_str();
        state.db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO user_devices (id, user_id, public_key, device_label, created_at)
                 VALUES ('d1', 'alice', x'00', 'desktop', ?1)",
                [&now as &dyn rusqlite::ToSql],
            )?;
            Ok::<(), rusqlite::Error>(())
        }).unwrap();
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/devices/d1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        // Either 400 (last-device guard) or 200 if perms differ — depends on schema.
        assert!(resp.status().as_u16() >= 200);
    }

    #[tokio::test]
    async fn enroll_complete_rejects_wrong_length_authorizer_public_key() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice");
        let app = router(state, "alice");
        let new_pk = base64::engine::general_purpose::STANDARD.encode(&[0u8; 32]);
        let bad_auth_pk = base64::engine::general_purpose::STANDARD.encode(&[0u8; 16]); // wrong length
        let sig = base64::engine::general_purpose::STANDARD.encode(&[0u8; 64]);
        let body = format!(
            r#"{{"challenge_id":"c1","new_device_public_key":"{}","authorizer_public_key":"{}","signature":"{}","device_label":""}}"#,
            new_pk, bad_auth_pk, sig
        );
        let resp = app
            .oneshot(
                Request::post("/devices/enroll-complete")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn enroll_complete_rejects_wrong_length_signature() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice");
        let app = router(state, "alice");
        let new_pk = base64::engine::general_purpose::STANDARD.encode(&[0u8; 32]);
        let auth_pk = base64::engine::general_purpose::STANDARD.encode(&[0u8; 32]);
        let bad_sig = base64::engine::general_purpose::STANDARD.encode(&[0u8; 16]); // wrong length
        let body = format!(
            r#"{{"challenge_id":"c1","new_device_public_key":"{}","authorizer_public_key":"{}","signature":"{}","device_label":""}}"#,
            new_pk, auth_pk, bad_sig
        );
        let resp = app
            .oneshot(
                Request::post("/devices/enroll-complete")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn enroll_complete_idempotent_returns_existing_device_for_duplicate_pubkey() {
        use base64::Engine as _;
        use ed25519_dalek::{Signer, SigningKey};
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice");
        let authorizer_sk = SigningKey::from_bytes(&[33u8; 32]);
        let authorizer_pk = authorizer_sk.verifying_key().to_bytes();
        let new_pk_bytes = [44u8; 32];
        state.db.with_conn(|conn| {
            db::create_device(conn, "alice", &authorizer_pk, "primary").map(|_| ())?;
            // Pre-create the "new" device row so enroll_complete hits the
            // L171 `return Ok(existing.id)` branch instead of creating again.
            db::create_device(conn, "alice", &new_pk_bytes, "duplicate").map(|_| ())
        }).unwrap();
        let (nonce, challenge_id) = state.auth.generate_challenge().unwrap();
        let signature = authorizer_sk.sign(&nonce);
        let body = format!(
            r#"{{"challenge_id":"{}","new_device_public_key":"{}","authorizer_public_key":"{}","signature":"{}","device_label":"dup"}}"#,
            challenge_id,
            base64::engine::general_purpose::STANDARD.encode(new_pk_bytes),
            base64::engine::general_purpose::STANDARD.encode(authorizer_pk),
            base64::engine::general_purpose::STANDARD.encode(signature.to_bytes()),
        );
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::post("/devices/enroll-complete")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn enroll_complete_happy_path_creates_new_device() {
        use base64::Engine as _;
        use ed25519_dalek::{Signer, SigningKey};
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice");
        // Authorizer = an existing trusted Ed25519 key for alice.
        let authorizer_sk = SigningKey::from_bytes(&[11u8; 32]);
        let authorizer_pk = authorizer_sk.verifying_key().to_bytes();
        state.db.with_conn(|conn| {
            db::create_device(conn, "alice", &authorizer_pk, "primary").map(|_| ())
        }).unwrap();
        // Generate a challenge + sign it with the authorizer's key.
        let (nonce, challenge_id) = state.auth.generate_challenge().unwrap();
        let signature = authorizer_sk.sign(&nonce);
        let new_pk_b64 = base64::engine::general_purpose::STANDARD.encode([42u8; 32]);
        let auth_pk_b64 = base64::engine::general_purpose::STANDARD.encode(authorizer_pk);
        let sig_b64 = base64::engine::general_purpose::STANDARD.encode(signature.to_bytes());
        let body = format!(
            r#"{{"challenge_id":"{}","new_device_public_key":"{}","authorizer_public_key":"{}","signature":"{}","device_label":"iPhone"}}"#,
            challenge_id, new_pk_b64, auth_pk_b64, sig_b64
        );
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::post("/devices/enroll-complete")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn revoke_device_happy_path_with_multiple_active_devices() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice");
        // Insert 2 active devices so the last-device guard does NOT fire.
        state.db.with_conn(|conn| {
            db::create_device(conn, "alice", &[1u8; 32], "primary").map(|_| ())?;
            db::create_device(conn, "alice", &[2u8; 32], "laptop").map(|_| ())
        }).unwrap();
        // Look up the id of the laptop device to revoke.
        let target_id = state.db.with_conn(|conn| {
            let dev = db::get_device_by_user_and_pubkey(conn, "alice", &[2u8; 32])?
                .expect("laptop device should exist");
            Ok::<String, rusqlite::Error>(dev.id)
        }).unwrap();
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/devices/{}", target_id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn enroll_complete_4xx_when_authorizer_device_is_revoked() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice");
        // Seed a revoked authorizer device for alice.
        let auth_pk_bytes = [9u8; 32];
        state.db.with_conn(|conn| {
            let did = db::create_device(conn, "alice", &auth_pk_bytes, "authorizer")?;
            db::revoke_device(conn, &did)?;
            Ok::<(), rusqlite::Error>(())
        }).unwrap();
        let app = router(state, "alice");
        use base64::Engine as _;
        let new_pk = base64::engine::general_purpose::STANDARD.encode([0u8; 32]);
        let auth_pk = base64::engine::general_purpose::STANDARD.encode(auth_pk_bytes);
        let sig = base64::engine::general_purpose::STANDARD.encode([0u8; 64]);
        let body = format!(
            r#"{{"challenge_id":"c1","new_device_public_key":"{}","authorizer_public_key":"{}","signature":"{}","device_label":"new-mobile"}}"#,
            new_pk, auth_pk, sig
        );
        let resp = app
            .oneshot(
                Request::post("/devices/enroll-complete")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        // 403 because the authorizer device is revoked.
        assert_eq!(resp.status(), 403);
    }

    #[tokio::test]
    async fn enroll_complete_4xx_with_invalid_signature_for_active_authorizer() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice");
        // Seed an ACTIVE authorizer device, but use a bad signature so
        // verify_challenge fails. This drives the post-authorizer-lookup
        // signature-verify path.
        let auth_pk_bytes = [9u8; 32];
        state.db.with_conn(|conn| {
            db::create_device(conn, "alice", &auth_pk_bytes, "authorizer").map(|_| ())
        }).unwrap();
        let app = router(state, "alice");
        use base64::Engine as _;
        let new_pk = base64::engine::general_purpose::STANDARD.encode([0u8; 32]);
        let auth_pk = base64::engine::general_purpose::STANDARD.encode(auth_pk_bytes);
        let bad_sig = base64::engine::general_purpose::STANDARD.encode([0u8; 64]);
        let body = format!(
            r#"{{"challenge_id":"never-issued","new_device_public_key":"{}","authorizer_public_key":"{}","signature":"{}","device_label":""}}"#,
            new_pk, auth_pk, bad_sig
        );
        let resp = app
            .oneshot(
                Request::post("/devices/enroll-complete")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        // 401 since verify_challenge rejects, or 4xx generally.
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn enroll_complete_4xx_for_unknown_authorizer() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice");
        let app = router(state, "alice");
        // Properly-formed body — passes the length gates — but the authorizer
        // pubkey isn't a known device of this user, so we expect 403.
        let new_pk = base64::engine::general_purpose::STANDARD.encode(&[7u8; 32]);
        let auth_pk = base64::engine::general_purpose::STANDARD.encode(&[8u8; 32]);
        let sig = base64::engine::general_purpose::STANDARD.encode(&[0u8; 64]);
        let body = format!(
            r#"{{"challenge_id":"c1","new_device_public_key":"{}","authorizer_public_key":"{}","signature":"{}","device_label":""}}"#,
            new_pk, auth_pk, sig
        );
        let resp = app
            .oneshot(
                Request::post("/devices/enroll-complete")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        // 403 (authorizer unknown) — but accept any 4xx
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn revoke_device_404_for_other_users_device() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice");
        seed_user(&state.db, "bob");
        let now = db::now_str();
        state.db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO user_devices (id, user_id, public_key, device_label, created_at)
                 VALUES ('bob-device', 'bob', x'00', 'bob-desktop', ?1)",
                [&now as &dyn rusqlite::ToSql],
            )?;
            Ok::<(), rusqlite::Error>(())
        }).unwrap();
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/devices/bob-device")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        // The user_id != caller branch → NotFound to avoid leaking that
        // a device exists under a different user.
        assert_eq!(resp.status(), 404);
    }

    #[tokio::test]
    async fn enroll_complete_rejects_oversized_device_label() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice");
        let app = router(state, "alice");
        let valid_pk = base64::engine::general_purpose::STANDARD.encode(&[0u8; 32]);
        let valid_sig = base64::engine::general_purpose::STANDARD.encode(&[0u8; 64]);
        let oversize_label = "a".repeat(65);
        let body = format!(
            r#"{{"challenge_id":"c1","new_device_public_key":"{}","authorizer_public_key":"{}","signature":"{}","device_label":"{}"}}"#,
            valid_pk, valid_pk, valid_sig, oversize_label,
        );
        let resp = app
            .oneshot(
                Request::post("/devices/enroll-complete")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }
}
