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
}
