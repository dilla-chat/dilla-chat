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
use std::path::PathBuf;

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

#[derive(Deserialize)]
pub struct EmbedRequest {
    /// A Giphy CDN URL the client picked from /gif's results. The
    /// server fetches the bytes, stores them as a team attachment, and
    /// returns the attachment so the client can post a normal image
    /// message — no more hot-linking media.giphy.com from every
    /// recipient's browser.
    pub url: String,
}

/// True if `url` is on a Giphy CDN host we accept. Anchors the host
/// to "giphy.com" with a leading dot so subdomains like
/// `media.giphy.com` / `media1.giphy.com` pass while a crafted host
/// like `media.giphy.com.attacker.tld` doesn't. SSRF guard.
fn is_giphy_url(url: &str) -> bool {
    if !url.starts_with("https://") { return false; }
    let after = &url[8..];
    let host_end = after.find('/').unwrap_or(after.len());
    let host = &after[..host_end];
    let host_no_port = host.split(':').next().unwrap_or(host);
    host_no_port == "giphy.com"
        || host_no_port.ends_with(".giphy.com")
        || host_no_port == "i.giphy.com"
}

/// Materialize a picked Giphy URL into a team attachment. The client
/// then sends a normal image message referencing the attachment id, so
/// the asset is fetched from our own /attachments path (federated +
/// privacy-respecting) instead of media.giphy.com directly.
pub async fn embed(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
    Json(body): Json<EmbedRequest>,
) -> Result<Json<Value>, AppError> {
    if !is_giphy_url(&body.url) {
        return Err(AppError::BadRequest(
            "embed only accepts giphy.com URLs".into(),
        ));
    }
    // Membership check up front so SSRF-style attempts get a 403 before
    // we touch the network.
    let uid = user_id.clone();
    let tid = team_id.clone();
    spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &uid, &tid)?;
        Ok::<_, rusqlite::Error>(())
    })
    .await?;

    // Fetch the gif. Re-use the same client + timeout as the search
    // proxy. Bounded by the team's max upload size so a malicious
    // redirect can't fill the disk.
    let client: reqwest::Client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| AppError::Internal(format!("http client: {}", e)))?;
    let res: reqwest::Response = client
        .get(&body.url)
        .send()
        .await
        .map_err(|e| AppError::BadGateway(format!("giphy fetch failed: {}", e)))?;
    if !res.status().is_success() {
        return Err(AppError::BadGateway(format!(
            "giphy returned {}",
            res.status()
        )));
    }
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/gif")
        .to_string();
    let bytes = res
        .bytes()
        .await
        .map_err(|e| AppError::BadGateway(format!("giphy body: {}", e)))?;
    let max_size = state.config.max_upload_size;
    if bytes.len() as i64 > max_size {
        return Err(AppError::BadRequest(format!(
            "gif too large (max {} bytes)",
            max_size
        )));
    }

    if team_id.contains("..") || team_id.contains('/') || team_id.contains('\\') {
        return Err(AppError::BadRequest("invalid team id".into()));
    }

    // Write to disk + create attachment row — same shape upload() uses.
    let attachment_id = db::new_id();
    let upload_dir = PathBuf::from(&state.config.upload_dir).join(&team_id);
    tokio::fs::create_dir_all(&upload_dir)
        .await
        .map_err(|e| AppError::Internal(format!("create upload dir: {}", e)))?;
    let file_path = upload_dir.join(&attachment_id);
    tokio::fs::write(&file_path, &bytes)
        .await
        .map_err(|e| AppError::Internal(format!("write file: {}", e)))?;
    let storage_path = file_path
        .to_str()
        .ok_or_else(|| AppError::Internal("upload path contains invalid UTF-8".into()))?
        .to_string();
    // Pull a stable filename out of the URL path for the download
    // affordance — Giphy URLs like .../<id>/giphy.gif end in giphy.gif.
    let filename = body
        .url
        .rsplit('/')
        .next()
        .unwrap_or("giphy.gif")
        .split('?')
        .next()
        .unwrap_or("giphy.gif")
        .to_string();

    let aid = attachment_id.clone();
    let size = bytes.len() as i64;
    let attachment = spawn_db(state.db.clone(), move |conn| {
        let att = db::Attachment {
            id: aid,
            message_id: String::new(), // linked later when the message is sent
            filename_encrypted: filename.into_bytes(),
            content_type_encrypted: content_type.into_bytes(),
            size,
            storage_path,
            created_at: db::now_str(),
        };
        db::create_attachment(conn, &att)?;
        Ok(att)
    })
    .await?;

    json_ok(serde_json::json!(attachment))
}
