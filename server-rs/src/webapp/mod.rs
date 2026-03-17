// Webapp embedding module.
// Serves the built React client from embedded files using rust-embed.
//
// Port of the Go webapp.go handler. Behaviour:
// - API / WS / federation / health / auth paths → 404 (handled elsewhere)
// - Known static file → serve with correct Content-Type
// - /assets/* → immutable cache headers (hashed filenames from Vite)
// - Everything else → SPA fallback to index.html (no-cache)

use axum::{
    body::Body,
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use rust_embed::Embed;

/// Embedded client dist/ directory.
/// At compile time the `dist/` folder (relative to the crate root) is baked
/// into the binary. If the folder does not exist the build still succeeds —
/// the embedded FS will simply be empty.
#[derive(Embed)]
#[folder = "dist/"]
struct EmbeddedFiles;

/// Create a fallback router that serves the embedded webapp.
///
/// Mount this as a fallback on the top-level router so that any path not
/// matched by API routes is handled here.
///
/// ```ignore
/// let app = api_router.fallback_service(webapp::webapp_fallback());
/// ```
pub fn webapp_fallback() -> Router {
    Router::new().fallback(get(serve_webapp))
}

/// Main handler — decides between static file, SPA fallback, or 404.
async fn serve_webapp(uri: Uri) -> Response {
    let path = uri.path();

    // Skip paths owned by other subsystems — they should never reach the
    // webapp handler, but if they do we return a clean 404.
    if path.starts_with("/api/")
        || path.starts_with("/ws")
        || path.starts_with("/federation/")
        || path == "/health"
        || path.starts_with("/auth")
    {
        return (
            StatusCode::NOT_FOUND,
            [(header::CONTENT_TYPE, "application/json")],
            r#"{"error":"not found"}"#,
        )
            .into_response();
    }

    // Strip leading slash for rust-embed lookup.
    let file_path = path.trim_start_matches('/');

    // Try to serve the file directly.
    if !file_path.is_empty() {
        if let Some(file) = EmbeddedFiles::get(file_path) {
            let content_type = mime_guess::from_path(file_path)
                .first_or_octet_stream()
                .to_string();

            let mut builder = Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, content_type);

            // Vite hashed assets can be cached forever.
            if path.starts_with("/assets/") {
                builder = builder.header(
                    header::CACHE_CONTROL,
                    "public, max-age=31536000, immutable",
                );
            }

            return builder
                .body(Body::from(file.data.to_vec()))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
        }
    }

    // SPA fallback — serve index.html for all unmatched routes.
    match EmbeddedFiles::get("index.html") {
        Some(index) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(
                header::CACHE_CONTROL,
                "no-cache, no-store, must-revalidate",
            )
            .body(Body::from(index.data.to_vec()))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        None => {
            // No embedded client — return a helpful message.
            (
                StatusCode::NOT_FOUND,
                [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
                "webapp not embedded — build the client first (npm run build) and place output in server-rs/dist/",
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use tower::ServiceExt;

    #[tokio::test]
    async fn test_api_paths_return_404() {
        let app = webapp_fallback();

        for path in &["/api/v1/health", "/ws", "/federation/peers", "/auth"] {
            let req = Request::builder()
                .uri(*path)
                .body(Body::empty())
                .unwrap();
            let resp = app.clone().oneshot(req).await.unwrap();
            assert_eq!(
                resp.status(),
                StatusCode::NOT_FOUND,
                "expected 404 for {}",
                path
            );
        }
    }

    #[tokio::test]
    async fn test_unknown_path_serves_index_or_not_found() {
        let app = webapp_fallback();

        let req = Request::builder()
            .uri("/some/spa/route")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();

        // Without an embedded dist/, we expect either 200 (index.html) or
        // 404 (no dist/). Both are correct depending on build state.
        assert!(
            resp.status() == StatusCode::OK || resp.status() == StatusCode::NOT_FOUND,
            "unexpected status: {}",
            resp.status()
        );
    }
}
