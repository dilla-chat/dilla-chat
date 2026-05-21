use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::api::AppState;
use crate::auth::UserId;
use crate::db;
use crate::error::AppError;

#[derive(Deserialize, Default)]
pub struct GetBundleQuery {
    /// When true, the caller is explicitly starting an X3DH session and
    /// asks the server to atomically pop a one-time prekey. Drive-by
    /// fetches (identity-key lookups, safety-number recomputation) leave
    /// this off and the server returns an empty OTPK array. VULN-006:
    /// the previous implementation drained an OTPK on every call,
    /// letting any logged-in user iterate every user_id and exhaust the
    /// keyspace.
    #[serde(default)]
    pub initiate: bool,
}

#[derive(Deserialize)]
pub struct UploadPrekeyRequest {
    pub identity_key: String,
    /// X25519 public DH key (base64). Required for X3DH's DH2 step;
    /// the Ed25519 `identity_key` above can't be used for raw DH.
    pub identity_dh_key: String,
    pub signed_prekey: String,
    pub signed_prekey_signature: String,
    #[serde(default)]
    pub one_time_prekeys: Vec<String>,
}

pub async fn upload(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Json(body): Json<UploadPrekeyRequest>,
) -> Result<Json<Value>, AppError> {
    let identity_key = base64::engine::general_purpose::STANDARD
        .decode(&body.identity_key)
        .map_err(|_| AppError::BadRequest("invalid base64 identity_key".into()))?;

    let identity_dh_key = base64::engine::general_purpose::STANDARD
        .decode(&body.identity_dh_key)
        .map_err(|_| AppError::BadRequest("invalid base64 identity_dh_key".into()))?;

    let signed_prekey = base64::engine::general_purpose::STANDARD
        .decode(&body.signed_prekey)
        .map_err(|_| AppError::BadRequest("invalid base64 signed_prekey".into()))?;

    let signed_prekey_signature = base64::engine::general_purpose::STANDARD
        .decode(&body.signed_prekey_signature)
        .map_err(|_| AppError::BadRequest("invalid base64 signed_prekey_signature".into()))?;

    // Store one-time prekeys as JSON array of base64 strings.
    let otpk_json = serde_json::to_vec(&body.one_time_prekeys)
        .map_err(|e| AppError::Internal(format!("serialize prekeys: {}", e)))?;

    let db = state.db.clone();
    let uid = user_id.clone();

    tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let bundle = db::PrekeyBundle {
                id: db::new_id(),
                user_id: uid,
                identity_key,
                identity_dh_key,
                signed_prekey,
                signed_prekey_signature,
                one_time_prekeys: otpk_json,
                uploaded_at: db::now_str(),
            };
            db::save_prekey_bundle(conn, &bundle)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?
    .map_err(|e| AppError::Internal(format!("db: {}", e)))?;

    Ok(Json(json!({ "ok": true })))
}

pub async fn get_bundle(
    Extension(UserId(caller_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(target_user_id): Path<String>,
    Query(q): Query<GetBundleQuery>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let tuid = target_user_id.clone();
    let cid = caller_id.clone();
    let initiate = q.initiate;

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            // VULN-006: shared-team gate. Anyone with a JWT used to be
            // able to iterate every user_id and (a) deanonymize via
            // identity_key, (b) drain OTPKs to force "no OTPK"
            // forward-secrecy degradation. Refuse the lookup unless
            // caller and target are in at least one team together.
            if !db::users_share_team(conn, &cid, &tuid)? {
                return Err(rusqlite::Error::InvalidParameterName(
                    "prekey bundle unavailable".into(),
                ));
            }

            let bundle = db::get_prekey_bundle(conn, &tuid)?
                .ok_or(rusqlite::Error::QueryReturnedNoRows)?;

            // VULN-006: only consume an OTPK when the caller declares
            // they're starting an X3DH session via ?initiate=true.
            // Drive-by lookups (safety-number checks, UI presence
            // resolution) leave the keyspace alone.
            let one_time_prekey = if initiate {
                db::consume_one_time_prekey(conn, &tuid)?
            } else {
                None
            };

            let identity_key_b64 =
                base64::engine::general_purpose::STANDARD.encode(&bundle.identity_key);
            let identity_dh_key_b64 =
                base64::engine::general_purpose::STANDARD.encode(&bundle.identity_dh_key);
            let signed_prekey_b64 =
                base64::engine::general_purpose::STANDARD.encode(&bundle.signed_prekey);
            let sig_b64 =
                base64::engine::general_purpose::STANDARD.encode(&bundle.signed_prekey_signature);
            // Wire format returns `one_time_prekeys` as an array
            // (length 0 or 1 — we consume at most one). Keeping the
            // field as an array means the client doesn't need a
            // singular/plural-aware parser.
            let otpk_array: Vec<String> = match one_time_prekey {
                Some(k) => vec![base64::engine::general_purpose::STANDARD.encode(&k)],
                None => vec![],
            };

            Ok(json!({
                "user_id": bundle.user_id,
                "identity_key": identity_key_b64,
                "identity_dh_key": identity_dh_key_b64,
                "signed_prekey": signed_prekey_b64,
                "signed_prekey_signature": sig_b64,
                "one_time_prekeys": otpk_array,
            }))
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(bundle) => Ok(Json(bundle)),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(AppError::NotFound("prekey bundle not found".into()))
        }
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

pub async fn delete_own(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let uid = user_id.clone();

    tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| db::delete_prekey_bundle(conn, &uid))
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?
    .map_err(|e| AppError::Internal(format!("db: {}", e)))?;

    Ok(Json(json!({ "ok": true })))
}
