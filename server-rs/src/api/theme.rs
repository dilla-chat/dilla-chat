use axum::{
    extract::State,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
};

use super::AppState;

/// Maximum custom theme file size (1 MB).
const MAX_THEME_SIZE: u64 = 1_048_576;

/// Read and validate a theme file at startup. Returns `None` if the path is
/// empty, the file is missing, or it exceeds the size limit.
///
/// The content is read once and cached in `AppState.custom_theme_css` so the
/// handler never touches the filesystem at request time (avoids CodeQL
/// "uncontrolled data in path" warnings and is faster).
pub fn load_theme_file(path: &str) -> Option<String> {
    if path.is_empty() {
        return None;
    }

    let canonical = match std::fs::canonicalize(path) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(path = path, error = %e, "custom theme file not found");
            return None;
        }
    };

    let meta = match std::fs::metadata(&canonical) {
        Ok(m) => m,
        Err(_) => return None,
    };

    if meta.len() > MAX_THEME_SIZE {
        tracing::warn!(path = path, size = meta.len(), "custom theme file too large (>1MB)");
        return None;
    }

    match std::fs::read_to_string(&canonical) {
        Ok(css) => {
            tracing::info!(path = path, bytes = css.len(), "loaded custom theme CSS");
            Some(css)
        }
        Err(e) => {
            tracing::warn!(path = path, error = %e, "custom theme file unreadable");
            None
        }
    }
}

/// Serve the cached custom theme CSS.
/// Returns 404 if no custom theme was loaded at startup.
pub async fn get_custom_theme(
    State(state): State<AppState>,
) -> Response {
    match &state.custom_theme_css {
        Some(css) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/css; charset=utf-8"),
             (header::CACHE_CONTROL, "public, max-age=300")],
            css.clone(),
        ).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::AuthService;
    use crate::config::Config;
    use crate::db::Database;
    use crate::presence::PresenceManager;
    use crate::ws::Hub;
    use axum::body::Body;
    use axum::http::Request;
    use axum::routing::get;
    use axum::Router;
    use std::io::Write;
    use std::sync::Arc;
    use tower::ServiceExt;

    fn make_state(theme_file: &str) -> (AppState, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.run_migrations().unwrap();
        let auth = Arc::new(AuthService::new(db.clone(), ""));
        let hub = Arc::new(Hub::new(db.clone()));
        let presence = Arc::new(PresenceManager::new());
        let config = Arc::new(Config {
            port: 8080,
            data_dir: "/tmp/test".into(),
            db_passphrase: String::new(),
            tls_cert: String::new(),
            tls_key: String::new(),
            peers: vec![],
            team_name: String::new(),
            federation_port: 8081,
            node_name: String::new(),
            join_secret: String::new(),
            fed_bind_addr: "0.0.0.0".into(),
            fed_advert_addr: String::new(),
            fed_advert_port: 0,
            max_upload_size: 25 * 1024 * 1024,
            upload_dir: "/tmp/test/uploads".into(),
            log_level: "info".into(),
            log_format: "text".into(),
            rate_limit: 100.0,
            rate_burst: 200,
            domain: "localhost".into(),
            cf_turn_key_id: String::new(),
            cf_turn_api_token: String::new(),
            turn_mode: String::new(),
            turn_shared_secret: String::new(),
            turn_urls: String::new(),
            turn_ttl: 86400,
            allowed_origins: vec![],
            trusted_proxies: vec![],
            insecure: false,
            theme_file: theme_file.into(),
            telemetry_adapter: "none".into(),
            sentry_dsn: String::new(),
            environment: "test".into(),
            otel_enabled: false,
            otel_protocol: "http".into(),
            otel_endpoint: "localhost:4317".into(),
            otel_http_endpoint: String::new(),
            otel_insecure: false,
            otel_service_name: "test".into(),
            otel_api_key: String::new(),
            otel_api_header: String::new(),
        });
        let custom_theme_css = load_theme_file(theme_file);
        let state = AppState {
            db,
            auth,
            hub,
            presence,
            config,
            mesh: None,
            custom_theme_css,
        };
        (state, tmp)
    }

    fn app(theme_file: &str) -> (Router, tempfile::TempDir) {
        let (state, tmp) = make_state(theme_file);
        let router = Router::new()
            .route("/theme/custom.css", get(get_custom_theme))
            .with_state(state);
        (router, tmp)
    }

    #[tokio::test]
    async fn returns_404_when_no_theme_configured() {
        let (router, _tmp) = app("");
        let response = router
            .oneshot(Request::get("/theme/custom.css").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn returns_404_when_file_does_not_exist() {
        let (router, _tmp) = app("/nonexistent/path/custom.css");
        let response = router
            .oneshot(Request::get("/theme/custom.css").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn serves_css_when_file_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let css_path = tmp.path().join("custom.css");
        let css_content = ":root { --color-brand: #ff0000; }";
        {
            let mut f = std::fs::File::create(&css_path).unwrap();
            f.write_all(css_content.as_bytes()).unwrap();
        }

        let (router, _state_tmp) = app(css_path.to_str().unwrap());
        let response = router
            .oneshot(Request::get("/theme/custom.css").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        assert_eq!(content_type, "text/css; charset=utf-8");

        let body_bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body_bytes, css_content.as_bytes());
    }

    #[test]
    fn load_theme_file_returns_none_for_empty_path() {
        assert!(load_theme_file("").is_none());
    }

    #[test]
    fn load_theme_file_returns_none_for_missing_file() {
        assert!(load_theme_file("/nonexistent/theme.css").is_none());
    }

    #[test]
    fn load_theme_file_reads_valid_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("test.css");
        std::fs::write(&path, ":root { --x: 1; }").unwrap();
        let result = load_theme_file(path.to_str().unwrap());
        assert_eq!(result, Some(":root { --x: 1; }".to_string()));
    }
}
