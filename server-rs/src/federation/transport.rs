use std::collections::HashMap;
use std::sync::Arc;

use futures::stream::{SplitSink, SplitStream};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::net::TcpStream;
use tokio::sync::RwLock;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use super::FederationEvent;

/// Timeout for the peer to send a join token after connecting.
const AUTH_TIMEOUT_SECS: u64 = 5;

/// JSON payload expected as the first message from a connecting peer.
#[derive(Debug, Deserialize)]
struct AuthMessage {
    join_token: String,
}

/// Validate an authentication message against the expected join secret.
fn validate_auth_message(message_text: &str, expected_secret: &str) -> bool {
    match serde_json::from_str::<AuthMessage>(message_text) {
        Ok(auth) => auth.join_token == expected_secret,
        Err(_) => false,
    }
}

/// Build the outbound authentication message JSON.
fn build_auth_message(join_secret: &str) -> String {
    serde_json::json!({ "join_token": join_secret }).to_string()
}

/// Check if federation authentication is required (non-empty secret).
fn requires_auth(join_secret: &str) -> bool {
    !join_secret.is_empty()
}

type WsSink = SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>;

/// Represents a connection to a remote federation peer.
struct PeerConnection {
    sink: Arc<tokio::sync::Mutex<WsSink>>,
    connected: bool,
}

/// Callback invoked when a federation event arrives from a peer.
pub type OnEventFn =
    Arc<dyn Fn(String, FederationEvent) + Send + Sync>;

/// WebSocket transport for peer-to-peer federation communication.
///
/// Maintains a map of peer addresses to their WebSocket connections, handles
/// reconnection, and provides send/broadcast primitives.
#[allow(dead_code)]
pub struct Transport {
    conns: Arc<RwLock<HashMap<String, PeerConnection>>>,
    peers: Arc<RwLock<Vec<String>>>,
    on_event: Arc<RwLock<Option<OnEventFn>>>,
    join_secret: String,
    stop_tx: tokio::sync::watch::Sender<bool>,
    stop_rx: tokio::sync::watch::Receiver<bool>,
}

/// Build the WebSocket URL for a federation peer.
///
/// If the address already contains `://`, it is used as-is (with a warning for
/// unencrypted `ws://`). Otherwise, defaults to `wss://{address}/federation`.
fn build_peer_url(address: &str) -> String {
    if address.contains("://") {
        if address.starts_with("ws://") {
            tracing::warn!(
                "Federation peer {} uses unencrypted ws:// — consider using wss://",
                address
            );
        }
        address.to_string()
    } else {
        format!("wss://{}/federation", address)
    }
}

#[allow(dead_code)]
impl Transport {
    pub fn new() -> Self {
        Self::with_join_secret(String::new())
    }

    pub fn with_join_secret(join_secret: String) -> Self {
        let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
        Transport {
            conns: Arc::new(RwLock::new(HashMap::new())),
            peers: Arc::new(RwLock::new(Vec::new())),
            on_event: Arc::new(RwLock::new(None)),
            join_secret,
            stop_tx,
            stop_rx,
        }
    }

    /// Set the callback invoked when a federation event is received from a peer.
    pub async fn set_on_event(&self, handler: OnEventFn) {
        *self.on_event.write().await = Some(handler);
    }

    /// Connect to a remote peer at the given WebSocket address.
    ///
    /// The address should be a full WebSocket URL, e.g. `ws://192.168.1.10:8081/federation`.
    /// Spawns a read-pump task for the connection.
    pub async fn connect_to_peer(&self, address: &str) -> Result<(), String> {
        // Track this peer address.
        {
            let mut peers = self.peers.write().await;
            if !peers.contains(&address.to_string()) {
                peers.push(address.to_string());
            }
        }

        let url = build_peer_url(address);

        let (ws_stream, _) = connect_async(&url)
            .await
            .map_err(|e| format!("failed to connect to peer {}: {}", address, e))?;

        let (mut sink, stream) = ws_stream.split();

        // Send join token as the first message (outbound authentication).
        if requires_auth(&self.join_secret) {
            let auth_msg = build_auth_message(&self.join_secret);
            sink.send(Message::Text(auth_msg.into()))
                .await
                .map_err(|e| format!("failed to send auth to peer {}: {}", address, e))?;
        }

        let sink = Arc::new(tokio::sync::Mutex::new(sink));

        {
            let mut conns = self.conns.write().await;
            conns.insert(
                address.to_string(),
                PeerConnection {
                    sink: sink.clone(),
                    connected: true,
                },
            );
        }

        tracing::info!(peer = %address, "connected to federation peer");

        // Spawn the read pump.
        self.spawn_read_pump(address.to_string(), stream);

        Ok(())
    }

    /// Handle an incoming WebSocket connection from a remote peer.
    ///
    /// Accepts the connection, authenticates the peer by expecting a join token
    /// as the first message within 5 seconds, registers it in the connection map,
    /// and spawns a read-pump task.
    pub async fn handle_incoming(
        &self,
        peer_addr: &str,
        ws_stream: WebSocketStream<MaybeTlsStream<TcpStream>>,
    ) {
        let (sink, mut stream) = ws_stream.split();
        let sink = Arc::new(tokio::sync::Mutex::new(sink));

        // Authenticate: expect a join_token as the first message within AUTH_TIMEOUT_SECS.
        if requires_auth(&self.join_secret) {
            let auth_result = tokio::time::timeout(
                tokio::time::Duration::from_secs(AUTH_TIMEOUT_SECS),
                stream.next(),
            )
            .await;

            let authenticated = match auth_result {
                Ok(Some(Ok(Message::Text(text)))) => validate_auth_message(&text, &self.join_secret),
                _ => false,
            };

            if !authenticated {
                tracing::warn!(peer = %peer_addr, "federation peer failed authentication — disconnecting");
                let mut s = sink.lock().await;
                let _ = s.send(Message::Close(None)).await;
                return;
            }
        }

        {
            let mut conns = self.conns.write().await;
            conns.insert(
                peer_addr.to_string(),
                PeerConnection {
                    sink: sink.clone(),
                    connected: true,
                },
            );
        }

        // Track this peer address.
        {
            let mut peers = self.peers.write().await;
            if !peers.contains(&peer_addr.to_string()) {
                peers.push(peer_addr.to_string());
            }
        }

        tracing::info!(peer = %peer_addr, "accepted incoming federation peer (authenticated)");

        self.spawn_read_pump(peer_addr.to_string(), stream);
    }

    /// Send a federation event to a specific peer.
    pub async fn send(&self, peer_addr: &str, event: &FederationEvent) -> Result<(), String> {
        let conns = self.conns.read().await;
        let conn = conns
            .get(peer_addr)
            .ok_or_else(|| format!("peer {} not connected", peer_addr))?;

        if !conn.connected {
            return Err(format!("peer {} is disconnected", peer_addr));
        }

        let data = serde_json::to_string(event)
            .map_err(|e| format!("failed to serialize event: {}", e))?;

        let mut sink = conn.sink.lock().await;
        sink.send(Message::Text(data.into()))
            .await
            .map_err(|e| format!("failed to send to peer {}: {}", peer_addr, e))?;

        Ok(())
    }

    /// Broadcast a federation event to all connected peers.
    pub async fn broadcast(&self, event: &FederationEvent) {
        let data = match serde_json::to_string(event) {
            Ok(d) => d,
            Err(e) => {
                tracing::error!("failed to serialize federation event: {}", e);
                return;
            }
        };

        let conns = self.conns.read().await;
        for (addr, conn) in conns.iter() {
            if !conn.connected {
                continue;
            }
            let mut sink = conn.sink.lock().await;
            if let Err(e) = sink.send(Message::Text(data.clone().into())).await {
                tracing::warn!(peer = %addr, "failed to broadcast to peer: {}", e);
            }
        }
    }

    /// Start the reconnect loop. Attempts to reconnect disconnected peers every 10 seconds.
    pub fn start_reconnect_loop(self: &Arc<Self>) {
        let transport = Arc::clone(self);
        let mut stop_rx = transport.stop_rx.clone();

        tokio::spawn(async move {
            let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(10));
            loop {
                tokio::select! {
                    _ = interval.tick() => {}
                    _ = stop_rx.changed() => {
                        break;
                    }
                }

                let peers = transport.peers.read().await.clone();
                for addr in &peers {
                    let needs_reconnect = {
                        let conns = transport.conns.read().await;
                        match conns.get(addr) {
                            Some(conn) => !conn.connected,
                            None => true,
                        }
                    };

                    if needs_reconnect {
                        tracing::debug!(peer = %addr, "attempting reconnection");
                        if let Err(e) = transport.connect_to_peer(addr).await {
                            tracing::debug!(peer = %addr, "reconnection failed: {}", e);
                        }
                    }
                }
            }
        });
    }

    /// Start the ping loop. Sends WebSocket pings to all connected peers every 30 seconds.
    pub fn start_ping_loop(self: &Arc<Self>) {
        let transport = Arc::clone(self);
        let mut stop_rx = transport.stop_rx.clone();

        tokio::spawn(async move {
            let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(30));
            loop {
                tokio::select! {
                    _ = interval.tick() => {}
                    _ = stop_rx.changed() => {
                        break;
                    }
                }

                let conns = transport.conns.read().await;
                for (addr, conn) in conns.iter() {
                    if !conn.connected {
                        continue;
                    }
                    let mut sink = conn.sink.lock().await;
                    if let Err(e) = sink.send(Message::Ping(vec![].into())).await {
                        tracing::warn!(peer = %addr, "ping failed: {}", e);
                    }
                }
            }
        });
    }

    /// Stop the transport. Closes all peer connections and signals background loops to exit.
    pub async fn stop(&self) {
        let _ = self.stop_tx.send(true);

        let mut conns = self.conns.write().await;
        for (addr, conn) in conns.iter_mut() {
            let mut sink = conn.sink.lock().await;
            let _ = sink.send(Message::Close(None)).await;
            conn.connected = false;
            tracing::debug!(peer = %addr, "closed federation connection");
        }
        conns.clear();
    }

    /// Returns the list of known peer addresses and their connection status.
    pub async fn peer_statuses(&self) -> Vec<(String, bool)> {
        let conns = self.conns.read().await;
        let peers = self.peers.read().await;

        peers
            .iter()
            .map(|addr| {
                let connected = conns
                    .get(addr)
                    .map(|c| c.connected)
                    .unwrap_or(false);
                (addr.clone(), connected)
            })
            .collect()
    }

    /// Spawn a read-pump task that reads messages from the peer's WebSocket stream.
    fn spawn_read_pump(
        &self,
        peer_addr: String,
        mut stream: SplitStream<WebSocketStream<MaybeTlsStream<TcpStream>>>,
    ) {
        let conns = Arc::clone(&self.conns);
        let on_event = Arc::clone(&self.on_event);

        tokio::spawn(async move {
            loop {
                match stream.next().await {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<FederationEvent>(&text) {
                            Ok(event) => {
                                let handler = on_event.read().await;
                                if let Some(ref cb) = *handler {
                                    cb(peer_addr.clone(), event);
                                }
                            }
                            Err(e) => {
                                tracing::warn!(
                                    peer = %peer_addr,
                                    "failed to parse federation event: {}",
                                    e
                                );
                            }
                        }
                    }
                    Some(Ok(Message::Ping(data))) => {
                        // Pong is handled automatically by tungstenite.
                        tracing::trace!(peer = %peer_addr, "received ping ({} bytes)", data.len());
                    }
                    Some(Ok(Message::Pong(_))) => {
                        tracing::trace!(peer = %peer_addr, "received pong");
                    }
                    Some(Ok(Message::Close(_))) => {
                        tracing::info!(peer = %peer_addr, "peer closed connection");
                        break;
                    }
                    Some(Ok(_)) => {
                        // Binary or other frames — ignore.
                    }
                    Some(Err(e)) => {
                        tracing::warn!(peer = %peer_addr, "WebSocket read error: {}", e);
                        break;
                    }
                    None => {
                        tracing::info!(peer = %peer_addr, "peer stream ended");
                        break;
                    }
                }
            }

            // Mark the connection as disconnected.
            let mut conns = conns.write().await;
            if let Some(conn) = conns.get_mut(&peer_addr) {
                conn.connected = false;
            }
            tracing::info!(peer = %peer_addr, "federation peer disconnected");
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_peer_url_bare_address() {
        assert_eq!(
            build_peer_url("example.com:8081"),
            "wss://example.com:8081/federation"
        );
    }

    #[test]
    fn test_build_peer_url_ws_passthrough() {
        assert_eq!(
            build_peer_url("ws://example.com:8081/federation"),
            "ws://example.com:8081/federation"
        );
    }

    #[test]
    fn test_build_peer_url_wss_passthrough() {
        assert_eq!(
            build_peer_url("wss://secure.example.com/federation"),
            "wss://secure.example.com/federation"
        );
    }

    #[test]
    fn test_build_peer_url_bare_hostname_only() {
        assert_eq!(
            build_peer_url("node2.local"),
            "wss://node2.local/federation"
        );
    }

    #[test]
    fn test_validate_auth_message_valid() {
        let msg = r#"{"join_token":"my-secret"}"#;
        assert!(validate_auth_message(msg, "my-secret"));
    }

    #[test]
    fn test_validate_auth_message_wrong_token() {
        let msg = r#"{"join_token":"wrong"}"#;
        assert!(!validate_auth_message(msg, "my-secret"));
    }

    #[test]
    fn test_validate_auth_message_invalid_json() {
        assert!(!validate_auth_message("not json", "secret"));
    }

    #[test]
    fn test_validate_auth_message_missing_field() {
        let msg = r#"{"other":"value"}"#;
        assert!(!validate_auth_message(msg, "secret"));
    }

    #[test]
    fn test_validate_auth_message_empty_token() {
        let msg = r#"{"join_token":""}"#;
        assert!(!validate_auth_message(msg, "secret"));
        assert!(validate_auth_message(msg, ""));
    }

    #[test]
    fn test_build_auth_message() {
        let msg = build_auth_message("my-secret");
        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        assert_eq!(parsed["join_token"], "my-secret");
    }

    #[test]
    fn test_build_auth_message_roundtrip() {
        let secret = "test-join-secret-123";
        let msg = build_auth_message(secret);
        assert!(validate_auth_message(&msg, secret));
    }

    #[test]
    fn test_requires_auth_with_secret() {
        assert!(requires_auth("my-secret"));
    }

    #[test]
    fn test_requires_auth_empty() {
        assert!(!requires_auth(""));
    }

    #[test]
    fn test_auth_timeout_constant() {
        assert_eq!(AUTH_TIMEOUT_SECS, 5);
    }

    // ── Integration tests for federation transport auth ──────────────

    use tokio::net::TcpListener;
    use tokio_tungstenite::MaybeTlsStream;

    /// Helper: start a TCP listener on a random port and return (listener, port).
    async fn start_tcp_listener() -> (TcpListener, u16) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        (listener, port)
    }

    #[tokio::test]
    async fn test_handle_incoming_auth_success() {
        let (listener, port) = start_tcp_listener().await;
        let transport = Transport::with_join_secret("test-secret".to_string());

        // Spawn a client that connects and sends the correct auth token.
        let client_handle = tokio::spawn(async move {
            let url = format!("ws://127.0.0.1:{}", port);
            let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
            ws.send(Message::Text(r#"{"join_token":"test-secret"}"#.into()))
                .await
                .unwrap();
            // Keep connection alive briefly so the server can register it.
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        });

        // Accept the TCP connection and upgrade to WebSocket with MaybeTlsStream.
        let (tcp_stream, _) = listener.accept().await.unwrap();
        let ws_stream = tokio_tungstenite::accept_async(MaybeTlsStream::Plain(tcp_stream))
            .await
            .unwrap();

        transport.handle_incoming("test-peer", ws_stream).await;

        // Verify peer was registered.
        let conns = transport.conns.read().await;
        assert!(conns.contains_key("test-peer"), "peer should be registered after successful auth");
        assert!(conns["test-peer"].connected);

        client_handle.await.unwrap();
    }

    #[tokio::test]
    async fn test_handle_incoming_auth_failure() {
        let (listener, port) = start_tcp_listener().await;
        let transport = Transport::with_join_secret("test-secret".to_string());

        // Spawn a client that sends the wrong token.
        let client_handle = tokio::spawn(async move {
            let url = format!("ws://127.0.0.1:{}", port);
            let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
            ws.send(Message::Text(r#"{"join_token":"wrong"}"#.into()))
                .await
                .unwrap();
            // Read until close or error.
            while let Some(msg) = ws.next().await {
                match msg {
                    Ok(Message::Close(_)) => break,
                    Err(_) => break,
                    _ => {}
                }
            }
        });

        let (tcp_stream, _) = listener.accept().await.unwrap();
        let ws_stream = tokio_tungstenite::accept_async(MaybeTlsStream::Plain(tcp_stream))
            .await
            .unwrap();

        transport.handle_incoming("bad-peer", ws_stream).await;

        // Verify peer was NOT registered.
        let conns = transport.conns.read().await;
        assert!(!conns.contains_key("bad-peer"), "peer should not be registered after failed auth");

        client_handle.await.unwrap();
    }

    #[tokio::test]
    async fn test_connect_to_peer_sends_auth_token() {
        let (listener, port) = start_tcp_listener().await;
        let transport = Transport::with_join_secret("outbound-secret".to_string());

        // Spawn a server that accepts and reads the first message.
        let server_handle = tokio::spawn(async move {
            let (tcp_stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp_stream).await.unwrap();
            let msg = ws.next().await.unwrap().unwrap();
            match msg {
                Message::Text(text) => {
                    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
                    assert_eq!(parsed["join_token"], "outbound-secret");
                }
                other => panic!("expected Text message with auth token, got {:?}", other),
            }
        });

        let url = format!("ws://127.0.0.1:{}", port);
        transport.connect_to_peer(&url).await.unwrap();

        // Verify peer was registered in conns.
        let conns = transport.conns.read().await;
        assert!(conns.contains_key(&url));

        server_handle.await.unwrap();
    }

    #[tokio::test]
    async fn test_handle_incoming_no_auth_when_empty_secret() {
        let (listener, port) = start_tcp_listener().await;
        let transport = Transport::with_join_secret(String::new());

        // Spawn a client that connects but sends NO auth message.
        let client_handle = tokio::spawn(async move {
            let url = format!("ws://127.0.0.1:{}", port);
            let (_ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
            // Keep alive briefly.
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        });

        let (tcp_stream, _) = listener.accept().await.unwrap();
        let ws_stream = tokio_tungstenite::accept_async(MaybeTlsStream::Plain(tcp_stream))
            .await
            .unwrap();

        transport.handle_incoming("no-auth-peer", ws_stream).await;

        // With empty secret, auth is skipped so peer should be registered.
        let conns = transport.conns.read().await;
        assert!(
            conns.contains_key("no-auth-peer"),
            "peer should be registered when auth is skipped (empty secret)"
        );
        assert!(conns["no-auth-peer"].connected);

        client_handle.await.unwrap();
    }
}
