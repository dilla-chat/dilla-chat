use axum::extract::{Path, State};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::Value;

use crate::api::helpers::{json_ok, require_team_member, spawn_db};
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
