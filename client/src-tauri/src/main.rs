#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth_server;

use std::sync::Mutex;
use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::{Runtime, Url};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

// ─── Voice: RNNoise Noise Suppression ─────────────────────────────────────────

static DENOISE_STATE: Mutex<Option<Box<nnnoiseless::DenoiseState>>> = Mutex::new(None);

#[tauri::command]
fn denoise_frame(samples: Vec<f32>) -> Vec<f32> {
    // RNNoise operates on fixed-size frames of 480 samples (10 ms at 48 kHz).
    // If the input length is not 480, no denoising is performed and the input
    // is returned unchanged to avoid dropping or padding audio data.
    if samples.len() != 480 {
        return samples;
    }
    let mut state_guard = DENOISE_STATE.lock().unwrap();
    let state = state_guard.get_or_insert_with(nnnoiseless::DenoiseState::new);
    let mut output = vec![0.0f32; 480];
    state.process_frame(&mut output, &samples);
    output
}

// F8 — navigation allow-list. The Tauri WebView must only load the
// embedded SPA origin (or, in dev, the Vite dev server). Any navigation
// to a remote origin would let a successful XSS / link-click bounce the
// user to an attacker-controlled origin while keeping the Tauri command
// surface (which trusts the WebView origin) reachable.
//
// We allow:
//   - `tauri://` and `*.tauri.localhost`       (release WebView protocol)
//   - `http://localhost:{5173,8888,8080}`      (Vite + dev API in DEBUG only)
//   - `http://127.0.0.1:6553{0..4}`            (auth_server loopback range)
//
// Everything else is blocked. External http(s) links should open via
// the system browser (`opener::open`), not as in-window navigations.
fn is_allowed_navigation(url: &Url) -> bool {
    let scheme = url.scheme();
    let host = url.host_str().unwrap_or("");
    let port = url.port();
    if scheme == "tauri" {
        return true;
    }
    if (scheme == "http" || scheme == "https") && host == "tauri.localhost" {
        return true;
    }
    // Dev pattern: Vite serves on :5173 (devUrl) or :8888 (the project's
    // configured dev port). The Vite-dev allow-list is gated on debug
    // assertions so it doesn't widen the release attack surface.
    if cfg!(debug_assertions)
        && scheme == "http"
        && (host == "localhost" || host == "127.0.0.1")
        && matches!(port, Some(5173) | Some(8888) | Some(8080))
    {
        return true;
    }
    // Auth-server loopback (auth_server.rs binds 127.0.0.1:65530..65534
    // for the WebAuthn callback). Allowed in both debug and release
    // because the desktop login flow needs it.
    if scheme == "http"
        && (host == "127.0.0.1" || host == "localhost")
        && matches!(port, Some(65530..=65534))
    {
        return true;
    }
    false
}

// F8 — wraps the navigation guard in a tiny Tauri plugin so we can
// hook the runtime's `on_navigation` callback. Returning `false`
// vetoes the navigation; we log the refusal to stderr (which ends up
// in the system console / `tauri dev` output) so an attacker-driven
// navigation attempt leaves an audit trail.
fn navigation_guard_plugin<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::<R>::new("dilla-nav-guard")
        .on_navigation(|_webview, url| {
            if is_allowed_navigation(url) {
                true
            } else {
                eprintln!(
                    "[security] refused in-window navigation to {} (F8 nav guard)",
                    url
                );
                false
            }
        })
        .build()
}

fn main() {
    tauri::Builder::default()
        .plugin(navigation_guard_plugin())
        .invoke_handler(tauri::generate_handler![greet, denoise_frame,])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).expect("test URL must parse")
    }

    #[test]
    fn tauri_scheme_is_allowed() {
        assert!(is_allowed_navigation(&url("tauri://localhost/")));
        assert!(is_allowed_navigation(&url("tauri://localhost/chat")));
    }

    #[test]
    fn tauri_localhost_https_is_allowed() {
        assert!(is_allowed_navigation(&url("https://tauri.localhost/")));
        assert!(is_allowed_navigation(&url("http://tauri.localhost/chat")));
    }

    #[test]
    fn remote_http_is_blocked() {
        assert!(!is_allowed_navigation(&url("http://example.com/")));
        assert!(!is_allowed_navigation(&url("https://evil.example/")));
    }

    #[test]
    fn unknown_loopback_port_is_blocked() {
        // Outside the auth_server window
        assert!(!is_allowed_navigation(&url("http://127.0.0.1:9001/")));
    }

    #[test]
    fn auth_server_loopback_range_is_allowed() {
        assert!(is_allowed_navigation(&url("http://127.0.0.1:65530/")));
        assert!(is_allowed_navigation(&url("http://127.0.0.1:65534/")));
    }

    #[test]
    fn file_scheme_is_blocked() {
        assert!(!is_allowed_navigation(&url("file:///etc/passwd")));
    }
}
