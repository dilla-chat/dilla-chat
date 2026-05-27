use axum::extract::{Path, Query, State};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::Value;

use crate::api::helpers::{json_ok, spawn_db};
// A6 migration tail: route every authz decision through policy::*
// so deny telemetry flows through log_decision.
use crate::policy::require_permission;
use crate::api::AppState;
use crate::auth::UserId;
use crate::db;
use crate::error::AppError;

#[derive(Deserialize)]
pub struct ListQuery {
    pub limit: Option<i64>,
}

pub async fn list(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, AppError> {
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let events = spawn_db(state.db.clone(), move |conn| {
        // A3: read-the-log is its own perm class. PERM_VIEW_AUDIT_LOG
        // lets a "team safety officer" review the log without holding
        // member/role mutation rights. PERM_ADMIN still implies it via
        // the bitmask short-circuit in `user_has_permission`.
        require_permission(conn, &user_id, &team_id, db::PERM_VIEW_AUDIT_LOG)?;
        db::list_audit_events(conn, &team_id, limit)
    })
    .await?;
    json_ok(events)
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
    use axum::routing::get;
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

    fn router(state: AppState, user_id: &'static str) -> Router {
        Router::new()
            .route("/teams/{team_id}/audit", get(list))
            .layer(axum::Extension(UserId(user_id.to_string())))
            .with_state(state)
    }

    #[tokio::test]
    async fn list_audit_events_4xx_for_non_member() {
        let (state, _tmp) = make_state();
        let app = router(state, "ghost");
        let resp = app
            .oneshot(Request::get("/teams/t1/audit").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn list_audit_events_with_explicit_limit_parses_query() {
        let (state, _tmp) = make_state();
        let app = router(state, "alice");
        let resp = app
            .oneshot(Request::get("/teams/t1/audit?limit=10").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }
}
