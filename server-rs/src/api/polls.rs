use axum::extract::{Path, State};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::Value;

use crate::api::helpers::{json_ok, spawn_db};
// A6 migration tail: route authz through policy::*.
use crate::policy::require_team_member;
use crate::api::AppState;
use crate::auth::UserId;
use crate::db;
use crate::error::AppError;
use crate::ws::events::Event;

#[derive(Deserialize)]
pub struct CreatePollRequest {
    pub question: String,
    pub options: Vec<String>,
}

#[derive(Deserialize)]
pub struct VoteRequest {
    pub option_index: i64,
}

pub async fn list_for_channel(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, channel_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let polls = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id, &team_id)?;
        let polls = db::get_polls_by_channel(conn, &channel_id)?;
        let mut out = Vec::with_capacity(polls.len());
        for p in polls {
            let votes = db::get_votes_for_poll(conn, &p.id)?;
            out.push(poll_with_votes(p, votes));
        }
        Ok(out)
    })
    .await?;
    json_ok(polls)
}

pub async fn create(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, channel_id)): Path<(String, String)>,
    Json(body): Json<CreatePollRequest>,
) -> Result<Json<Value>, AppError> {
    if body.question.trim().is_empty() {
        return Err(AppError::BadRequest("question is required".into()));
    }
    if body.options.len() < 2 {
        return Err(AppError::BadRequest("at least two options required".into()));
    }
    if body.options.len() > 12 {
        return Err(AppError::BadRequest("too many options (max 12)".into()));
    }

    let team_id_clone = team_id.clone();
    let channel_id_clone = channel_id.clone();
    let user_id_clone = user_id.clone();
    let poll = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id_clone, &team_id_clone)?;
        let options_json = serde_json::to_string(&body.options)
            .map_err(|e| rusqlite::Error::InvalidParameterName(e.to_string()))?;
        let poll = db::Poll {
            id: db::new_id(),
            team_id: team_id_clone.clone(),
            channel_id: channel_id_clone.clone(),
            question: body.question.trim().to_string(),
            options: options_json,
            created_by: Some(user_id_clone.clone()),
            created_at: db::now_str(),
        };
        db::create_poll(conn, &poll)?;
        Ok(poll)
    })
    .await?;

    let payload = poll_with_votes(poll.clone(), Vec::new());
    broadcast_to_channel(&state, &channel_id, "poll:new", payload.clone()).await;
    json_ok(payload)
}

pub async fn vote(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, poll_id)): Path<(String, String)>,
    Json(body): Json<VoteRequest>,
) -> Result<Json<Value>, AppError> {
    let team_id_clone = team_id.clone();
    let poll_id_clone = poll_id.clone();
    let user_id_clone = user_id.clone();
    let (poll, votes) = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id_clone, &team_id_clone)?;
        let poll = db::get_poll_by_id(conn, &poll_id_clone)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        if poll.team_id != team_id_clone {
            return Err(rusqlite::Error::InvalidParameterName(
                "poll does not belong to this team".into(),
            ));
        }
        // Reject votes outside the option range.
        let opts: Vec<String> = serde_json::from_str(&poll.options)
            .map_err(|e| rusqlite::Error::InvalidParameterName(e.to_string()))?;
        if body.option_index < 0 || body.option_index as usize >= opts.len() {
            return Err(rusqlite::Error::InvalidParameterName(
                "option_index out of range".into(),
            ));
        }
        db::upsert_poll_vote(conn, &poll_id_clone, &user_id_clone, body.option_index)?;
        let votes = db::get_votes_for_poll(conn, &poll_id_clone)?;
        Ok((poll, votes))
    })
    .await
    .map_err(|e| match e {
        AppError::NotFound(_) => AppError::NotFound("poll not found".into()),
        other => other,
    })?;

    let payload = poll_with_votes(poll, votes);
    broadcast_to_channel(&state, &payload["channel_id"].as_str().unwrap_or(""), "poll:update", payload.clone()).await;
    json_ok(payload)
}

pub async fn unvote(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, poll_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let team_id_clone = team_id.clone();
    let poll_id_clone = poll_id.clone();
    let user_id_clone = user_id.clone();
    let (poll, votes) = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id_clone, &team_id_clone)?;
        let poll = db::get_poll_by_id(conn, &poll_id_clone)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        if poll.team_id != team_id_clone {
            return Err(rusqlite::Error::InvalidParameterName(
                "poll does not belong to this team".into(),
            ));
        }
        db::clear_poll_vote(conn, &poll_id_clone, &user_id_clone)?;
        let votes = db::get_votes_for_poll(conn, &poll_id_clone)?;
        Ok((poll, votes))
    })
    .await
    .map_err(|e| match e {
        AppError::NotFound(_) => AppError::NotFound("poll not found".into()),
        other => other,
    })?;

    let payload = poll_with_votes(poll, votes);
    broadcast_to_channel(&state, &payload["channel_id"].as_str().unwrap_or(""), "poll:update", payload.clone()).await;
    json_ok(payload)
}

fn poll_with_votes(poll: db::Poll, votes: Vec<db::PollVote>) -> Value {
    let options: Vec<String> =
        serde_json::from_str(&poll.options).unwrap_or_default();
    let mut tallies = vec![0u32; options.len()];
    let mut voters_by_option: Vec<Vec<String>> = vec![Vec::new(); options.len()];
    for v in &votes {
        let idx = v.option_index as usize;
        if idx < tallies.len() {
            tallies[idx] += 1;
            voters_by_option[idx].push(v.user_id.clone());
        }
    }
    serde_json::json!({
        "id": poll.id,
        "team_id": poll.team_id,
        "channel_id": poll.channel_id,
        "question": poll.question,
        "options": options,
        "tallies": tallies,
        "voters": voters_by_option,
        "created_by": poll.created_by,
        "created_at": poll.created_at,
    })
}

async fn broadcast_to_channel(state: &AppState, channel_id: &str, kind: &str, payload: Value) {
    if channel_id.is_empty() {
        return;
    }
    if let Ok(evt) = Event::new(kind, payload) {
        if let Ok(bytes) = evt.to_bytes() {
            state.hub.broadcast_to_channel(channel_id, bytes, None).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_poll_request_requires_both_fields() {
        let r: CreatePollRequest = serde_json::from_str(r#"{"question":"q?","options":["a","b"]}"#).unwrap();
        assert_eq!(r.question, "q?");
        assert_eq!(r.options, vec!["a".to_string(), "b".to_string()]);
        assert!(serde_json::from_str::<CreatePollRequest>(r#"{"question":"q"}"#).is_err());
        assert!(serde_json::from_str::<CreatePollRequest>(r#"{"options":[]}"#).is_err());
    }

    #[test]
    fn vote_request_parses_signed_index() {
        let r: VoteRequest = serde_json::from_str(r#"{"option_index":0}"#).unwrap();
        assert_eq!(r.option_index, 0);
        let r: VoteRequest = serde_json::from_str(r#"{"option_index":-1}"#).unwrap();
        assert_eq!(r.option_index, -1);
    }

    use crate::auth::UserId;
    use crate::config::Config;
    use crate::db::Database;
    use crate::presence::PresenceManager;
    use crate::ws::Hub;
    use crate::auth::AuthService;
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
            .route("/teams/{team_id}/channels/{channel_id}/polls", get(list_for_channel).post(create))
            .route("/teams/{team_id}/polls/{poll_id}/vote", post(vote).delete(axum_delete(unvote)))
            .layer(axum::Extension(UserId(user_id.to_string())))
            .with_state(state)
    }

    #[tokio::test]
    async fn list_polls_4xx_for_non_member() {
        let (state, _tmp) = make_state();
        let app = router(state, "ghost");
        let resp = app
            .oneshot(Request::get("/teams/t1/channels/ch1/polls").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn vote_on_missing_poll_4xx() {
        let (state, _tmp) = make_state();
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::post("/teams/t1/polls/missing/vote")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"option_index":0}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    fn seed_team_member_poll(state: &AppState) {
        let now = db::now_str();
        state.db.with_conn(|conn| {
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
            db::create_team(conn, &db::Team {
                id: "t1".into(),
                name: "T".into(),
                created_by: "alice".into(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                created_at: now.clone(),
                updated_at: now.clone(),
                ..Default::default()
            })?;
            db::create_member(conn, &db::Member {
                id: "m1".into(),
                team_id: "t1".into(),
                user_id: "alice".into(),
                nickname: String::new(),
                invited_by: String::new(),
                joined_at: now.clone(),
                updated_at: now.clone(),
            })?;
            db::create_poll(conn, &db::Poll {
                id: "p1".into(),
                team_id: "t1".into(),
                channel_id: "ch1".into(),
                created_by: Some("alice".into()),
                question: "best lang?".into(),
                options: serde_json::json!(["rust","go","python"]).to_string(),
                created_at: now,
            })
        }).unwrap();
    }

    #[tokio::test]
    async fn vote_happy_path() {
        let (state, _tmp) = make_state();
        seed_team_member_poll(&state);
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::post("/teams/t1/polls/p1/vote")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"option_index":0}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn vote_rejects_out_of_range_option() {
        let (state, _tmp) = make_state();
        seed_team_member_poll(&state);
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::post("/teams/t1/polls/p1/vote")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"option_index":99}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn vote_rejects_negative_option_index() {
        let (state, _tmp) = make_state();
        seed_team_member_poll(&state);
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::post("/teams/t1/polls/p1/vote")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"option_index":-1}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().as_u16() >= 400);
    }

    #[tokio::test]
    async fn unvote_happy_path() {
        let (state, _tmp) = make_state();
        seed_team_member_poll(&state);
        let app = router(state, "alice");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/teams/t1/polls/p1/vote")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }
}
