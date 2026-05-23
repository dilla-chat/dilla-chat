use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::api::AppState;
use crate::auth::UserId;
use crate::error::AppError;
use crate::presence::Status;

#[derive(Deserialize)]
pub struct UpdatePresenceRequest {
    pub status: String,
    #[serde(default)]
    pub custom_status: String,
}

pub async fn get_all(
    Extension(UserId(_user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(_team_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let presences = state.presence.get_all_presences().await;
    Ok(Json(json!(presences)))
}

pub async fn get_user(
    Extension(UserId(_user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((_team_id, target_user_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let presence = state.presence.get_presence(&target_user_id).await;
    match presence {
        Some(p) => Ok(Json(json!(p))),
        None => Ok(Json(json!({
            "user_id": target_user_id,
            "status": "offline",
            "custom_status": "",
        }))),
    }
}

pub async fn update_own(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(_team_id): Path<String>,
    Json(body): Json<UpdatePresenceRequest>,
) -> Result<Json<Value>, AppError> {
    let status = Status::from_str(&body.status);
    state
        .presence
        .update_presence(&user_id, status, &body.custom_status)
        .await;

    Ok(Json(json!({
        "user_id": user_id,
        "status": status.as_str(),
        "custom_status": body.custom_status,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_presence_requires_status_but_custom_status_defaults_empty() {
        let r: UpdatePresenceRequest = serde_json::from_str(r#"{"status":"online"}"#).unwrap();
        assert_eq!(r.status, "online");
        assert_eq!(r.custom_status, "");
    }

    #[test]
    fn update_presence_rejects_missing_status() {
        assert!(serde_json::from_str::<UpdatePresenceRequest>("{}").is_err());
    }

    #[test]
    fn update_presence_accepts_dnd_idle_offline() {
        for s in ["online", "idle", "dnd", "offline"] {
            let body = format!(r#"{{"status":"{s}"}}"#);
            let r: UpdatePresenceRequest = serde_json::from_str(&body).unwrap();
            assert_eq!(r.status, s);
        }
    }
}
