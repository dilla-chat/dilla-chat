use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

#[derive(Debug)]
pub enum AppError {
    NotFound(String),
    Unauthorized(String),
    Forbidden(String),
    BadRequest(String),
    Conflict(String),
    Internal(String),
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppError::NotFound(msg) => write!(f, "not found: {}", msg),
            AppError::Unauthorized(msg) => write!(f, "unauthorized: {}", msg),
            AppError::Forbidden(msg) => write!(f, "forbidden: {}", msg),
            AppError::BadRequest(msg) => write!(f, "bad request: {}", msg),
            AppError::Conflict(msg) => write!(f, "conflict: {}", msg),
            AppError::Internal(msg) => write!(f, "internal error: {}", msg),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            AppError::NotFound(msg) => (StatusCode::NOT_FOUND, msg),
            AppError::Unauthorized(msg) => (StatusCode::UNAUTHORIZED, msg),
            AppError::Forbidden(msg) => (StatusCode::FORBIDDEN, msg),
            AppError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg),
            AppError::Conflict(msg) => (StatusCode::CONFLICT, msg),
            AppError::Internal(msg) => {
                tracing::error!("internal error: {}", msg);
                (StatusCode::INTERNAL_SERVER_ERROR, msg)
            }
        };

        (status, Json(json!({ "error": message }))).into_response()
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Internal(format!("database error: {}", e))
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::BadRequest(format!("invalid JSON: {}", e))
    }
}

impl From<jsonwebtoken::errors::Error> for AppError {
    fn from(e: jsonwebtoken::errors::Error) -> Self {
        AppError::Unauthorized(format!("invalid token: {}", e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Display tests ---

    #[test]
    fn display_not_found() {
        let e = AppError::NotFound("user 123".into());
        assert_eq!(format!("{}", e), "not found: user 123");
    }

    #[test]
    fn display_unauthorized() {
        let e = AppError::Unauthorized("bad token".into());
        assert_eq!(format!("{}", e), "unauthorized: bad token");
    }

    #[test]
    fn display_forbidden() {
        let e = AppError::Forbidden("no access".into());
        assert_eq!(format!("{}", e), "forbidden: no access");
    }

    #[test]
    fn display_bad_request() {
        let e = AppError::BadRequest("missing field".into());
        assert_eq!(format!("{}", e), "bad request: missing field");
    }

    #[test]
    fn display_conflict() {
        let e = AppError::Conflict("already exists".into());
        assert_eq!(format!("{}", e), "conflict: already exists");
    }

    #[test]
    fn display_internal() {
        let e = AppError::Internal("something broke".into());
        assert_eq!(format!("{}", e), "internal error: something broke");
    }

    // --- HTTP status code tests ---

    #[test]
    fn not_found_returns_404() {
        let resp = AppError::NotFound("x".into()).into_response();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn unauthorized_returns_401() {
        let resp = AppError::Unauthorized("x".into()).into_response();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn forbidden_returns_403() {
        let resp = AppError::Forbidden("x".into()).into_response();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn bad_request_returns_400() {
        let resp = AppError::BadRequest("x".into()).into_response();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn conflict_returns_409() {
        let resp = AppError::Conflict("x".into()).into_response();
        assert_eq!(resp.status(), StatusCode::CONFLICT);
    }

    #[test]
    fn internal_returns_500() {
        let resp = AppError::Internal("x".into()).into_response();
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    // --- From impls ---

    #[test]
    fn from_serde_error_is_bad_request() {
        let bad_json: Result<serde_json::Value, _> = serde_json::from_str("{invalid");
        let serde_err = bad_json.unwrap_err();
        let app_err: AppError = serde_err.into();
        let msg = format!("{}", app_err);
        assert!(msg.starts_with("bad request: invalid JSON:"));
    }

    // --- Debug ---

    #[test]
    fn debug_includes_variant_name() {
        let e = AppError::NotFound("test".into());
        let debug = format!("{:?}", e);
        assert!(debug.contains("NotFound"));
    }

    #[test]
    fn debug_includes_message() {
        let e = AppError::Internal("db crash".into());
        let debug = format!("{:?}", e);
        assert!(debug.contains("db crash"));
    }
}
