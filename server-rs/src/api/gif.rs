// Server-side proxy for the `/giphy` slash command. We don't want a
// Giphy API key shipped in the browser bundle, so the client just calls
// `GET /api/v1/gif?q=<query>` and the server hits Giphy's translate
// endpoint with `DILLA_GIPHY_API_KEY`.
//
// Returns `{ "url": "https://media.giphy.com/.../giphy.gif", "query": "..." }`
// for the inline image renderer, or 503 with an `error` field if the
// operator hasn't configured a key.

use axum::extract::{Query, State};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::Value;

use crate::api::helpers::json_ok;
use crate::api::AppState;
use crate::auth::UserId;
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
    Extension(UserId(_user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Query(params): Query<GifQuery>,
) -> Result<Json<Value>, AppError> {
    let q = params.q.trim();
    if q.is_empty() {
        return Err(AppError::BadRequest("query is required".into()));
    }
    let key = state.config.giphy_api_key.trim();
    if key.is_empty() {
        return Err(AppError::ServiceUnavailable(
            "gif provider not configured (set DILLA_GIPHY_API_KEY)".into(),
        ));
    }

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
