use std::collections::HashMap;
use std::sync::Arc;

use futures::stream::{SplitSink, SplitStream};
use futures::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::RwLock;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use super::FederationEvent;

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
    stop_tx: tokio::sync::watch::Sender<bool>,
    stop_rx: tokio::sync::watch::Receiver<bool>,
}

#[allow(dead_code)]
impl Transport {
    pub fn new() -> Self {
        let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
        Transport {
            conns: Arc::new(RwLock::new(HashMap::new())),
            peers: Arc::new(RwLock::new(Vec::new())),
            on_event: Arc::new(RwLock::new(None)),
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

        let url = if address.contains("://") {
            address.to_string()
        } else {
            format!("ws://{}/federation", address)
        };

        let (ws_stream, _) = connect_async(&url)
            .await
            .map_err(|e| format!("failed to connect to peer {}: {}", address, e))?;

        let (sink, stream) = ws_stream.split();
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
    /// Accepts the connection, registers it in the connection map, and spawns a
    /// read-pump task.
    pub async fn handle_incoming(
        &self,
        peer_addr: &str,
        ws_stream: WebSocketStream<MaybeTlsStream<TcpStream>>,
    ) {
        let (sink, stream) = ws_stream.split();
        let sink = Arc::new(tokio::sync::Mutex::new(sink));

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

        tracing::info!(peer = %peer_addr, "accepted incoming federation peer");

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
