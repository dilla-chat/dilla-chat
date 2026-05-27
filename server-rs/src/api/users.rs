use axum::{extract::State, Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::api::AppState;
use crate::auth::UserId;
use crate::db;
use crate::error::AppError;

#[derive(Deserialize)]
pub struct UpdateMeRequest {
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub status_text: Option<String>,
    pub status_type: Option<String>,
    pub quiet_hours_enabled: Option<bool>,
    pub quiet_hours_from: Option<String>,
    pub quiet_hours_to: Option<String>,
}

#[derive(Deserialize)]
pub struct IdentityBlobRequest {
    pub blob: String,
}

pub async fn get_me(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let uid = user_id.clone();

    let user = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| db::get_user_by_id(conn, &uid))
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?
    .map_err(|e| AppError::Internal(format!("db: {}", e)))?
    .ok_or_else(|| AppError::NotFound("user not found".into()))?;

    Ok(Json(json!(user)))
}

pub async fn update_me(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Json(body): Json<UpdateMeRequest>,
) -> Result<Json<Value>, AppError> {
    if let Some(ref dn) = body.display_name {
        if dn.len() > 64 {
            return Err(AppError::BadRequest("display_name too long (max 64 chars)".into()));
        }
    }
    if let Some(ref st) = body.status_text {
        if st.len() > 128 {
            return Err(AppError::BadRequest("status_text too long (max 128 chars)".into()));
        }
    }

    let db = state.db.clone();
    let uid = user_id.clone();

    let user = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let mut user = db::get_user_by_id(conn, &uid)?
                .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;

            if let Some(ref dn) = body.display_name {
                user.display_name = dn.clone();
            }
            if let Some(ref av) = body.avatar_url {
                user.avatar_url = av.clone();
            }
            if let Some(ref st) = body.status_text {
                user.status_text = st.clone();
            }
            if let Some(ref st) = body.status_type {
                user.status_type = st.clone();
            }
            if let Some(en) = body.quiet_hours_enabled {
                user.quiet_hours_enabled = en;
            }
            if let Some(ref from) = body.quiet_hours_from {
                // Cheap HH:MM validation — rejects empty + obviously off-shape
                // values without pulling in a full chrono parse.
                if !is_valid_hh_mm(from) {
                    return Err(rusqlite::Error::InvalidParameterName(
                        "quiet_hours_from must be HH:MM".into(),
                    ));
                }
                user.quiet_hours_from = from.clone();
            }
            if let Some(ref to) = body.quiet_hours_to {
                if !is_valid_hh_mm(to) {
                    return Err(rusqlite::Error::InvalidParameterName(
                        "quiet_hours_to must be HH:MM".into(),
                    ));
                }
                user.quiet_hours_to = to.clone();
            }

            db::update_user(conn, &user)?;
            Ok(user)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?
    .map_err(|e| AppError::Internal(format!("db: {}", e)))?;

    Ok(Json(json!(user)))
}

pub async fn get_identity_blob(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let uid = user_id.clone();

    let blob = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| db::get_identity_blob(conn, &uid))
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?
    .map_err(|e| AppError::Internal(format!("db: {}", e)))?;

    Ok(Json(json!({
        "blob": blob.unwrap_or_default(),
    })))
}

pub async fn delete_me(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| db::delete_user(conn, &uid))
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(()) => Ok(Json(json!({ "ok": true }))),
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::BadRequest(msg)),
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

/// Cheap "HH:MM" check — accepts 00:00..23:59, no whitespace, exact width.
/// Avoids pulling chrono just to validate two two-digit fields.
fn is_valid_hh_mm(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' { return false; }
    let h: u8 = match s[0..2].parse() { Ok(n) => n, Err(_) => return false };
    let m: u8 = match s[3..5].parse() { Ok(n) => n, Err(_) => return false };
    h < 24 && m < 60
}

/// Cap on the identity-blob upload, in bytes. 64 KiB is comfortably
/// larger than the Signal Protocol session export but small enough that
/// an attacker can't fill the table with unbounded payloads. VULN-013 / H6.
const MAX_IDENTITY_BLOB_BYTES: usize = 64 * 1024;

pub async fn put_identity_blob(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Json(body): Json<IdentityBlobRequest>,
) -> Result<Json<Value>, AppError> {
    // VULN-013 / H6: refuse blobs larger than 64 KiB. Returning the
    // same shape (BadRequest) as other size-cap violations — axum will
    // surface a 413 only when the body exceeds the per-route limit
    // layer, but we don't have one configured for this route; 400 is
    // the closest substitute and tells the client this is a hard cap.
    if body.blob.as_bytes().len() > MAX_IDENTITY_BLOB_BYTES {
        return Err(AppError::PayloadTooLarge(format!(
            "identity_blob too large (max {} bytes)",
            MAX_IDENTITY_BLOB_BYTES
        )));
    }

    let db = state.db.clone();
    let uid = user_id.clone();
    let blob = body.blob.clone();

    tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| db::upsert_identity_blob(conn, &uid, &blob))
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?
    .map_err(|e| AppError::Internal(format!("db: {}", e)))?;

    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_valid_hh_mm_accepts_valid_times() {
        assert!(is_valid_hh_mm("00:00"));
        assert!(is_valid_hh_mm("09:30"));
        assert!(is_valid_hh_mm("23:59"));
        assert!(is_valid_hh_mm("12:00"));
    }

    #[test]
    fn is_valid_hh_mm_rejects_invalid_shapes() {
        assert!(!is_valid_hh_mm(""));
        assert!(!is_valid_hh_mm("9:30"));
        assert!(!is_valid_hh_mm("09-30"));
        assert!(!is_valid_hh_mm("0930"));
        assert!(!is_valid_hh_mm("09:30:00"));
    }

    #[test]
    fn is_valid_hh_mm_rejects_out_of_range() {
        assert!(!is_valid_hh_mm("24:00"));
        assert!(!is_valid_hh_mm("99:59"));
        assert!(!is_valid_hh_mm("00:60"));
        assert!(!is_valid_hh_mm("ab:cd"));
    }

    // ── axum integration tests for update_me + put_identity_blob ──

    use crate::api::AppState;
    use crate::auth::{AuthService, UserId};
    use crate::config::Config;
    use crate::db::Database;
    use crate::presence::PresenceManager;
    use crate::ws::Hub;
    use axum::body::Body;
    use axum::http::Request;
    use axum::routing::{get, patch, put};
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
        db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: user_id.into(),
                username: user_id.into(),
                display_name: user_id.into(),
                public_key: vec![1u8; 32],
                status_type: "online".into(),
                quiet_hours_enabled: false,
                quiet_hours_from: "22:00".into(),
                quiet_hours_to: "07:30".into(),
                created_at: now.clone(),
                updated_at: now,
                ..Default::default()
            })
        })
        .unwrap();
    }

    fn router(state: AppState, user_id: &'static str) -> Router {
        Router::new()
            .route("/users/me", get(get_me))
            .route("/users/me", patch(update_me))
            .route("/users/me/identity-blob", put(put_identity_blob))
            .layer(axum::Extension(UserId(user_id.to_string())))
            .with_state(state)
    }

    #[tokio::test]
    async fn update_me_rejects_oversized_display_name() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice");
        let app = router(state, "alice");
        let oversized = "a".repeat(65);
        let body = format!(r#"{{"display_name":"{}"}}"#, oversized);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/users/me")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn update_me_rejects_oversized_status_text() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice");
        let app = router(state, "alice");
        let oversized = "a".repeat(129);
        let body = format!(r#"{{"status_text":"{}"}}"#, oversized);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/users/me")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn update_me_rejects_invalid_quiet_hours_from_shape() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice");
        let app = router(state, "alice");
        let body = r#"{"quiet_hours_from":"bogus"}"#;
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/users/me")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status() == 500 || resp.status() == 400);
    }

    #[tokio::test]
    async fn update_me_happy_path_updates_display_name_and_status() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice");
        let app = router(state, "alice");
        let body = r#"{"display_name":"Alice Wonder","status_text":"coding"}"#;
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/users/me")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn put_identity_blob_rejects_oversized_payload() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice");
        let app = router(state, "alice");
        let huge_blob = "a".repeat(65 * 1024);
        let body = format!(r#"{{"blob":"{}"}}"#, huge_blob);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/users/me/identity-blob")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 413);
    }

    #[tokio::test]
    async fn put_identity_blob_accepts_small_payload() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice");
        let app = router(state, "alice");
        let body = r#"{"blob":"hello-world-blob"}"#;
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/users/me/identity-blob")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn get_me_returns_user_record() {
        let (state, _tmp) = make_state();
        seed_user(&state.db, "alice");
        let app = router(state, "alice");
        let resp = app
            .oneshot(Request::get("/users/me").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }
}
