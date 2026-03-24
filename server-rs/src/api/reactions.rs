use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde_json::{json, Value};

use crate::api::helpers::{json_ok, json_ok_true, map_not_found, require_team_member, spawn_db};
use crate::api::AppState;
use crate::auth::UserId;
use crate::db;
use crate::error::AppError;

pub async fn add(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, channel_id, message_id, emoji)): Path<(String, String, String, String)>,
) -> Result<Json<Value>, AppError> {
    let reaction = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id, &team_id)?;

        // Verify message exists.
        if db::get_message_by_id(conn, &message_id)?.is_none() {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }

        db::add_reaction(conn, &message_id, &user_id, &emoji)
    })
    .await
    .map_err(map_not_found("message"))?;

    let event_data = serde_json::to_vec(&json!({
        "type": "reaction:added",
        "payload": {
            "message_id": reaction.message_id,
            "channel_id": channel_id,
            "user_id": reaction.user_id,
            "emoji": reaction.emoji,
        },
    }))
    .unwrap_or_default();
    state
        .hub
        .broadcast_to_channel(&channel_id, event_data, None)
        .await;

    json_ok(reaction)
}

pub async fn remove(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, channel_id, message_id, emoji)): Path<(String, String, String, String)>,
) -> Result<Json<Value>, AppError> {
    let uid = user_id.clone();
    let mid = message_id.clone();
    let em = emoji.clone();
    spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &uid, &team_id)?;
        db::remove_reaction(conn, &mid, &uid, &em)
    })
    .await?;

    let event_data = serde_json::to_vec(&json!({
        "type": "reaction:removed",
        "payload": {
            "message_id": message_id,
            "channel_id": channel_id,
            "user_id": user_id,
            "emoji": emoji,
        },
    }))
    .unwrap_or_default();
    state
        .hub
        .broadcast_to_channel(&channel_id, event_data, None)
        .await;

    json_ok_true()
}

pub async fn list(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, _channel_id, message_id)): Path<(String, String, String)>,
) -> Result<Json<Value>, AppError> {
    let reactions = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id, &team_id)?;
        db::get_message_reactions(conn, &message_id)
    })
    .await?;

    json_ok(reactions)
}
