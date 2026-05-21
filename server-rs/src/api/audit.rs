use axum::extract::{Path, Query, State};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::Value;

use crate::api::helpers::{json_ok, require_permission, spawn_db};
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
        // Any team admin (manage-roles or manage-members or manage-team) can
        // read the log; use manage-team as the gating check.
        require_permission(conn, &user_id, &team_id, db::PERM_MANAGE_TEAM)?;
        db::list_audit_events(conn, &team_id, limit)
    })
    .await?;
    json_ok(events)
}
