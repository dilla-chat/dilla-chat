use axum::{
    extract::{Path, State},
    Extension, Json,
};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::api::AppState;
use crate::auth::UserId;
use crate::db;
use crate::error::AppError;

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
    Extension(UserId(_user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(target_user_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let tuid = target_user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let bundle = db::get_prekey_bundle(conn, &tuid)?
                .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;

            // Consume one OTP key if available.
            let one_time_prekey = db::consume_one_time_prekey(conn, &tuid)?;

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
