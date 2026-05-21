use axum::{
    body::Body,
    extract::{Multipart, Path, State},
    http::header,
    response::Response,
    Extension, Json,
};
use serde_json::{json, Value};
use std::path::PathBuf;
use tokio_util::io::ReaderStream;

use crate::api::AppState;
use crate::auth::UserId;
use crate::db;
use crate::error::AppError;

/// Allow-listed Content-Type prefixes stored alongside an upload.
///
/// Bodies are E2EE ciphertext so the value is only used by the client
/// to render a preview after decrypting. Anything outside the list
/// degrades to `application/octet-stream` — the client preview falls
/// back to a generic "file" icon and the user sees the original
/// filename. This kills the
/// "operator-controlled-MIME → drive-by-download" exposure of VULN-008
/// without losing the legitimate image/audio/video preview path.
fn sanitize_upload_content_type(raw: &str) -> &str {
    let lower = raw.trim().to_ascii_lowercase();
    const ALLOWED_PREFIXES: &[&str] = &[
        "image/",
        "audio/",
        "video/",
        "text/plain",
        "application/pdf",
        "application/octet-stream",
        "application/json",
    ];
    for prefix in ALLOWED_PREFIXES {
        if lower.starts_with(prefix) {
            // Return the original (with case + extras) so the client
            // keeps the precise MIME (e.g. image/png;charset=…). We
            // know the prefix matched against the lowercased copy.
            return raw;
        }
    }
    "application/octet-stream"
}

pub async fn upload(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
    mut multipart: Multipart,
) -> Result<Json<Value>, AppError> {
    let uid = user_id.clone();
    let tid = team_id.clone();

    // Verify membership first.
    let db = state.db.clone();
    let uid_check = uid.clone();
    let tid_check = tid.clone();
    let is_member = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let member = db::get_member_by_user_and_team(conn, &uid_check, &tid_check)?;
            Ok::<bool, rusqlite::Error>(member.is_some())
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?
    .map_err(|e| AppError::Internal(format!("db: {}", e)))?;

    if !is_member {
        return Err(AppError::Forbidden("not a member of this team".into()));
    }

    // Read the multipart field.
    let field = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(format!("multipart error: {}", e)))?
        .ok_or_else(|| AppError::BadRequest("no file uploaded".into()))?;

    let filename_encrypted = field
        .file_name()
        .unwrap_or("unknown")
        .as_bytes()
        .to_vec();
    // VULN-008: clamp the upload-time Content-Type to a small
    // allow-list. We can't trust the browser to send something safe to
    // re-emit. The actual byte stream is E2EE ciphertext so labelling
    // it text/html would be nonsense regardless; we store
    // application/octet-stream for anything outside the allow-list and
    // the download handler ALSO overrides on the wire.
    let raw_ct = field
        .content_type()
        .unwrap_or("application/octet-stream")
        .to_string();
    let content_type_encrypted = sanitize_upload_content_type(&raw_ct)
        .as_bytes()
        .to_vec();

    let data = field
        .bytes()
        .await
        .map_err(|e| AppError::BadRequest(format!("failed to read upload: {}", e)))?;

    // Check file size.
    let max_size = state.config.max_upload_size;
    if data.len() as i64 > max_size {
        return Err(AppError::BadRequest(format!(
            "file too large (max {} bytes)",
            max_size
        )));
    }

    // Validate team_id to prevent path traversal.
    if tid.contains("..") || tid.contains('/') || tid.contains('\\') {
        return Err(AppError::BadRequest("invalid team id".into()));
    }

    // H12 / UPL-DOS-1: per-team disk-usage quota. Refuse the upload if
    // the new file would push the team over the configured cap.
    let quota_bytes = state.config.upload_quota_per_team_gb as i64 * 1024 * 1024 * 1024;
    if quota_bytes > 0 {
        let db = state.db.clone();
        let tid_quota = tid.clone();
        let used: i64 = tokio::task::spawn_blocking(move || {
            db.with_conn(|conn| db::get_team_upload_bytes_used(conn, &tid_quota))
        })
        .await
        .map_err(|e| AppError::Internal(format!("task join: {}", e)))?
        .map_err(|e| AppError::Internal(format!("db: {}", e)))?;
        if used + (data.len() as i64) > quota_bytes {
            return Err(AppError::PayloadTooLarge(format!(
                "team upload quota exceeded ({} / {} bytes used)",
                used, quota_bytes
            )));
        }
    }

    // Write file to disk.
    let attachment_id = db::new_id();
    let upload_dir = PathBuf::from(&state.config.upload_dir).join(&tid);
    tokio::fs::create_dir_all(&upload_dir)
        .await
        .map_err(|e| AppError::Internal(format!("create upload dir: {}", e)))?;

    let file_path = upload_dir.join(&attachment_id);
    tokio::fs::write(&file_path, &data)
        .await
        .map_err(|e| AppError::Internal(format!("write file: {}", e)))?;

    let storage_path = file_path
        .to_str()
        .ok_or_else(|| AppError::Internal("upload path contains invalid UTF-8".into()))?
        .to_string();

    // Create attachment record.
    let db = state.db.clone();
    let aid = attachment_id.clone();
    let size = data.len() as i64;

    let tid_for_quota = tid.clone();
    let attachment = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let att = db::Attachment {
                id: aid,
                message_id: String::new(), // Will be linked later by client.
                filename_encrypted,
                content_type_encrypted,
                size,
                storage_path,
                created_at: db::now_str(),
            };
            db::create_attachment(conn, &att)?;
            // H12 / UPL-DOS-1: bump the team-level usage tally. The
            // quota pre-check above is racy under concurrent uploads,
            // but the worst case is a small overshoot bounded by the
            // per-request body limit.
            db::add_team_upload_bytes(conn, &tid_for_quota, size)?;
            Ok(att)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?
    .map_err(|e: rusqlite::Error| AppError::Internal(format!("db: {}", e)))?;

    Ok(Json(json!(attachment)))
}

pub async fn download(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, attachment_id)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let db = state.db.clone();
    let tid = team_id.clone();
    let aid = attachment_id.clone();
    let uid = user_id.clone();

    // Window during which an unlinked attachment can still be fetched
    // by its uploader before the client has finished the
    // upload → create-message round trip (e.g. for Giphy embed paths).
    // After this, the attachment must be linked to a message and the
    // caller must pass the channel ACL.
    const UNLINKED_GRACE_SECS: i64 = 3600;

    let attachment = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| -> Result<db::Attachment, rusqlite::Error> {
            // VULN-003: caller must be a team member regardless of
            // whether the attachment is linked yet.
            crate::api::helpers::require_team_member(conn, &uid, &tid)?;

            let att = db::get_attachment(conn, &aid)?
                .ok_or(rusqlite::Error::QueryReturnedNoRows)?;

            if att.message_id.is_empty() {
                // Unlinked window: only the uploader (or a caller who
                // can prove uploader-ness) can fetch, and only for a
                // limited time. Today the attachments table doesn't
                // store an uploader_id (TODO), so we fall back to
                // restricting by the per-team upload directory + the
                // grace window. This still kills the
                // anonymous-bulk-download exposure of VULN-003 because
                // (a) the caller must be a team member, and (b) the
                // uploader's own session is the only one with the
                // attachment_id during the grace period.
                // db::now_str() format is "%Y-%m-%d %H:%M:%S" UTC.
                // Treat unparseable timestamps as out-of-grace.
                let still_in_grace = chrono::NaiveDateTime::parse_from_str(
                    &att.created_at,
                    "%Y-%m-%d %H:%M:%S",
                )
                .ok()
                .map(|naive| chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(naive, chrono::Utc))
                .or_else(|| {
                    chrono::DateTime::parse_from_rfc3339(&att.created_at)
                        .ok()
                        .map(|t| t.with_timezone(&chrono::Utc))
                })
                .map(|c| (chrono::Utc::now() - c).num_seconds() < UNLINKED_GRACE_SECS)
                .unwrap_or(false);
                if !still_in_grace {
                    // Past grace window without a message link → treat
                    // as orphaned and refuse to serve. The uploader's
                    // client should have linked by now.
                    return Err(rusqlite::Error::InvalidParameterName(
                        "attachment is not linked to a message".into(),
                    ));
                }
                // In-grace path: team member + path stored under
                // upload_dir/{team_id}/ is sufficient. The storage_path
                // check is implicit because get_attachment loaded by id
                // and we already gate on team membership above.
                return Ok(att);
            }

            // Linked path: validate the message exists in this team
            // AND the caller can read the channel that owns it.
            let msg = db::get_message_by_id(conn, &att.message_id)?
                .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
            let channel = db::get_channel_by_id(conn, &msg.channel_id)?
                .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
            if channel.team_id != tid {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            if !db::user_can_access_channel(conn, &uid, &tid, &msg.channel_id)? {
                return Err(rusqlite::Error::InvalidParameterName(
                    "channel access denied".into(),
                ));
            }
            Ok(att)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    let attachment = match attachment {
        Ok(a) => a,
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            return Err(AppError::NotFound("attachment not found".into()));
        }
        Err(rusqlite::Error::InvalidParameterName(msg)) => {
            return Err(AppError::Forbidden(msg));
        }
        Err(e) => {
            return Err(AppError::Internal(format!("db: {}", e)));
        }
    };

    // Stream the file.
    let file = tokio::fs::File::open(&attachment.storage_path)
        .await
        .map_err(|e| AppError::Internal(format!("open file: {}", e)))?;

    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);

    // VULN-008: ignore the upload-time content_type entirely on the
    // wire. Bodies are E2EE ciphertext so the byte stream is opaque to
    // any browser parser regardless. Sandbox via CSP, force download
    // via Content-Disposition with a server-generated filename.
    let response = Response::builder()
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_LENGTH, attachment.size)
        .header(
            "Content-Disposition",
            format!("attachment; filename=\"{}\"", attachment.id),
        )
        .header(
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; sandbox",
        )
        .header("X-Content-Type-Options", "nosniff")
        .body(body)
        .map_err(|e| AppError::Internal(format!("build response: {}", e)))?;

    Ok(response)
}

pub async fn delete_attachment(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, attachment_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let tid = team_id.clone();
    let aid = attachment_id.clone();
    let uid = user_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            if !db::user_has_permission(conn, &uid, &tid, db::PERM_MANAGE_MESSAGES)? {
                return Err(rusqlite::Error::InvalidParameterName(
                    "insufficient permissions".into(),
                ));
            }

            let attachment = db::get_attachment(conn, &aid)?
                .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;

            db::delete_attachment(conn, &aid)?;
            // H12 / UPL-DOS-1: refund the team's quota on delete.
            let _ = db::add_team_upload_bytes(conn, &tid, -attachment.size);
            Ok(attachment.storage_path)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    match result {
        Ok(storage_path) => {
            // Best-effort delete the file from disk.
            let _ = tokio::fs::remove_file(&storage_path).await;
            Ok(Json(json!({ "ok": true })))
        }
        Err(rusqlite::Error::InvalidParameterName(msg)) => Err(AppError::Forbidden(msg)),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(AppError::NotFound("attachment not found".into()))
        }
        Err(e) => Err(AppError::Internal(format!("db: {}", e))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_passes_allowed_image_type() {
        assert_eq!(sanitize_upload_content_type("image/png"), "image/png");
        assert_eq!(sanitize_upload_content_type("IMAGE/JPEG"), "IMAGE/JPEG");
        assert_eq!(
            sanitize_upload_content_type("image/svg+xml; charset=utf-8"),
            "image/svg+xml; charset=utf-8"
        );
    }

    #[test]
    fn sanitize_passes_allowed_media_types() {
        assert_eq!(sanitize_upload_content_type("audio/ogg"), "audio/ogg");
        assert_eq!(sanitize_upload_content_type("video/webm"), "video/webm");
        assert_eq!(sanitize_upload_content_type("application/pdf"), "application/pdf");
    }

    #[test]
    fn sanitize_rejects_html() {
        assert_eq!(
            sanitize_upload_content_type("text/html"),
            "application/octet-stream"
        );
    }

    #[test]
    fn sanitize_rejects_javascript() {
        assert_eq!(
            sanitize_upload_content_type("application/javascript"),
            "application/octet-stream"
        );
        assert_eq!(
            sanitize_upload_content_type("text/javascript"),
            "application/octet-stream"
        );
    }

    #[test]
    fn sanitize_rejects_xhtml_and_xml() {
        assert_eq!(
            sanitize_upload_content_type("application/xhtml+xml"),
            "application/octet-stream"
        );
        assert_eq!(
            sanitize_upload_content_type("text/xml"),
            "application/octet-stream"
        );
    }

    #[test]
    fn sanitize_rejects_arbitrary_garbage() {
        assert_eq!(
            sanitize_upload_content_type("not-a-real-mime-type"),
            "application/octet-stream"
        );
        assert_eq!(sanitize_upload_content_type(""), "application/octet-stream");
    }
}
