// Server-side proxy for the `/giphy` slash command. The Giphy API key
// is a per-team setting (Team Settings → Integrations writes
// `team:<tid>:giphy_api_key` into the settings table); the client calls
// `GET /api/v1/teams/{tid}/gif?q=<query>` and we look the key up by
// team. Returns
//   { "url": "https://media.giphy.com/.../giphy.gif", "query": "..." }
// or 503 if the team admin hasn't pasted a key yet.

use axum::extract::{Path, Query, State};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::Value;

use crate::api::helpers::{json_ok, require_team_member, spawn_db};
use crate::api::AppState;
use crate::auth::UserId;
use crate::db;
use crate::error::AppError;

/// Minimal percent-encoder for query-string values. We only need it for
/// the user-supplied query and the operator's API key, both of which are
/// short. RFC 3986 unreserved set: A-Z a-z 0-9 - _ . ~
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

#[derive(Deserialize)]
pub struct GifQuery {
    pub q: String,
}

pub async fn search(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
    Query(params): Query<GifQuery>,
) -> Result<Json<Value>, AppError> {
    let q = params.q.trim().to_string();
    if q.is_empty() {
        return Err(AppError::BadRequest("query is required".into()));
    }
    let team_id_clone = team_id.clone();
    let user_id_clone = user_id.clone();
    let key_opt = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id_clone, &team_id_clone)?;
        let key = format!("team:{}:giphy_api_key", team_id_clone);
        Ok::<_, rusqlite::Error>(db::get_setting(conn, &key)?)
    })
    .await?;
    let key = key_opt.unwrap_or_default();
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err(AppError::ServiceUnavailable(
            "gif provider not configured for this team".into(),
        ));
    }
    let q = q.as_str();
    let key = key.as_str();

    let url = format!(
        "https://api.giphy.com/v1/gifs/translate?api_key={}&s={}",
        percent_encode(key),
        percent_encode(q),
    );
    let client: reqwest::Client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .build()
        .map_err(|e| AppError::Internal(format!("http client: {}", e)))?;
    let res: reqwest::Response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| AppError::BadGateway(format!("giphy request failed: {}", e)))?;
    if !res.status().is_success() {
        return Err(AppError::BadGateway(format!(
            "giphy returned {}",
            res.status()
        )));
    }
    let body: Value = res
        .json::<Value>()
        .await
        .map_err(|e| AppError::BadGateway(format!("giphy decode: {}", e)))?;

    // translate returns either a single object (`data: {...}`) or an empty
    // array (`data: []`) when there's no match — guard both shapes.
    let data: &Value = &body["data"];
    if data.is_null() || data.as_array().map(|a| a.is_empty()).unwrap_or(false) {
        return Err(AppError::NotFound("no gif matches that query".into()));
    }
    let images = &data["images"];
    let pick = images["downsized"]["url"]
        .as_str()
        .or_else(|| images["original"]["url"].as_str())
        .or_else(|| images["fixed_height"]["url"].as_str())
        .or_else(|| data["url"].as_str())
        .ok_or_else(|| AppError::BadGateway("no usable gif url in giphy response".into()))?;

    json_ok(serde_json::json!({
        "url": pick,
        "query": q,
    }))
}
