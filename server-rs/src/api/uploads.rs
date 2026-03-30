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
    let content_type_encrypted = field
        .content_type()
        .unwrap_or("application/octet-stream")
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

    let attachment = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let member = db::get_member_by_user_and_team(conn, &uid, &tid)?;
            if member.is_none() {
                return Err(rusqlite::Error::InvalidParameterName(
                    "not a member of this team".into(),
                ));
            }

            db::get_attachment(conn, &aid)?
                .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    let attachment = match attachment {
        Ok(a) => a,
        Err(rusqlite::Error::InvalidParameterName(msg)) => {
            return Err(AppError::Forbidden(msg));
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            return Err(AppError::NotFound("attachment not found".into()));
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

    let content_type = if attachment.content_type_encrypted.is_empty() {
        "application/octet-stream".to_string()
    } else {
        String::from_utf8_lossy(&attachment.content_type_encrypted).to_string()
    };

    let response = Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, attachment.size)
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
