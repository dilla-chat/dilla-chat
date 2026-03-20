//! Callback listener for WebAuthn passkey ceremonies.
//!
//! Spawns a minimal localhost HTTP server that listens for the POST /callback
//! and /error from the auth page hosted on the Dilla server.

use rand::Rng;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::sync::mpsc;
use std::time::Duration;
use tiny_http::{Header, Response, Server};

const TIMEOUT_SECS: u64 = 120;
const CALLBACK_PORT: u16 = 65530;
const PORT_RETRIES: u16 = 5;

fn start_server() -> Result<(Server, u16), String> {
    for offset in 0..PORT_RETRIES {
        let port = CALLBACK_PORT + offset;
        match Server::http(format!("localhost:{port}")) {
            Ok(server) => return Ok((server, port)),
            Err(e) => {
                if offset == PORT_RETRIES - 1 {
                    return Err(format!("Failed to start callback server on ports {CALLBACK_PORT}-{port}: {e}"));
                }
            }
        }
    }
    Err("Failed to start callback server: all ports busy".into())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RegisterResult {
    pub nonce: String,
    #[serde(rename = "credentialId")]
    pub credential_id: String,
    #[serde(rename = "credentialName")]
    pub credential_name: String,
    #[serde(rename = "prfOutput")]
    pub prf_output: String,
    #[serde(rename = "prfSupported")]
    pub prf_supported: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LoginResult {
    pub nonce: String,
    #[serde(rename = "prfOutput")]
    pub prf_output: String,
}

fn generate_nonce() -> String {
    let bytes: [u8; 32] = rand::rng().gen();
    base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, bytes)
}

fn cors_headers() -> Vec<Header> {
    vec![
        Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap(),
        Header::from_bytes("Access-Control-Allow-Methods", "POST, OPTIONS").unwrap(),
        Header::from_bytes("Access-Control-Allow-Headers", "Content-Type").unwrap(),
    ]
}

/// A callback listener session. Call `url()` to get the auth URL to open,
/// then `wait_register()` or `wait_login()` to block for the result.
pub struct CallbackSession {
    pub nonce: String,
    pub callback_port: u16,
    rx: mpsc::Receiver<String>,
    _handle: std::thread::JoinHandle<()>,
}

impl CallbackSession {
    fn wait_raw(&self) -> Result<String, String> {
        let body = self.rx
            .recv_timeout(Duration::from_secs(TIMEOUT_SECS))
            .map_err(|_| "Passkey authentication timed out. Please try again.".to_string())?;

        if body.starts_with("ERROR:") {
            return Err(format!("Authentication failed: {}", &body[6..]));
        }

        Ok(body)
    }
}

/// Build the full auth URL on the remote server.
pub fn build_register_url(
    server_base_url: &str,
    callback_port: u16,
    nonce: &str,
    username: &str,
    prf_salt_b64: &str,
) -> String {
    format!(
        "{}/auth?mode=register&nonce={}&callback_port={}&username={}&prf_salt={}&credential_ids=[]",
        server_base_url.trim_end_matches('/'),
        nonce,
        callback_port,
        urlencoding(username),
        b64_to_urlsafe(prf_salt_b64),
    )
}

/// Build the full auth URL for login on the remote server.
pub fn build_login_url(
    server_base_url: &str,
    callback_port: u16,
    nonce: &str,
    prf_salt_b64: &str,
    credential_ids: &[String],
) -> String {
    let cred_ids_json = serde_json::to_string(credential_ids).unwrap_or_else(|_| "[]".into());
    format!(
        "{}/auth?mode=login&nonce={}&callback_port={}&prf_salt={}&credential_ids={}",
        server_base_url.trim_end_matches('/'),
        nonce,
        callback_port,
        b64_to_urlsafe(prf_salt_b64),
        urlencoding(&cred_ids_json),
    )
}

/// Start a callback-only listener. Returns the session with the port and nonce.
pub fn start_callback_listener() -> Result<CallbackSession, String> {
    let (server, port) = start_server()?;
    let nonce = generate_nonce();

    let (tx, rx) = mpsc::channel::<String>();
    let handle = spawn_callback_loop(server, tx);

    Ok(CallbackSession {
        nonce,
        callback_port: port,
        rx,
        _handle: handle,
    })
}

/// Parse a register result from the callback.
pub fn parse_register_result(session: &CallbackSession) -> Result<RegisterResult, String> {
    let body = session.wait_raw()?;
    let result: RegisterResult =
        serde_json::from_str(&body).map_err(|e| format!("Invalid response: {e}"))?;
    if result.nonce != session.nonce {
        return Err("Security error: nonce mismatch".into());
    }
    Ok(result)
}

/// Parse a login result from the callback.
pub fn parse_login_result(session: &CallbackSession) -> Result<LoginResult, String> {
    let body = session.wait_raw()?;
    let result: LoginResult =
        serde_json::from_str(&body).map_err(|e| format!("Invalid response: {e}"))?;
    if result.nonce != session.nonce {
        return Err("Security error: nonce mismatch".into());
    }
    Ok(result)
}

fn spawn_callback_loop(server: Server, tx: mpsc::Sender<String>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(TIMEOUT_SECS);

        loop {
            if std::time::Instant::now() > deadline {
                break;
            }

            let mut request = match server.recv_timeout(Duration::from_secs(2)) {
                Ok(Some(req)) => req,
                Ok(None) | Err(_) => continue,
            };

            let path = request.url().split('?').next().unwrap_or("").to_string();

            match (request.method(), path.as_str()) {
                (&tiny_http::Method::Options, "/callback" | "/error") => {
                    let mut resp = Response::from_string("");
                    for h in cors_headers() {
                        resp = resp.with_header(h);
                    }
                    let _ = request.respond(resp);
                }
                (&tiny_http::Method::Post, "/callback") => {
                    let mut body = String::new();
                    let _ = request.as_reader().read_to_string(&mut body);
                    let mut resp = Response::from_string("{\"ok\":true}")
                        .with_header(Header::from_bytes("Content-Type", "application/json").unwrap());
                    for h in cors_headers() {
                        resp = resp.with_header(h);
                    }
                    let _ = request.respond(resp);
                    let _ = tx.send(body);
                    break;
                }
                (&tiny_http::Method::Post, "/error") => {
                    let mut body = String::new();
                    let _ = request.as_reader().read_to_string(&mut body);
                    let mut resp = Response::from_string("{\"ok\":true}")
                        .with_header(Header::from_bytes("Content-Type", "application/json").unwrap());
                    for h in cors_headers() {
                        resp = resp.with_header(h);
                    }
                    let _ = request.respond(resp);
                    let _ = tx.send(format!("ERROR:{body}"));
                    break;
                }
                _ => {
                    let _ = request.respond(Response::from_string("Not Found").with_status_code(404));
                }
            }
        }
    })
}

fn urlencoding(s: &str) -> String {
    let mut result = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                result.push(b as char);
            }
            _ => {
                result.push_str(&format!("%{:02X}", b));
            }
        }
    }
    result
}

fn b64_to_urlsafe(s: &str) -> String {
    s.replace('+', "-").replace('/', "_").trim_end_matches('=').to_string()
}
