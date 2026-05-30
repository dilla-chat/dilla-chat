// User block list. Block / unblock / list endpoints scoped to the
// caller — there's no admin-managed view. WS hub enforcement (filtering
// message:new broadcasts) lives in ws/hub.rs.

use axum::extract::{Path, State};
use axum::{Extension, Json};
use serde_json::Value;

use crate::api::helpers::{json_ok, json_ok_true, spawn_db};
use crate::api::AppState;
use crate::auth::UserId;
use crate::db;
use crate::error::AppError;

pub async fn list(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
) -> Result<Json<Value>, AppError> {
    let ids = spawn_db(state.db.clone(), move |conn| db::list_blocked(conn, &user_id)).await?;
    json_ok(serde_json::json!({ "user_ids": ids }))
}

pub async fn block(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(blocked_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    if user_id == blocked_id {
        return Err(AppError::BadRequest("you cannot block yourself".into()));
    }
    let blocker = user_id.clone();
    let blocked = blocked_id.clone();
    spawn_db(state.db.clone(), move |conn| {
        // Verify the target exists. Without this a typo'd id silently
        // succeeds because INSERT OR IGNORE swallows constraint errors.
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM users WHERE id = ?1 LIMIT 1",
                rusqlite::params![blocked],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if !exists {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        db::block_user(conn, &blocker, &blocked)
    })
    .await
    .map_err(|e| match e {
        AppError::NotFound(_) => AppError::NotFound("user not found".into()),
        other => other,
    })?;
    json_ok_true()
}

pub async fn unblock(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(blocked_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let blocker = user_id.clone();
    let blocked = blocked_id.clone();
    spawn_db(state.db.clone(), move |conn| {
        db::unblock_user(conn, &blocker, &blocked)
    })
    .await?;
    json_ok_true()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::AuthService;
    use crate::config::Config;
    use crate::db::Database;
    use crate::presence::PresenceManager;
    use crate::ws::Hub;
    use axum::body::Body;
    use axum::http::Request;
    use axum::routing::{delete, get, post};
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

    fn seed_users(db: &Database) {
        let now = db::now_str();
        db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: "alice".into(),
                username: "alice".into(),
                display_name: "Alice".into(),
                public_key: vec![1u8; 32],
                status_type: "online".into(),
                created_at: now.clone(),
                updated_at: now.clone(),
                ..Default::default()
            })?;
            db::create_user(conn, &db::User {
                id: "bob".into(),
                username: "bob".into(),
                display_name: "Bob".into(),
                public_key: vec![2u8; 32],
                status_type: "online".into(),
                created_at: now.clone(),
                updated_at: now,
                ..Default::default()
            })?;
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    fn router(state: AppState, user_id: &'static str) -> Router {
        Router::new()
            .route("/blocks", get(list))
            .route("/blocks/{blocked_id}", post(block))
            .route("/blocks/{blocked_id}", delete(unblock))
            .layer(axum::Extension(UserId(user_id.to_string())))
            .with_state(state)
    }

    #[tokio::test]
    async fn list_returns_empty_user_ids_when_no_blocks_exist() {
        let (state, _tmp) = make_state();
        seed_users(&state.db);
        let app = router(state, "alice");
        let resp = app
            .oneshot(Request::get("/blocks").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["user_ids"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn block_self_returns_400() {
        let (state, _tmp) = make_state();
        seed_users(&state.db);
        let app = router(state, "alice");
        let resp = app
            .oneshot(Request::post("/blocks/alice").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn block_unknown_target_returns_404() {
        let (state, _tmp) = make_state();
        seed_users(&state.db);
        let app = router(state, "alice");
        let resp = app
            .oneshot(Request::post("/blocks/ghost").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), 404);
    }

    #[tokio::test]
    async fn block_then_list_shows_target_user() {
        let (state, _tmp) = make_state();
        seed_users(&state.db);
        let app = router(state, "alice");
        let resp = app
            .clone()
            .oneshot(Request::post("/blocks/bob").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let resp = app
            .oneshot(Request::get("/blocks").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let ids = json["user_ids"].as_array().unwrap();
        assert!(ids.iter().any(|v| v == "bob"), "got: {:?}", ids);
    }

    #[tokio::test]
    async fn unblock_returns_200_even_for_never_blocked_user() {
        let (state, _tmp) = make_state();
        seed_users(&state.db);
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/blocks/bob")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }
}
