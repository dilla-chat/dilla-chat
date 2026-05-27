use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde_json::{json, Value};

use crate::api::helpers::{json_ok, json_ok_true, map_not_found, spawn_db};
// A6 migration tail: route authz through policy::*.
use crate::policy::require_team_member;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::{AuthService, UserId};
    use crate::config::Config;
    use crate::db::Database;
    use crate::presence::PresenceManager;
    use crate::ws::Hub;
    use axum::body::Body;
    use axum::http::Request;
    use axum::routing::{get, post, delete as axum_delete};
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
            .route("/teams/{team_id}/channels/{channel_id}/messages/{message_id}/reactions", get(list))
            .route("/teams/{team_id}/channels/{channel_id}/messages/{message_id}/reactions/{emoji}",
                post(add).delete(axum_delete(remove)))
            .layer(axum::Extension(UserId(user_id.to_string())))
            .with_state(state)
    }

    #[tokio::test]
    async fn list_reactions_4xx_for_non_member() {
        let (state, _tmp) = make_state();
        let app = router(state, "ghost");
        let resp = app
            .oneshot(
                Request::get("/teams/t1/channels/ch1/messages/m1/reactions").body(Body::empty()).unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn add_reaction_4xx_for_non_member() {
        let (state, _tmp) = make_state();
        let app = router(state, "ghost");
        let resp = app
            .oneshot(
                Request::post("/teams/t1/channels/ch1/messages/m1/reactions/%F0%9F%94%A5").body(Body::empty()).unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn remove_reaction_4xx_for_non_member() {
        let (state, _tmp) = make_state();
        let app = router(state, "ghost");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/teams/t1/channels/ch1/messages/m1/reactions/%F0%9F%94%A5")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }
}
