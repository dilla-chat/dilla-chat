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
    /// Number of candidate gifs to return. Defaults to 1 (translate
    /// endpoint, one best match) for back-compat. >=2 switches to the
    /// search endpoint and trims the response.
    #[serde(default)]
    pub limit: Option<u8>,
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
    let limit = params.limit.unwrap_or(1).clamp(1, 12);

    // limit==1 keeps the original behavior (translate, one best match).
    // limit>=2 switches to /search and returns a list — the client uses
    // this to render a small picker so the user can choose before
    // sending. Same response envelope: { results: [{ url, preview }] }.
    let endpoint = if limit == 1 {
        format!(
            "https://api.giphy.com/v1/gifs/translate?api_key={}&s={}",
            percent_encode(key),
            percent_encode(q),
        )
    } else {
        format!(
            "https://api.giphy.com/v1/gifs/search?api_key={}&q={}&limit={}&rating=pg-13",
            percent_encode(key),
            percent_encode(q),
            limit,
        )
    };
    let client: reqwest::Client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .build()
        .map_err(|e| AppError::Internal(format!("http client: {}", e)))?;
    let res: reqwest::Response = client
        .get(&endpoint)
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

    // /translate returns data as a single object; /search returns it as
    // an array. Normalize both into a Vec<&Value> so the picker logic
    // is one shape downstream.
    let data: &Value = &body["data"];
    let items: Vec<&Value> = match data {
        Value::Null => Vec::new(),
        Value::Array(arr) => arr.iter().collect(),
        v => vec![v],
    };
    if items.is_empty() {
        return Err(AppError::NotFound("no gif matches that query".into()));
    }
    let extract = |item: &Value| -> Option<(String, String)> {
        let images = &item["images"];
        let url = images["downsized"]["url"]
            .as_str()
            .or_else(|| images["original"]["url"].as_str())
            .or_else(|| images["fixed_height"]["url"].as_str())
            .or_else(|| item["url"].as_str())?;
        // Preview is a smaller animated thumbnail used for the picker
        // tiles; fall back to the same url when not available.
        let preview = images["fixed_height_small"]["url"]
            .as_str()
            .or_else(|| images["preview_gif"]["url"].as_str())
            .unwrap_or(url);
        Some((url.to_string(), preview.to_string()))
    };
    let results: Vec<Value> = items
        .into_iter()
        .filter_map(extract)
        .map(|(url, preview)| serde_json::json!({ "url": url, "preview": preview }))
        .collect();
    if results.is_empty() {
        return Err(AppError::BadGateway("no usable gif urls in giphy response".into()));
    }

    json_ok(serde_json::json!({
        // Back-compat: first match's url surfaces at the top level so
        // existing single-result callers still work without changes.
        "url": results[0]["url"],
        "query": q,
        "results": results,
    }))
}
