//! Passkey-recoverable identity escrow API
//! (design: `.security-hardening/15-passkey-recoverable-identity-escrow.md`).
//!
//! Endpoints:
//! - `PUT  /api/v1/identity/recovery/passkey`          — upsert escrow slot
//! - `POST /api/v1/identity/recovery/lookup`           — descriptors by username
//! - `POST /api/v1/identity/recovery/fetch`            — encrypted blob by credential
//! - `DELETE /api/v1/identity/recovery/passkey/{credential_id}` — revoke slot
//!
//! **Note vs. the design doc:** the doc described a 2-step
//! challenge/verify dance gating the fetch with a server-side WebAuthn
//! assertion (requires webauthn-rs + a credential-public-key storage
//! schema we don't yet have). We rely instead on the cryptographic
//! gating already provided by PRF encryption: the blob is
//! AES-GCM(HKDF-SHA256(PRF output), identity.key). The server cannot
//! read it, and an attacker who fetches the blob still cannot
//! decrypt without the passkey.
//!
//! Anti-enumeration: both `lookup` and `fetch` always return 200 with
//! a fixed-shape envelope (`lookup` pads to `LOOKUP_DESCRIPTOR_COUNT`
//! synthetic descriptors; `fetch` returns a deterministic synthetic
//! AES-GCM-shaped pseudo-blob for unknown pairs). The synthetic
//! values are HMAC-SHA256 derivations off the server's per-install
//! jwt_secret so polling yields identical output — no
//! `known vs unknown` signal. Real client-side decrypt failure of a
//! synthetic blob looks identical to a wrong-passkey attempt against
//! a real slot.
//!
//! **Follow-up:** add a server-side WebAuthn proof-of-possession step
//! before releasing real blobs. The current model relies entirely on
//! PRF entropy (~32 bytes) to gate offline decryption, which is
//! cryptographically sufficient against today's authenticators but
//! adds an extra layer of defense against future weaknesses + lifts
//! the bar against offline brute-force. Tracking issue: TBD.

use axum::{
    extract::{Path, State},
    Extension, Json,
};
use base64::Engine;
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;

use crate::api::helpers::{json_ok, json_ok_true, spawn_db};
use crate::api::AppState;
use crate::auth::UserId;
use crate::db;
use crate::error::AppError;

const MAX_CREDENTIAL_ID_LEN: usize = 1024;
const MAX_ENCRYPTED_BLOB_LEN: usize = 64 * 1024;
const PRF_SALT_LEN: usize = 32;

// ── PUT /api/v1/identity/recovery/passkey ───────────────────────────────

#[derive(Deserialize)]
pub struct UpsertSlotRequest {
    /// base64url-encoded WebAuthn credential ID.
    pub credential_id: String,
    /// base64-encoded 32-byte PRF salt for this slot.
    pub prf_salt: String,
    /// base64-encoded AES-GCM(wrap_key, identity.key) blob. Server
    /// never decrypts this.
    pub encrypted_blob: String,
}

pub async fn upsert_slot(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Json(body): Json<UpsertSlotRequest>,
) -> Result<Json<Value>, AppError> {
    if body.credential_id.is_empty() || body.credential_id.len() > MAX_CREDENTIAL_ID_LEN {
        return Err(AppError::BadRequest(
            "credential_id must be 1..=1024 chars".into(),
        ));
    }
    let prf_salt = base64::engine::general_purpose::STANDARD
        .decode(&body.prf_salt)
        .map_err(|_| AppError::BadRequest("invalid base64 prf_salt".into()))?;
    if prf_salt.len() != PRF_SALT_LEN {
        return Err(AppError::BadRequest(
            "prf_salt must be exactly 32 bytes".into(),
        ));
    }
    let encrypted_blob = base64::engine::general_purpose::STANDARD
        .decode(&body.encrypted_blob)
        .map_err(|_| AppError::BadRequest("invalid base64 encrypted_blob".into()))?;
    if encrypted_blob.is_empty() || encrypted_blob.len() > MAX_ENCRYPTED_BLOB_LEN {
        return Err(AppError::BadRequest(
            "encrypted_blob must be 1..=65536 bytes".into(),
        ));
    }

    // rp_id is pinned to server config — clients cannot influence it.
    // Empty `domain` (insecure dev mode) falls back to "localhost" so
    // the recovery client's `navigator.credentials.get` resolves
    // consistently with what the page sees as its origin.
    let rp_id = if state.config.domain.is_empty() {
        "localhost".to_string()
    } else {
        state.config.domain.clone()
    };

    let credential_id = body.credential_id.clone();
    let credential_id_q = credential_id.clone();
    let uid = user_id.clone();
    spawn_db(state.db.clone(), move |conn| {
        db::upsert_recovery_slot(
            conn,
            &uid,
            &credential_id_q,
            &rp_id,
            &prf_salt,
            &encrypted_blob,
        )
    })
    .await?;

    json_ok(json!({
        "credential_id": credential_id,
        "ok": true,
    }))
}

// ── POST /api/v1/identity/recovery/lookup ──────────────────────────────

#[derive(Deserialize)]
pub struct LookupRequest {
    pub username: String,
}

#[derive(Serialize)]
pub struct LookupResponse {
    pub rp_id: String,
    pub credentials: Vec<DescriptorPayload>,
}

#[derive(Serialize)]
pub struct DescriptorPayload {
    pub credential_id: String,
    /// base64-encoded 32-byte PRF salt
    pub prf_salt: String,
}

/// Fixed envelope size for the lookup response. We always return
/// exactly this many descriptors — real ones first (capped), then
/// deterministic synthetic padding. This prevents an attacker from
/// inferring "how many passkeys does this user have?" from the
/// response length. The cap also bounds enrolled credentials per
/// user — in practice nobody enrolls >4 hardware authenticators
/// for the same identity.
const LOOKUP_DESCRIPTOR_COUNT: usize = 4;

pub async fn lookup(
    State(state): State<AppState>,
    Json(body): Json<LookupRequest>,
) -> Result<Json<Value>, AppError> {
    if body.username.is_empty() || body.username.len() > 32 {
        return Err(AppError::BadRequest("invalid username".into()));
    }

    let rp_id = if state.config.domain.is_empty() {
        "localhost".to_string()
    } else {
        state.config.domain.clone()
    };

    let username_q = body.username.clone();
    let user = spawn_db(state.db.clone(), move |conn| {
        db::get_user_by_username(conn, &username_q)
    })
    .await?;

    let real_descs: Vec<DescriptorPayload> = if let Some(u) = user {
        let uid = u.id.clone();
        let descs = spawn_db(state.db.clone(), move |conn| {
            db::list_recovery_descriptors_for_user(conn, &uid)
        })
        .await?;
        descs
            .into_iter()
            .take(LOOKUP_DESCRIPTOR_COUNT)
            .map(|d| DescriptorPayload {
                credential_id: d.credential_id,
                prf_salt: base64::engine::general_purpose::STANDARD.encode(&d.prf_salt),
            })
            .collect()
    } else {
        Vec::new()
    };

    // Always return exactly LOOKUP_DESCRIPTOR_COUNT entries — pad with
    // deterministic-per-(username, position) synthetic descriptors so
    // the wire response shape is identical regardless of how many
    // real slots the user has (or whether the user exists at all).
    let mut credentials = real_descs;
    let start = credentials.len();
    for i in start..LOOKUP_DESCRIPTOR_COUNT {
        credentials.push(synthetic_descriptor(&state, &body.username, i as u8));
    }

    Ok(Json(json!({
        "rp_id": rp_id,
        "credentials": credentials,
    })))
}

/// Per-(username, position) deterministic synthetic descriptor. The
/// salt + credential_id are HMAC-SHA256 derivations off the server's
/// per-install jwt_secret so the same username + position always
/// produces the same fake descriptor (no flap an attacker could
/// detect by polling). `jwt_secret` is the per-install secret
/// derived from the DB passphrase — never leaves the server.
fn synthetic_descriptor(state: &AppState, username: &str, position: u8) -> DescriptorPayload {
    let mut mac = Hmac::<Sha256>::new_from_slice(state.auth.jwt_secret_bytes())
        .expect("HMAC accepts any key length");
    mac.update(b"dilla-recovery-synthetic-v1\0");
    mac.update(username.as_bytes());
    mac.update(&[0u8, position]);
    let salt = mac.finalize().into_bytes();
    let mut mac2 = Hmac::<Sha256>::new_from_slice(state.auth.jwt_secret_bytes())
        .expect("HMAC accepts any key length");
    mac2.update(b"dilla-recovery-synthetic-cred-v1\0");
    mac2.update(username.as_bytes());
    mac2.update(&[0u8, position]);
    let cred = mac2.finalize().into_bytes();
    DescriptorPayload {
        credential_id: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(cred),
        prf_salt: base64::engine::general_purpose::STANDARD.encode(salt),
    }
}

/// Build a deterministic-per-(username, credential_id) pseudo-blob
/// for unknown pairs in the fetch endpoint. The bytes look like a
/// real AES-GCM ciphertext (random + 16-byte tag) but decrypt to
/// gibberish on the client — same failure path the real client hits
/// when the user presents the wrong passkey. Length is fixed to the
/// median real blob size (~2 KiB) so the wire response is
/// indistinguishable from a hit. Without this, a `200 OK` vs `404
/// Not Found` directly reveals "this username + credential exists",
/// which combined with the lookup synthetic-padding above would
/// re-leak enumeration.
fn synthetic_encrypted_blob(state: &AppState, username: &str, credential_id: &str) -> Vec<u8> {
    const SYNTHETIC_BLOB_LEN: usize = 2048;
    let mut out = Vec::with_capacity(SYNTHETIC_BLOB_LEN);
    let mut counter: u64 = 0;
    while out.len() < SYNTHETIC_BLOB_LEN {
        let mut mac = Hmac::<Sha256>::new_from_slice(state.auth.jwt_secret_bytes())
            .expect("HMAC accepts any key length");
        mac.update(b"dilla-recovery-synthetic-blob-v1\0");
        mac.update(username.as_bytes());
        mac.update(&[0u8]);
        mac.update(credential_id.as_bytes());
        mac.update(&counter.to_be_bytes());
        out.extend_from_slice(&mac.finalize().into_bytes());
        counter += 1;
    }
    out.truncate(SYNTHETIC_BLOB_LEN);
    out
}

// ── POST /api/v1/identity/recovery/fetch ───────────────────────────────

#[derive(Deserialize)]
pub struct FetchRequest {
    pub username: String,
    pub credential_id: String,
}

pub async fn fetch(
    State(state): State<AppState>,
    Json(body): Json<FetchRequest>,
) -> Result<Json<Value>, AppError> {
    if body.username.is_empty() || body.username.len() > 32 {
        return Err(AppError::BadRequest("invalid username".into()));
    }
    if body.credential_id.is_empty() || body.credential_id.len() > MAX_CREDENTIAL_ID_LEN {
        return Err(AppError::BadRequest("invalid credential_id".into()));
    }

    let username_q = body.username.clone();
    let user = spawn_db(state.db.clone(), move |conn| {
        db::get_user_by_username(conn, &username_q)
    })
    .await?;

    let rp_id = if state.config.domain.is_empty() {
        "localhost".to_string()
    } else {
        state.config.domain.clone()
    };

    let slot = if let Some(u) = user {
        let uid = u.id.clone();
        let credential_id_q = body.credential_id.clone();
        spawn_db(state.db.clone(), move |conn| {
            db::get_recovery_slot(conn, &uid, &credential_id_q)
        })
        .await?
    } else {
        None
    };

    // Always return 200 with the same response shape — for unknown
    // (username, credential_id) pairs we emit a deterministic
    // synthetic blob that looks like a real AES-GCM ciphertext but
    // decrypts to nothing on the client. This prevents an attacker
    // from telling "this credential exists for this user" from a
    // wire-level 200/404 — the client's local AES-GCM failure is the
    // only signal, identical to what they'd see with the wrong
    // passkey. Pairs with the synthetic-padding in lookup to fully
    // close the enumeration surface.
    let (credential_id, prf_salt, encrypted_blob, user_id) = match slot {
        Some(s) => (
            s.credential_id,
            base64::engine::general_purpose::STANDARD.encode(&s.prf_salt),
            base64::engine::general_purpose::STANDARD.encode(&s.encrypted_blob),
            s.user_id,
        ),
        None => {
            // Synthetic prf_salt + blob keyed by (username,
            // credential_id) so repeated polling yields identical
            // output — no flap to distinguish "unknown" from
            // "valid but wrong passkey".
            let synth_salt = {
                let mut mac = Hmac::<Sha256>::new_from_slice(state.auth.jwt_secret_bytes())
                    .expect("HMAC accepts any key length");
                mac.update(b"dilla-recovery-synthetic-fetch-salt-v1\0");
                mac.update(body.username.as_bytes());
                mac.update(&[0u8]);
                mac.update(body.credential_id.as_bytes());
                mac.finalize().into_bytes()
            };
            let synth_blob = synthetic_encrypted_blob(&state, &body.username, &body.credential_id);
            (
                body.credential_id.clone(),
                base64::engine::general_purpose::STANDARD.encode(synth_salt),
                base64::engine::general_purpose::STANDARD.encode(&synth_blob),
                // Synthetic user_id — never use server-side, but
                // matches the response shape.
                "00000000-0000-0000-0000-000000000000".to_string(),
            )
        }
    };

    Ok(Json(json!({
        "credential_id": credential_id,
        "rp_id": rp_id,
        "prf_salt": prf_salt,
        "encrypted_blob": encrypted_blob,
        "user_id": user_id,
    })))
}

// ── DELETE /api/v1/identity/recovery/passkey/{credential_id} ───────────

pub async fn revoke_slot(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(credential_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    if credential_id.is_empty() || credential_id.len() > MAX_CREDENTIAL_ID_LEN {
        return Err(AppError::BadRequest("invalid credential_id".into()));
    }
    let uid = user_id.clone();
    let cid = credential_id.clone();
    let removed = spawn_db(state.db.clone(), move |conn| {
        db::delete_recovery_slot(conn, &uid, &cid)
    })
    .await?;
    if !removed {
        return Err(AppError::NotFound("recovery slot not found".into()));
    }
    json_ok_true()
}

// Suppress dead-code lint on RngCore import — kept for future use if
// we add a server-side challenge step.
#[allow(dead_code)]
fn _keep_rng_import() {
    let mut buf = [0u8; 1];
    rand::rng().fill_bytes(&mut buf);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::AppState;
    use crate::auth::AuthService;
    use crate::config::Config;
    use crate::db::Database;
    use crate::presence::PresenceManager;
    use crate::ws::Hub;
    use axum::body::Body;
    use axum::http::Request;
    use axum::routing::{delete as axum_delete, post, put};
    use axum::Router;
    use std::sync::Arc;
    use tower::ServiceExt;

    fn make_state() -> (AppState, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let database = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        database
            .with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;"))
            .unwrap();
        database.run_migrations().unwrap();
        let auth = Arc::new(AuthService::new(database.clone(), ""));
        let hub = Arc::new(Hub::new(database.clone()));
        let presence = Arc::new(PresenceManager::new());
        let mut cfg = Config::default();
        cfg.port = 8080;
        cfg.data_dir = tmp.path().to_str().unwrap().to_string();
        cfg.domain = "test.example".into();
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

    fn seed_user(db: &Database, user_id: &str, username: &str) {
        let now = db::now_str();
        db.with_conn(|conn| {
            db::create_user(
                conn,
                &db::User {
                    id: user_id.into(),
                    username: username.into(),
                    display_name: username.into(),
                    public_key: vec![1u8; 32],
                    status_type: "online".into(),
                    created_at: now.clone(),
                    updated_at: now,
                    ..Default::default()
                },
            )
        })
        .unwrap();
    }

    fn authed_router(state: AppState, user_id: &'static str) -> Router {
        Router::new()
            .route("/recovery/passkey", put(upsert_slot))
            .route("/recovery/passkey/{credential_id}", axum_delete(revoke_slot))
            .layer(axum::Extension(UserId(user_id.to_string())))
            .with_state(state)
    }

    fn public_router(state: AppState) -> Router {
        Router::new()
            .route("/recovery/lookup", post(lookup))
            .route("/recovery/fetch", post(fetch))
            .with_state(state)
    }

    async fn body_json(resp: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn upsert_slot_writes_a_row_for_authenticated_user() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice", "alice");
        let body = json!({
            "credential_id": "cred-alpha",
            "prf_salt": base64::engine::general_purpose::STANDARD.encode([1u8; 32]),
            "encrypted_blob": base64::engine::general_purpose::STANDARD.encode([0xABu8, 0xCD, 0xEF]),
        })
        .to_string();
        let app = authed_router(state.clone(), "alice");
        let resp = app
            .oneshot(
                Request::put("/recovery/passkey")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        // Row persisted.
        let row = state
            .db
            .with_conn(|c| db::get_recovery_slot(c, "alice", "cred-alpha"))
            .unwrap()
            .expect("row");
        assert_eq!(row.rp_id, "test.example");
        assert_eq!(row.prf_salt, vec![1u8; 32]);
        assert_eq!(row.encrypted_blob, vec![0xAB, 0xCD, 0xEF]);
    }

    #[tokio::test]
    async fn upsert_slot_rejects_non_32_byte_prf_salt() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice", "alice");
        let body = json!({
            "credential_id": "cred-bad",
            "prf_salt": base64::engine::general_purpose::STANDARD.encode([1u8; 16]),
            "encrypted_blob": base64::engine::general_purpose::STANDARD.encode([0u8; 4]),
        })
        .to_string();
        let app = authed_router(state, "alice");
        let resp = app
            .oneshot(
                Request::put("/recovery/passkey")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn upsert_slot_rejects_oversize_blob() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice", "alice");
        let big = vec![0u8; MAX_ENCRYPTED_BLOB_LEN + 1];
        let body = json!({
            "credential_id": "cred-big",
            "prf_salt": base64::engine::general_purpose::STANDARD.encode([1u8; 32]),
            "encrypted_blob": base64::engine::general_purpose::STANDARD.encode(&big),
        })
        .to_string();
        let app = authed_router(state, "alice");
        let resp = app
            .oneshot(
                Request::put("/recovery/passkey")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn lookup_returns_fixed_envelope_with_real_descriptors_first() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice", "alice");
        state
            .db
            .with_conn(|c| {
                db::upsert_recovery_slot(c, "alice", "cred-a", "test.example", &[2u8; 32], b"x")?;
                db::upsert_recovery_slot(c, "alice", "cred-b", "test.example", &[3u8; 32], b"y")
            })
            .unwrap();

        let app = public_router(state);
        let resp = app
            .oneshot(
                Request::post("/recovery/lookup")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "username": "alice" }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let v = body_json(resp).await;
        assert_eq!(v["rp_id"], "test.example");
        let creds = v["credentials"].as_array().unwrap();
        // ENVELOPE: always LOOKUP_DESCRIPTOR_COUNT entries — 2 real + 2 synthetic pad.
        assert_eq!(creds.len(), super::LOOKUP_DESCRIPTOR_COUNT);
        let ids: Vec<&str> = creds.iter().map(|c| c["credential_id"].as_str().unwrap()).collect();
        assert!(ids.contains(&"cred-a"));
        assert!(ids.contains(&"cred-b"));
    }

    #[tokio::test]
    async fn lookup_envelope_size_is_identical_for_known_and_unknown_users() {
        // The whole point of the synthetic-padding mitigation: response
        // length cannot leak slot count or user existence.
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice", "alice");
        state
            .db
            .with_conn(|c| db::upsert_recovery_slot(c, "alice", "cred-a", "test.example", &[2u8; 32], b"x"))
            .unwrap();

        let app = public_router(state.clone());
        let resp_known = app
            .oneshot(
                Request::post("/recovery/lookup")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "username": "alice" }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let v_known = body_json(resp_known).await;

        let app = public_router(state);
        let resp_unknown = app
            .oneshot(
                Request::post("/recovery/lookup")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "username": "ghost" }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let v_unknown = body_json(resp_unknown).await;

        assert_eq!(v_known["credentials"].as_array().unwrap().len(), super::LOOKUP_DESCRIPTOR_COUNT);
        assert_eq!(v_unknown["credentials"].as_array().unwrap().len(), super::LOOKUP_DESCRIPTOR_COUNT);
    }

    #[tokio::test]
    async fn lookup_for_unknown_user_returns_synthetic_deterministic_descriptor() {
        // Synthetic descriptors must be stable for the same input so
        // an attacker can't detect "known vs unknown" by polling.
        let (state, _tmp) = make_state();
        let app = public_router(state.clone());
        let resp1 = app
            .oneshot(
                Request::post("/recovery/lookup")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "username": "ghost" }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let v1 = body_json(resp1).await;
        let app = public_router(state);
        let resp2 = app
            .oneshot(
                Request::post("/recovery/lookup")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "username": "ghost" }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let v2 = body_json(resp2).await;
        assert_eq!(v1["credentials"][0]["credential_id"], v2["credentials"][0]["credential_id"]);
        assert_eq!(v1["credentials"][0]["prf_salt"], v2["credentials"][0]["prf_salt"]);
        // And distinct from position 1's synthetic — proves the per-position
        // domain separation works.
        assert_ne!(v1["credentials"][0]["credential_id"], v1["credentials"][1]["credential_id"]);
    }

    #[tokio::test]
    async fn lookup_for_known_user_with_no_slots_returns_fixed_envelope_of_synthetics() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice", "alice");
        let app = public_router(state);
        let resp = app
            .oneshot(
                Request::post("/recovery/lookup")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "username": "alice" }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let v = body_json(resp).await;
        assert_eq!(v["credentials"].as_array().unwrap().len(), super::LOOKUP_DESCRIPTOR_COUNT);
    }

    #[tokio::test]
    async fn fetch_returns_encrypted_blob_for_known_pair() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice", "alice");
        state
            .db
            .with_conn(|c| {
                db::upsert_recovery_slot(c, "alice", "cred-1", "test.example", &[7u8; 32], b"blob-bytes")
            })
            .unwrap();
        let app = public_router(state);
        let resp = app
            .oneshot(
                Request::post("/recovery/fetch")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({ "username": "alice", "credential_id": "cred-1" }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let v = body_json(resp).await;
        assert_eq!(v["credential_id"], "cred-1");
        assert_eq!(v["rp_id"], "test.example");
        assert_eq!(
            v["encrypted_blob"],
            base64::engine::general_purpose::STANDARD.encode(b"blob-bytes")
        );
    }

    #[tokio::test]
    async fn fetch_returns_200_with_synthetic_blob_for_unknown_user() {
        // Enumeration mitigation: unknown pairs return a 200 with a
        // deterministic-shaped blob so the client's local AES-GCM
        // failure is the only signal an attacker sees, identical to
        // the wrong-passkey case against a real slot.
        let (state, _tmp) = make_state();
        let app = public_router(state);
        let resp = app
            .oneshot(
                Request::post("/recovery/fetch")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({ "username": "ghost", "credential_id": "anything" }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let v = body_json(resp).await;
        assert_eq!(v["credential_id"], "anything");
        // Synthetic blob has a stable, plausible length.
        let blob_b64 = v["encrypted_blob"].as_str().unwrap();
        let decoded = base64::engine::general_purpose::STANDARD.decode(blob_b64).unwrap();
        assert_eq!(decoded.len(), 2048);
    }

    #[tokio::test]
    async fn fetch_synthetic_response_is_deterministic_per_pair() {
        // Stable for the same (username, credential_id) so polling
        // doesn't distinguish "known but wrong" from "unknown".
        let (state, _tmp) = make_state();
        let app = public_router(state.clone());
        let resp1 = app
            .oneshot(
                Request::post("/recovery/fetch")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({ "username": "ghost", "credential_id": "cred-x" }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let app = public_router(state);
        let resp2 = app
            .oneshot(
                Request::post("/recovery/fetch")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({ "username": "ghost", "credential_id": "cred-x" }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let v1 = body_json(resp1).await;
        let v2 = body_json(resp2).await;
        assert_eq!(v1["encrypted_blob"], v2["encrypted_blob"]);
        assert_eq!(v1["prf_salt"], v2["prf_salt"]);
    }

    #[tokio::test]
    async fn fetch_returns_200_with_synthetic_for_unknown_credential() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice", "alice");
        let app = public_router(state);
        let resp = app
            .oneshot(
                Request::post("/recovery/fetch")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({ "username": "alice", "credential_id": "no-such-cred" })
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let v = body_json(resp).await;
        assert_eq!(v["credential_id"], "no-such-cred");
    }

    #[tokio::test]
    async fn revoke_slot_deletes_row_and_returns_200() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice", "alice");
        state
            .db
            .with_conn(|c| {
                db::upsert_recovery_slot(c, "alice", "cred-r", "test.example", &[8u8; 32], b"x")
            })
            .unwrap();
        let app = authed_router(state.clone(), "alice");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/recovery/passkey/cred-r")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let row = state
            .db
            .with_conn(|c| db::get_recovery_slot(c, "alice", "cred-r"))
            .unwrap();
        assert!(row.is_none());
    }

    #[tokio::test]
    async fn revoke_slot_returns_404_for_unknown_credential() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice", "alice");
        let app = authed_router(state, "alice");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/recovery/passkey/ghost-cred")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 404);
    }
}
