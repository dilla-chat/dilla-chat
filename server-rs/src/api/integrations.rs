// Per-team integrations admin (Giphy key only for now). Reads + writes
// the `settings` key-value table under `team:<tid>:giphy_api_key`. The
// GET endpoint never returns the key itself — only `configured` so the
// UI can show a status pill without exposing the secret to any team
// member who happens to call the endpoint.

use axum::extract::{Path, State};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::Value;

use crate::api::helpers::{json_ok, spawn_db};
// A6 migration tail: route authz through policy::*.
use crate::policy::{require_permission, require_team_member};
use crate::api::AppState;
use crate::auth::UserId;
use crate::db;
use crate::error::AppError;

fn giphy_key(team_id: &str) -> String {
    format!("team:{}:giphy_api_key", team_id)
}

pub async fn get_giphy(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let team_id_clone = team_id.clone();
    let configured = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id, &team_id_clone)?;
        let v = db::get_setting(conn, &giphy_key(&team_id_clone))?;
        Ok::<_, rusqlite::Error>(v.map(|s| !s.trim().is_empty()).unwrap_or(false))
    })
    .await?;
    json_ok(serde_json::json!({ "configured": configured }))
}

#[derive(Deserialize)]
pub struct SetGiphyRequest {
    /// New key; empty string clears the existing one.
    pub api_key: String,
}

pub async fn set_giphy(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
    Json(body): Json<SetGiphyRequest>,
) -> Result<Json<Value>, AppError> {
    let trimmed = body.api_key.trim().to_string();
    if trimmed.chars().count() > 256 {
        return Err(AppError::BadRequest("api_key too long".into()));
    }
    let team_id_clone = team_id.clone();
    let user_id_clone = user_id.clone();
    let trimmed_clone = trimmed.clone();
    spawn_db(state.db.clone(), move |conn| {
        require_permission(conn, &user_id_clone, &team_id_clone, db::PERM_ADMIN)?;
        db::set_setting(conn, &giphy_key(&team_id_clone), &trimmed_clone)?;
        let _ = db::insert_audit_event(
            conn,
            &team_id_clone,
            Some(&user_id_clone),
            if trimmed_clone.is_empty() { "integration.giphy.clear" } else { "integration.giphy.set" },
            Some("integration"),
            Some("giphy"),
            None,
        );
        Ok::<_, rusqlite::Error>(())
    })
    .await?;
    json_ok(serde_json::json!({ "configured": !trimmed.is_empty() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_giphy_request_requires_api_key() {
        let r: SetGiphyRequest = serde_json::from_str(r#"{"api_key":"k"}"#).unwrap();
        assert_eq!(r.api_key, "k");
        assert!(serde_json::from_str::<SetGiphyRequest>("{}").is_err());
    }

    #[test]
    fn set_giphy_request_empty_key_clears_existing() {
        // Per the doc comment on api_key: empty string clears the
        // existing key. We test that the parser accepts an empty
        // string without rejecting it.
        let r: SetGiphyRequest = serde_json::from_str(r#"{"api_key":""}"#).unwrap();
        assert_eq!(r.api_key, "");
    }
}
