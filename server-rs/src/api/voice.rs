use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde_json::{json, Value};

use crate::api::AppState;
use crate::auth::UserId;
use crate::error::AppError;

pub async fn get_room(
    Extension(UserId(_user_id)): Extension<UserId>,
    State(_state): State<AppState>,
    Path((_team_id, _channel_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    // Stub: voice rooms are managed via WebSocket signaling.
    Ok(Json(json!({
        "participants": [],
    })))
}
