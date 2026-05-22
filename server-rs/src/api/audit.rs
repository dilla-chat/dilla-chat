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
