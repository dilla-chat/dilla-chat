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
    http::{header, HeaderValue, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
    Extension, Router,
};
use rust_embed::Embed;
use tower_http::set_header::SetResponseHeaderLayer;

/// Frontend security context — injected by the router based on the loaded
/// `Config` so the CSP can switch between "wss: only" (production) and
/// "ws: allowed" (DILLA_INSECURE=true / dev pattern).
///
/// Cited by F1 / DR-XSS-1 / EMB-INTEG-1 / VULN-001 / VULN-014.
#[derive(Clone, Copy, Debug, Default)]
pub struct WebappSecurity {
    /// When true (DILLA_INSECURE=true / dev), allow plain `ws:` and `http:`
    /// in `connect-src`. Otherwise restrict to `wss:` only — cites VULN-001
    /// (mandatory TLS) and VULN-014 (no ws:// federation peers).
    pub insecure: bool,
}

/// Embedded client dist/ directory.
/// At compile time the `dist/` folder (relative to the crate root) is baked
/// into the binary. If the folder does not exist the build still succeeds —
/// the embedded FS will simply be empty.
#[derive(Embed)]
#[folder = "dist/"]
#[allow(dead_code)]
struct EmbeddedFiles;

/// Create a fallback router that serves the embedded webapp.
///
/// Mount this as a fallback on the top-level router so that any path not
/// matched by API routes is handled here.
///
/// ```ignore
/// let app = api_router.fallback_service(webapp::webapp_fallback(security));
/// ```
///
/// `security.insecure` controls whether `connect-src` allows plain `ws:` /
/// `http:` (dev pattern) or restricts to `wss:` / `https:` only
/// (production). See F1 / VULN-001 / VULN-014.
#[allow(dead_code)]
pub fn webapp_fallback(security: WebappSecurity) -> Router {
    // F1 — Content-Security-Policy header.
    //
    // Closes DR-XSS-1 and EMB-INTEG-1 from the architecture review (§8.4
    // bullet 2). The policy is deliberately strict:
    //
    //   default-src 'self'         — only same-origin sub-resources
    //   script-src 'self'          — no inline scripts, no eval, no CDNs
    //   style-src 'self' 'unsafe-inline'
    //                              — 'unsafe-inline' is required because
    //                                React 19 + the OTel auto-instrumentation
    //                                inject inline <style> tags, and the
    //                                code-block highlight theme + theme
    //                                tokens use inline style="..." attrs
    //                                set from React. Audited 2026-05-21:
    //                                no inline <script> remain in
    //                                client/index.html or main.tsx.
    //   img-src 'self' data: blob: https:
    //                              — avatars + giphy + emoji + canvas-
    //                                generated thumbnails
    //   connect-src 'self' wss:    — XHR/WS to the API. ws: only when
    //                                DILLA_INSECURE=true (dev pattern);
    //                                otherwise wss: only — VULN-001/-014.
    //   worker-src 'self' blob:    — voice worklet + future crypto worker
    //                                (F3). `blob:` is required by Vite's
    //                                worker bundling pattern.
    //   font-src 'self' data:      — bundled fonts + base64 icons
    //   object-src 'none'          — defence-in-depth against legacy
    //                                <object>/<embed> XSS gadgets
    //   base-uri 'self'            — prevents <base> tag injection
    //                                relocating relative URLs offsite
    //   form-action 'self'         — no third-party form submission
    //   frame-ancestors 'none'     — replaces X-Frame-Options DENY
    //   upgrade-insecure-requests  — silently rewrites http:// sub-
    //                                resource references to https://
    //   require-trusted-types-for 'script'
    //   trusted-types default      — F7: tightens the JS string-to-DOM
    //                                APIs surface so an XSS payload
    //                                can't reach innerHTML / setHTMLUnsafe
    //                                / Worker / Function without being
    //                                routed through the 'default' policy
    //                                registered in main.tsx.
    //
    // When `security.insecure` is true (dev pattern with DILLA_INSECURE=true)
    // we relax connect-src to include `ws:` and `http:` so the dev front-end
    // can talk to a plain-HTTP loopback server. We do NOT relax script-src
    // or unsafe-eval — those are tied to supply-chain risk, not transport.
    let connect_src = if security.insecure {
        "'self' ws: wss: http: https:"
    } else {
        "'self' wss: https:"
    };

    let csp = format!(
        "default-src 'self'; \
         script-src 'self'; \
         style-src 'self' 'unsafe-inline'; \
         img-src 'self' data: blob: https:; \
         connect-src {connect_src}; \
         worker-src 'self' blob:; \
         font-src 'self' data:; \
         object-src 'none'; \
         base-uri 'self'; \
         form-action 'self'; \
         frame-ancestors 'none'; \
         upgrade-insecure-requests; \
         require-trusted-types-for 'script'; \
         trusted-types default"
    );

    // SAFETY: the CSP value we constructed is composed entirely of static
    // ASCII; HeaderValue::from_str only fails on non-visible-ASCII bytes.
    let csp_header = HeaderValue::from_str(&csp).expect("CSP must be valid ASCII");

    // COOP/COEP are required for SharedArrayBuffer + cross-origin isolation,
    // which the voice isolation pipeline (AudioWorklet + dedicated Worker)
    // depends on. They are scoped to the webapp routes only — federation
    // and other API endpoints must NOT have COEP=require-corp, or
    // cross-server traffic and third-party resources will break.
    Router::new()
        .fallback(get(serve_webapp))
        .layer(Extension(security))
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::header::HeaderName::from_static("content-security-policy"),
            csp_header,
        ))
        // Frontend defence-in-depth — these complement the CSP and apply
        // to every webapp response.
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::header::HeaderName::from_static("x-content-type-options"),
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::header::HeaderName::from_static("referrer-policy"),
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::header::HeaderName::from_static("cross-origin-opener-policy"),
            HeaderValue::from_static("same-origin"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::header::HeaderName::from_static("cross-origin-embedder-policy"),
            HeaderValue::from_static("require-corp"),
        ))
}

/// Main handler — decides between static file, SPA fallback, or 404.
#[allow(dead_code)]
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
        let app = webapp_fallback(WebappSecurity::default());

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
    async fn webapp_routes_have_cross_origin_isolation_headers() {
        let app = webapp_fallback(WebappSecurity::default());

        let req = Request::builder()
            .uri("/some/spa/route")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();

        assert_eq!(
            resp.headers()
                .get("cross-origin-opener-policy")
                .and_then(|v| v.to_str().ok()),
            Some("same-origin"),
            "missing/incorrect COOP header",
        );
        assert_eq!(
            resp.headers()
                .get("cross-origin-embedder-policy")
                .and_then(|v| v.to_str().ok()),
            Some("require-corp"),
            "missing/incorrect COEP header",
        );
    }

    // F1 / DR-XSS-1: production builds emit a strict CSP without ws:/http:.
    #[tokio::test]
    async fn webapp_routes_have_strict_csp_in_secure_mode() {
        let app = webapp_fallback(WebappSecurity { insecure: false });

        let req = Request::builder()
            .uri("/some/spa/route")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();

        let csp = resp
            .headers()
            .get("content-security-policy")
            .and_then(|v| v.to_str().ok())
            .expect("missing CSP header");
        assert!(csp.contains("default-src 'self'"), "csp: {csp}");
        assert!(csp.contains("script-src 'self'"), "csp: {csp}");
        assert!(csp.contains("object-src 'none'"), "csp: {csp}");
        assert!(csp.contains("frame-ancestors 'none'"), "csp: {csp}");
        assert!(csp.contains("require-trusted-types-for 'script'"), "csp: {csp}");
        assert!(csp.contains("wss:"), "csp must allow wss: {csp}");
        assert!(!csp.contains(" ws: "), "secure-mode CSP must NOT allow ws: — {csp}");
        assert!(!csp.contains(" http: "), "secure-mode CSP must NOT allow http: — {csp}");
    }

    // F1 — dev pattern (DILLA_INSECURE=true) loosens connect-src so the
    // SPA can reach a plain-HTTP loopback dev server. VULN-001 / VULN-014.
    #[tokio::test]
    async fn webapp_routes_allow_ws_in_insecure_mode() {
        let app = webapp_fallback(WebappSecurity { insecure: true });

        let req = Request::builder()
            .uri("/some/spa/route")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();

        let csp = resp
            .headers()
            .get("content-security-policy")
            .and_then(|v| v.to_str().ok())
            .expect("missing CSP header");
        assert!(csp.contains("ws:"), "insecure-mode CSP must allow ws: — {csp}");
        assert!(csp.contains("http:"), "insecure-mode CSP must allow http: — {csp}");
    }

    #[tokio::test]
    async fn test_unknown_path_serves_index_or_not_found() {
        let app = webapp_fallback(WebappSecurity::default());

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
