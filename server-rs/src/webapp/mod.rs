// Webapp embedding module.
// Serves the built React client from embedded files.
// Placeholder until client build is integrated.

use axum::{
    body::Body,
    http::{header, Request, Response, StatusCode},
    routing::get,
    Router,
};

/// Create a fallback router that serves embedded webapp files.
/// For now, returns 404 for non-API routes since the client hasn't been embedded yet.
pub fn webapp_fallback() -> Router {
    Router::new().fallback(get(|| async {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"error":"not found"}"#))
            .unwrap()
    }))
}
