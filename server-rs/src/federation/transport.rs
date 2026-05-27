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
///
/// VULN-002 partial fix (Phase 1): replaces the previous non-constant-
/// time `==` comparison with `subtle::ConstantTimeEq`, eliminating the
/// classic timing oracle. Also rejects auth attempts when the
/// configured `expected_secret` is empty — the previous implementation
/// silently accepted every peer in that case because the caller gated
/// the whole authentication block on `!expected_secret.is_empty()`.
/// Callers that genuinely want anonymous federation must set
/// `DILLA_INSECURE=true` and skip authentication explicitly (see
/// `validate_auth_message_with_insecure`).
///
/// The full VULN-002 redesign — per-node Ed25519 signing keys, signed
/// federation events, removal of last-writer-wins state merge — is a
/// Phase 3 architectural change. See
/// `.security-hardening/03-architecture-review.md` section 7.
fn validate_auth_message(message_text: &str, expected_secret: &str) -> bool {
    validate_auth_message_with_insecure(message_text, expected_secret, false)
}

fn validate_auth_message_with_insecure(
    message_text: &str,
    expected_secret: &str,
    insecure: bool,
) -> bool {
    if expected_secret.is_empty() {
        // Empty configured secret + insecure=true → explicit "let
        // anyone in" mode for dev. Otherwise refuse.
        return insecure;
    }
    let auth = match serde_json::from_str::<AuthMessage>(message_text) {
        Ok(a) => a,
        Err(_) => return false,
    };
    use subtle::ConstantTimeEq;
    auth.join_token
        .as_bytes()
        .ct_eq(expected_secret.as_bytes())
        .into()
}

/// Build the outbound authentication message JSON.
fn build_auth_message(join_secret: &str) -> String {
    serde_json::json!({ "join_token": join_secret }).to_string()
}

/// H-9: cheap shape-sniff for the v3 handshake wire format. We can't
/// route on the full envelope until we know which dispatch to run;
/// looking for the `"v":3` discriminator + `"node_id"` is sufficient
/// to disambiguate from the legacy v1 `{"join_token": "..."}` form.
fn looks_like_v3(text: &str) -> bool {
    let v: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let is_v3 = v.get("v").and_then(|v| v.as_u64()) == Some(super::wire::WIRE_VERSION as u64);
    is_v3 && v.get("node_id").and_then(|v| v.as_str()).is_some()
}

/// H-9: shape of the v3 handshake on the wire. The originator (the
/// peer dialing in) signs `node_id || nonce` with its Ed25519 secret
/// and we verify against the pinned-peer registry. Mutual signing
/// (so the dialer can verify us too) lives in a follow-up — for now
/// the inbound side is the asymmetric trust hop.
#[derive(serde::Deserialize)]
struct V3Handshake {
    #[serde(rename = "v")]
    _version: u32,
    node_id: String,
    nonce: String,
    signature: String,
}

impl Transport {
    /// Parse + verify a v3 handshake. On success returns the peer's
    /// `node_id`; on failure returns a static reason string suitable
    /// for an audit / `tracing::warn!`.
    fn validate_v3_handshake(&self, text: &str) -> Result<String, &'static str> {
        let hs: V3Handshake = serde_json::from_str(text).map_err(|_| "v3 handshake malformed")?;

        // node_identity isn't used in this verify path directly —
        // it's a marker that the operator has opted into v3 by
        // running through identity::ensure at boot. Mutual handshake
        // (using identity to sign back to the dialer) lands later.
        if self.node_identity.is_none() {
            return Err("v3 handshake unsupported: no local node identity");
        }
        let db = self
            .db
            .as_ref()
            .ok_or("v3 verify path needs the transport's DB handle")?;

        use base64::Engine as _;
        let nonce_bytes = base64::engine::general_purpose::STANDARD
            .decode(hs.nonce.as_str())
            .map_err(|_| "v3 nonce not valid base64")?;
        if nonce_bytes.len() < 16 {
            return Err("v3 nonce too short");
        }
        let sig_bytes = base64::engine::general_purpose::STANDARD
            .decode(hs.signature.as_str())
            .map_err(|_| "v3 signature not valid base64")?;
        let sig_arr: [u8; 64] = sig_bytes
            .as_slice()
            .try_into()
            .map_err(|_| "v3 signature wrong length")?;
        let signature = ed25519_dalek::Signature::from_bytes(&sig_arr);

        // Look up the originator's pinned public key via the
        // federation_peers table.
        let pk_opt = db
            .with_read(|conn| super::peers::active_public_key(conn, &hs.node_id))
            .map_err(|_| "v3 pinned-peer lookup failed")?;
        let pk = pk_opt.ok_or("v3 origin peer not pinned")?;

        // Signing input is `node_id || nonce`. Minimal challenge for
        // step 1 of H-9; mutual + receiver-id binding lands in H-11
        // follow-up.
        let mut signing_bytes = hs.node_id.as_bytes().to_vec();
        signing_bytes.extend_from_slice(&nonce_bytes);
        use ed25519_dalek::Verifier;
        pk.verify(&signing_bytes, &signature)
            .map_err(|_| "v3 signature invalid")?;

        Ok(hs.node_id)
    }
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

/// H-11: provenance carried alongside each inbound event. When the
/// frame was a v3 signed envelope, all three fields are populated and
/// downstream `mesh.handle_federation_event` can run authority
/// + seq-watermark checks before applying the merge. For legacy v1
/// frames, every field is None.
#[derive(Debug, Clone, Default)]
pub struct EventProvenance {
    pub origin_node_id: Option<String>,
    pub seq: Option<u64>,
    pub event_id: Option<String>,
}

/// Callback invoked when a federation event arrives from a peer.
pub type OnEventFn =
    Arc<dyn Fn(String, FederationEvent, EventProvenance) + Send + Sync>;

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
    /// VULN-014 / H7: when false, refuse to connect to plain ws:// peer
    /// URLs and disable the "any peer accepted" empty-secret fallback.
    insecure: bool,
    /// H-9 Phase 3 transport handshake. Optional Ed25519 identity for
    /// the local node — when set, `handle_incoming` accepts a v3
    /// signed handshake alongside the legacy v1 (`join_token`) one.
    /// Outbound dial stays on v1 today; flipping outbound to v3 lands
    /// once every peer has been re-pinned with its public key.
    node_identity: Option<Arc<super::identity::NodeIdentity>>,
    /// H-9 / H-11 strictness gate. When `true`, reject v1 inbound
    /// handshakes outright — only v3 is accepted. Maps from the
    /// `DILLA_FEDERATION_REQUIRE_V3` env var. Default false during
    /// the rolling-upgrade window so v1-only peers keep working.
    require_v3: bool,
    /// H-9 DB handle for the v3 handshake's pinned-peer lookup. None
    /// when Transport is constructed in test contexts; v3 is only
    /// available when this is Some.
    db: Option<crate::db::Database>,
    stop_tx: tokio::sync::watch::Sender<bool>,
    stop_rx: tokio::sync::watch::Receiver<bool>,
}

/// Build the WebSocket URL for a federation peer.
///
/// If the address already contains `://`, it is used as-is (with a warning for
/// unencrypted `ws://`). Otherwise, defaults to `wss://{address}/federation`.
#[cfg(test)]
fn build_peer_url(address: &str) -> String {
    build_peer_url_with_insecure(address, false)
}

/// VULN-014 / H7: insecure-aware variant. When `insecure=false` we
/// refuse a plain `ws://` peer URL by returning an empty string —
/// callers convert that into a "refusing to connect" error. When
/// `insecure=true` we still accept ws:// for the dev pattern but log
/// loudly. Bare hostnames continue to default to wss://.
fn build_peer_url_with_insecure(address: &str, insecure: bool) -> String {
    if address.contains("://") {
        if address.starts_with("ws://") {
            if !insecure {
                tracing::error!(
                    "Federation peer {} uses unencrypted ws:// and DILLA_INSECURE=false — refusing to connect (VULN-014)",
                    address
                );
                return String::new();
            }
            tracing::warn!(
                "Federation peer {} uses unencrypted ws:// — accepted because DILLA_INSECURE=true (do not use in production)",
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
        Self::with_settings(join_secret, false)
    }

    pub fn with_settings(join_secret: String, insecure: bool) -> Self {
        Self::with_settings_full(join_secret, insecure, None, false, None)
    }

    /// H-9 Phase 3 constructor: supplies the local node's Ed25519
    /// identity (so the v3 inbound handshake can verify peer
    /// signatures against the pinned-peer table), the `require_v3`
    /// strictness gate, and a DB handle for the pinned-peer lookup.
    pub fn with_settings_full(
        join_secret: String,
        insecure: bool,
        node_identity: Option<Arc<super::identity::NodeIdentity>>,
        require_v3: bool,
        db: Option<crate::db::Database>,
    ) -> Self {
        let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
        Transport {
            conns: Arc::new(RwLock::new(HashMap::new())),
            peers: Arc::new(RwLock::new(Vec::new())),
            on_event: Arc::new(RwLock::new(None)),
            join_secret,
            insecure,
            node_identity,
            require_v3,
            db,
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

        let url = build_peer_url_with_insecure(address, self.insecure);
        if url.is_empty() {
            return Err(format!(
                "refusing to connect to plain ws:// peer {} (set DILLA_INSECURE=true to allow)",
                address
            ));
        }

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

        // Authenticate. With a non-empty secret we wait for a join_token
        // within AUTH_TIMEOUT_SECS. With an empty secret we either refuse
        // outright (default — closes the edge case where a node with no
        // outbound peers but federation listener up would silently accept
        // anonymous inbound) OR allow when explicitly `insecure=true`
        // (dev pattern). The old code short-circuited on
        // `requires_auth(empty) == false` and never consulted the
        // insecure flag.
        if self.join_secret.is_empty() {
            if !self.insecure {
                tracing::warn!(peer = %peer_addr, "federation peer refused: empty join_secret and insecure=false");
                let mut s = sink.lock().await;
                let _ = s.send(Message::Close(None)).await;
                return;
            }
            // insecure=true → fall through, accept anonymously (dev only)
        } else {
            let auth_result = tokio::time::timeout(
                tokio::time::Duration::from_secs(AUTH_TIMEOUT_SECS),
                stream.next(),
            )
            .await;

            // H-9: dispatch on the wire shape. If the first text frame
            // parses as a v3 handshake ({"v": 3, "node_id": ..., ...})
            // run the Ed25519 verifier against the pinned-peers
            // registry. Otherwise fall back to the legacy v1
            // shared-secret check, unless require_v3=true in which
            // case we refuse outright.
            let authenticated = match auth_result {
                Ok(Some(Ok(Message::Text(text)))) => {
                    if looks_like_v3(&text) {
                        match self.validate_v3_handshake(&text) {
                            Ok(node_id) => {
                                tracing::info!(peer = %peer_addr, node_id = %node_id, "federation peer authenticated (v3)");
                                true
                            }
                            Err(reason) => {
                                tracing::warn!(peer = %peer_addr, %reason, "federation v3 handshake rejected");
                                false
                            }
                        }
                    } else if self.require_v3 {
                        tracing::warn!(peer = %peer_addr, "federation peer sent v1 handshake but require_v3=true — refusing");
                        false
                    } else {
                        validate_auth_message_with_insecure(&text, &self.join_secret, self.insecure)
                    }
                }
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
    ///
    /// H-10: when this transport carries a `node_identity`, we wrap
    /// the event in a `SignedFederationEvent` envelope so receivers
    /// running with `require_v3=true` accept it. The seq number is a
    /// monotonic per-process counter (per-(node, team) seq lands with
    /// the watermark integration in a follow-up). Without an identity,
    /// the legacy bare-event form is sent — same as before.
    pub async fn broadcast(&self, event: &FederationEvent) {
        let data = match self.serialize_for_wire(event) {
            Some(s) => s,
            None => return,
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

    /// H-10: pick the wire form for outbound events. When we have a
    /// `node_identity`, sign via `wire::sign` + emit the
    /// `SignedFederationEvent` JSON. Otherwise (and during the
    /// rolling-upgrade window when peers may still be v1-only),
    /// emit the raw `FederationEvent` JSON.
    fn serialize_for_wire(&self, event: &FederationEvent) -> Option<String> {
        if let Some(identity) = self.node_identity.as_ref() {
            // Per-process monotonic counter. Real per-(origin, team)
            // sequencing rides federation_seq_watermark; that ties
            // into the merge-side verifier landing later.
            use std::sync::atomic::{AtomicU64, Ordering};
            static SEQ: AtomicU64 = AtomicU64::new(1);
            let seq = SEQ.fetch_add(1, Ordering::Relaxed);
            match super::wire::sign(identity.as_ref(), event.clone(), seq) {
                Ok(signed) => match serde_json::to_string(&signed) {
                    Ok(s) => return Some(s),
                    Err(e) => {
                        tracing::error!("failed to serialize signed event: {}", e);
                        // Fall through to legacy form below.
                    }
                },
                Err(e) => {
                    tracing::error!("failed to sign federation event: {}", e);
                    // Fall through.
                }
            }
        }
        match serde_json::to_string(event) {
            Ok(d) => Some(d),
            Err(e) => {
                tracing::error!("failed to serialize federation event: {}", e);
                None
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
        // H-10: capture the verification context (db + require_v3) so
        // the read pump can dispatch on the wire shape.
        let db = self.db.clone();
        let require_v3 = self.require_v3;

        tokio::spawn(async move {
            loop {
                match stream.next().await {
                    Some(Ok(Message::Text(text))) => {
                        // H-10: dispatch on wire shape. v3 envelopes
                        // are SignedFederationEvent ({ v: 3, event,
                        // origin_node_id, seq, event_id, signature });
                        // legacy v1 is the bare FederationEvent.
                        // wire::verify enforces signature + pinned
                        // peer. authority::check + seq watermark land
                        // with the merge-side hardening follow-up.
                        let dispatched: Option<(FederationEvent, EventProvenance)> =
                            if text.contains("\"v\":3") || text.contains("\"v\": 3") {
                                match serde_json::from_str::<super::wire::SignedFederationEvent>(&text) {
                                    Ok(signed) => {
                                        let verify_result = match db.as_ref() {
                                            Some(d) => d
                                                .with_read(|conn| {
                                                    Ok::<_, rusqlite::Error>(
                                                        super::wire::verify(conn, &signed).err(),
                                                    )
                                                })
                                                .ok()
                                                .flatten(),
                                            None => Some(super::wire::WireError::Db(
                                                rusqlite::Error::InvalidParameterName(
                                                    "transport has no db".into(),
                                                ),
                                            )),
                                        };
                                        if let Some(err) = verify_result {
                                            tracing::warn!(
                                                peer = %peer_addr,
                                                origin = %signed.origin_node_id,
                                                error = %err,
                                                "federation v3 event rejected at verify"
                                            );
                                            None
                                        } else {
                                            // H-11: surface provenance so the merge side can
                                            // run authority::check + seq watermark.
                                            let prov = EventProvenance {
                                                origin_node_id: Some(signed.origin_node_id.clone()),
                                                seq: Some(signed.seq),
                                                event_id: Some(signed.event_id.clone()),
                                            };
                                            Some((signed.event, prov))
                                        }
                                    }
                                    Err(e) => {
                                        tracing::warn!(
                                            peer = %peer_addr,
                                            "failed to parse v3 signed event: {}",
                                            e
                                        );
                                        None
                                    }
                                }
                            } else if require_v3 {
                                tracing::warn!(
                                    peer = %peer_addr,
                                    "federation event rejected — require_v3=true but received legacy v1 frame"
                                );
                                None
                            } else {
                                match serde_json::from_str::<FederationEvent>(&text) {
                                    Ok(event) => Some((event, EventProvenance::default())),
                                    Err(e) => {
                                        tracing::warn!(
                                            peer = %peer_addr,
                                            "failed to parse federation event: {}",
                                            e
                                        );
                                        None
                                    }
                                }
                            };
                        if let Some((event, prov)) = dispatched {
                            let handler = on_event.read().await;
                            if let Some(ref cb) = *handler {
                                cb(peer_addr.clone(), event, prov);
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
    fn test_build_peer_url_ws_refused_by_default() {
        // VULN-014 / H7: default-deny on plain ws://.
        assert_eq!(build_peer_url("ws://example.com:8081/federation"), "");
    }

    #[test]
    fn test_build_peer_url_ws_allowed_when_insecure() {
        // VULN-014 / H7: explicit opt-in keeps the dev pattern working.
        assert_eq!(
            build_peer_url_with_insecure("ws://example.com:8081/federation", true),
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
    fn validate_v3_handshake_rejects_malformed_json() {
        let t = Transport::new();
        assert_eq!(t.validate_v3_handshake("not-json"), Err("v3 handshake malformed"));
    }

    #[test]
    fn validate_v3_handshake_rejects_when_no_node_identity() {
        let t = Transport::new();
        let hs = r#"{"v":3,"node_id":"n1","nonce":"AAAAAAAAAAAAAAAAAAAAAA==","signature":""}"#;
        assert_eq!(
            t.validate_v3_handshake(hs),
            Err("v3 handshake unsupported: no local node identity"),
        );
    }

    #[test]
    fn validate_v3_handshake_rejects_malformed_nonce_base64() {
        let tmp = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
        db.run_migrations().unwrap();
        let identity = Arc::new(crate::federation::identity::ensure(&db).unwrap());
        let t = Transport::with_settings_full(
            String::new(), false, Some(identity), false, Some(db),
        );
        let hs = r#"{"v":3,"node_id":"n1","nonce":"!!!not-base64","signature":""}"#;
        assert_eq!(
            t.validate_v3_handshake(hs),
            Err("v3 nonce not valid base64"),
        );
    }

    #[test]
    fn validate_v3_handshake_rejects_short_nonce() {
        let tmp = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
        db.run_migrations().unwrap();
        let identity = Arc::new(crate::federation::identity::ensure(&db).unwrap());
        let t = Transport::with_settings_full(
            String::new(), false, Some(identity), false, Some(db),
        );
        // Valid base64 but only 3 bytes after decode → too short
        let hs = r#"{"v":3,"node_id":"n1","nonce":"YWJj","signature":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}"#;
        assert_eq!(
            t.validate_v3_handshake(hs),
            Err("v3 nonce too short"),
        );
    }

    #[test]
    fn validate_v3_handshake_rejects_malformed_signature_base64() {
        let tmp = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
        db.run_migrations().unwrap();
        let identity = Arc::new(crate::federation::identity::ensure(&db).unwrap());
        let t = Transport::with_settings_full(
            String::new(), false, Some(identity), false, Some(db),
        );
        let hs = r#"{"v":3,"node_id":"n1","nonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","signature":"!!!bad"}"#;
        assert_eq!(
            t.validate_v3_handshake(hs),
            Err("v3 signature not valid base64"),
        );
    }

    #[test]
    fn validate_v3_handshake_rejects_wrong_length_signature() {
        let tmp = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
        db.run_migrations().unwrap();
        let identity = Arc::new(crate::federation::identity::ensure(&db).unwrap());
        let t = Transport::with_settings_full(
            String::new(), false, Some(identity), false, Some(db),
        );
        // Valid base64 nonce (24 bytes) + signature only 4 bytes after decode → wrong length
        let hs = r#"{"v":3,"node_id":"n1","nonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","signature":"AAAAAA=="}"#;
        assert_eq!(
            t.validate_v3_handshake(hs),
            Err("v3 signature wrong length"),
        );
    }

    #[test]
    fn validate_v3_handshake_accepts_valid_signed_handshake() {
        use ed25519_dalek::{Signer, SigningKey};
        let tmp = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
        db.run_migrations().unwrap();
        let identity = Arc::new(crate::federation::identity::ensure(&db).unwrap());

        // Pin the remote peer with its public key so the verify step has
        // something to look up.
        let signing_key = SigningKey::from_bytes(&[42u8; 32]);
        let verifying_key = signing_key.verifying_key();
        db.with_conn(|c| {
            crate::federation::peers::pin(c, "remote-node", &verifying_key, "peer.example")
                .map(|_| ())
        })
        .unwrap();

        // Build the signed handshake: signing input is `node_id || nonce`.
        let node_id = "remote-node";
        let nonce_bytes = vec![7u8; 24];
        let mut signing_bytes = node_id.as_bytes().to_vec();
        signing_bytes.extend_from_slice(&nonce_bytes);
        let signature = signing_key.sign(&signing_bytes);
        use base64::Engine as _;
        let nonce_b64 = base64::engine::general_purpose::STANDARD.encode(&nonce_bytes);
        let sig_b64 = base64::engine::general_purpose::STANDARD.encode(signature.to_bytes());

        let t = Transport::with_settings_full(
            String::new(), false, Some(identity), false, Some(db),
        );
        let hs = format!(
            r#"{{"v":3,"node_id":"{}","nonce":"{}","signature":"{}"}}"#,
            node_id, nonce_b64, sig_b64
        );
        assert_eq!(t.validate_v3_handshake(&hs), Ok(node_id.to_string()));
    }

    #[test]
    fn validate_v3_handshake_rejects_bad_signature_on_pinned_peer() {
        use ed25519_dalek::SigningKey;
        let tmp = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
        db.run_migrations().unwrap();
        let identity = Arc::new(crate::federation::identity::ensure(&db).unwrap());

        let signing_key = SigningKey::from_bytes(&[42u8; 32]);
        let verifying_key = signing_key.verifying_key();
        db.with_conn(|c| {
            crate::federation::peers::pin(c, "remote-node", &verifying_key, "peer.example")
                .map(|_| ())
        })
        .unwrap();

        // Use 64 zero bytes as the signature — won't verify against the pubkey.
        use base64::Engine as _;
        let bad_sig_b64 = base64::engine::general_purpose::STANDARD.encode([0u8; 64]);
        let nonce_b64 = base64::engine::general_purpose::STANDARD.encode([7u8; 24]);

        let t = Transport::with_settings_full(
            String::new(), false, Some(identity), false, Some(db),
        );
        let hs = format!(
            r#"{{"v":3,"node_id":"remote-node","nonce":"{}","signature":"{}"}}"#,
            nonce_b64, bad_sig_b64
        );
        assert_eq!(t.validate_v3_handshake(&hs), Err("v3 signature invalid"));
    }

    #[test]
    fn validate_v3_handshake_rejects_unpinned_peer() {
        let tmp = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
        db.run_migrations().unwrap();
        let identity = Arc::new(crate::federation::identity::ensure(&db).unwrap());
        let t = Transport::with_settings_full(
            String::new(), false, Some(identity), false, Some(db),
        );
        // Well-formed body but the originator node_id isn't in the pinned-peer table.
        // Signature: 64 zero bytes = base64 "AAAA"*21 + "AA==" (88 chars total)
        let sig_b64 = "A".repeat(84) + "AA==";
        let hs = format!(
            r#"{{"v":3,"node_id":"unpinned-node","nonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","signature":"{}"}}"#,
            sig_b64
        );
        assert_eq!(
            t.validate_v3_handshake(&hs),
            Err("v3 origin peer not pinned"),
        );
    }

    // ── send / broadcast / peer_statuses / stop ─────────────────────

    #[tokio::test]
    async fn send_returns_err_when_peer_not_connected() {
        let t = Transport::new();
        let ev = super::super::FederationEvent {
            event_type: "test".into(),
            node_name: "n".into(),
            timestamp: 1,
            payload: serde_json::Value::Null,
        };
        let res = t.send("unknown-peer", &ev).await;
        let err = res.unwrap_err();
        assert!(err.contains("not connected"));
    }

    #[tokio::test]
    async fn broadcast_with_zero_peers_does_not_panic() {
        let t = Transport::new();
        let ev = super::super::FederationEvent {
            event_type: "test".into(),
            node_name: "n".into(),
            timestamp: 1,
            payload: serde_json::Value::Null,
        };
        // No peers registered → broadcast iterates 0 peers and returns.
        t.broadcast(&ev).await;
    }

    #[tokio::test]
    async fn peer_statuses_is_empty_for_fresh_transport() {
        let t = Transport::new();
        assert!(t.peer_statuses().await.is_empty());
    }

    #[tokio::test]
    async fn stop_clears_connection_map() {
        let t = Transport::new();
        // Fresh transport has no conns; stop should still return cleanly.
        t.stop().await;
        assert!(t.peer_statuses().await.is_empty());
    }

    #[tokio::test]
    async fn connect_to_peer_refuses_plain_ws_when_not_insecure() {
        let t = Transport::new();
        let err = t.connect_to_peer("ws://example.com:8081").await.unwrap_err();
        assert!(err.contains("refusing to connect"));
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
        // Empty token against non-empty configured secret → refuse.
        assert!(!validate_auth_message(msg, "secret"));
        // Empty configured secret without insecure flag → refuse
        // (closes the federation listener empty-secret edge case).
        assert!(!validate_auth_message(msg, ""));
        // Empty configured secret WITH insecure=true → accept (dev).
        assert!(validate_auth_message_with_insecure(msg, "", true));
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

    // ── looks_like_v3 wire shape sniff ───────────────────────────────

    #[test]
    fn looks_like_v3_recognises_well_formed_v3_handshake() {
        let text = r#"{"v":3,"node_id":"n1","nonce":"abc","signature":"sig"}"#;
        assert!(looks_like_v3(text));
    }

    #[test]
    fn looks_like_v3_rejects_legacy_v1_join_token_format() {
        // Pre-v3 auth message — must NOT be sniffed as v3.
        let v1 = r#"{"join_token":"secret"}"#;
        assert!(!looks_like_v3(v1));
    }

    #[test]
    fn looks_like_v3_rejects_wrong_version_number() {
        let v2 = r#"{"v":2,"node_id":"n1","nonce":"abc"}"#;
        assert!(!looks_like_v3(v2));
        let v4 = r#"{"v":4,"node_id":"n1","nonce":"abc"}"#;
        assert!(!looks_like_v3(v4));
    }

    #[test]
    fn looks_like_v3_rejects_missing_node_id() {
        let text = r#"{"v":3,"nonce":"abc"}"#;
        assert!(!looks_like_v3(text));
    }

    #[test]
    fn looks_like_v3_rejects_node_id_of_wrong_type() {
        // node_id must be a string; numbers / null / object don't count.
        let text = r#"{"v":3,"node_id":123,"nonce":"x"}"#;
        assert!(!looks_like_v3(text));
    }

    #[test]
    fn looks_like_v3_rejects_invalid_json() {
        assert!(!looks_like_v3("not-json"));
        assert!(!looks_like_v3(""));
        assert!(!looks_like_v3("{"));
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
    async fn handle_incoming_accepts_valid_v3_handshake() {
        use ed25519_dalek::{Signer, SigningKey};

        let (listener, port) = start_tcp_listener().await;
        // Set up DB with our local identity + pin the remote signing key.
        let tmp = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
        db.run_migrations().unwrap();
        let local_id = Arc::new(crate::federation::identity::ensure(&db).unwrap());
        let remote_sk = SigningKey::from_bytes(&[33u8; 32]);
        let remote_pk = remote_sk.verifying_key();
        db.with_conn(|c| {
            crate::federation::peers::pin(c, "remote", &remote_pk, "peer.example").map(|_| ())
        })
        .unwrap();

        // Federation transport with join_secret + identity + db so handshake gate runs.
        let transport = Transport::with_settings_full(
            "secret".into(), false, Some(local_id), false, Some(db),
        );

        // Client signs `node_id || nonce` with the pinned key, sends v3 handshake.
        let client_handle = tokio::spawn(async move {
            let url = format!("ws://127.0.0.1:{}", port);
            let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
            let node_id = "remote";
            let nonce = vec![7u8; 24];
            let mut signing_bytes = node_id.as_bytes().to_vec();
            signing_bytes.extend_from_slice(&nonce);
            let sig = remote_sk.sign(&signing_bytes);
            use base64::Engine as _;
            let nonce_b64 = base64::engine::general_purpose::STANDARD.encode(&nonce);
            let sig_b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());
            let hs = format!(
                r#"{{"v":3,"node_id":"{}","nonce":"{}","signature":"{}"}}"#,
                node_id, nonce_b64, sig_b64
            );
            ws.send(Message::Text(hs.into())).await.unwrap();
            tokio::time::sleep(tokio::time::Duration::from_millis(150)).await;
            let _ = ws.close(None).await;
        });

        let (tcp_stream, _) = listener.accept().await.unwrap();
        let ws_stream = tokio_tungstenite::accept_async(MaybeTlsStream::Plain(tcp_stream))
            .await
            .unwrap();
        transport.handle_incoming("remote-peer", ws_stream).await;

        let conns = transport.conns.read().await;
        assert!(conns.contains_key("remote-peer"), "v3-authenticated peer should be registered");
        let _ = client_handle.await;
    }

    #[tokio::test]
    async fn handle_incoming_v1_secret_rejected_when_require_v3_is_true() {
        let (listener, port) = start_tcp_listener().await;
        // join_secret set + require_v3=true → v1 handshake refused.
        let transport = Transport::with_settings_full(
            "secret".into(), false, None, /*require_v3*/ true, None,
        );

        let client_handle = tokio::spawn(async move {
            let url = format!("ws://127.0.0.1:{}", port);
            let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
            // Send v1-shaped join token; the receiver expects v3 only.
            ws.send(Message::Text(r#"{"join_token":"secret"}"#.into()))
                .await
                .unwrap();
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
        transport.handle_incoming("legacy-v1-peer", ws_stream).await;

        let conns = transport.conns.read().await;
        assert!(!conns.contains_key("legacy-v1-peer"));
        client_handle.await.unwrap();
    }

    #[tokio::test]
    async fn handle_incoming_refuses_empty_join_secret_without_insecure() {
        let (listener, port) = start_tcp_listener().await;
        // Empty join secret + insecure=false → immediate close on connect.
        let transport = Transport::new();

        let client_handle = tokio::spawn(async move {
            let url = format!("ws://127.0.0.1:{}", port);
            let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
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

        transport.handle_incoming("anon-peer", ws_stream).await;

        // The conns map should NOT contain the peer because we refused
        // the empty-secret/insecure=false handshake.
        let conns = transport.conns.read().await;
        assert!(!conns.contains_key("anon-peer"));
        client_handle.await.unwrap();
    }

    #[tokio::test]
    async fn read_pump_rejects_v1_event_when_require_v3_true() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let (listener, port) = start_tcp_listener().await;
        // require_v3=true so legacy v1 events are dropped at the read pump.
        // Use empty secret + insecure so the auth gate passes via dev path.
        let transport = Transport::with_settings_full(
            String::new(), true, None, /*require_v3*/ true, None,
        );

        let received = Arc::new(AtomicBool::new(false));
        let received_clone = Arc::clone(&received);
        transport
            .set_on_event(Arc::new(move |_peer, _event, _prov| {
                received_clone.store(true, Ordering::SeqCst);
            }))
            .await;

        let client_handle = tokio::spawn(async move {
            let url = format!("ws://127.0.0.1:{}", port);
            let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
            let event = serde_json::json!({
                "type": "test",
                "node_name": "remote",
                "timestamp": 42,
                "payload": null,
            });
            tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
            ws.send(Message::Text(event.to_string().into())).await.unwrap();
            tokio::time::sleep(tokio::time::Duration::from_millis(150)).await;
            let _ = ws.close(None).await;
        });

        let (tcp_stream, _) = listener.accept().await.unwrap();
        let ws_stream = tokio_tungstenite::accept_async(MaybeTlsStream::Plain(tcp_stream))
            .await
            .unwrap();
        transport.handle_incoming("relay-peer-v3only", ws_stream).await;

        tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
        // Handler must NOT have fired — require_v3 rejected the v1 frame.
        assert!(!received.load(Ordering::SeqCst));
        let _ = client_handle.await;
    }

    #[tokio::test]
    async fn stop_closes_connected_peers() {
        let (listener, port) = start_tcp_listener().await;
        let transport = Transport::with_settings(String::new(), true);

        let client_handle = tokio::spawn(async move {
            let url = format!("ws://127.0.0.1:{}", port);
            let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
            // Read until close (which the server-side stop() will send).
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
        transport.handle_incoming("p1", ws_stream).await;

        // Stop the transport — this should send Close(None) to the
        // registered peer and clear the conns map.
        transport.stop().await;
        let conns = transport.conns.read().await;
        assert!(conns.is_empty());

        let _ = client_handle.await;
    }

    #[tokio::test]
    async fn read_pump_dispatches_valid_v3_signed_event() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let (listener, port) = start_tcp_listener().await;
        let tmp = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
        db.run_migrations().unwrap();
        // Use the local node identity to sign + pin its own pubkey so wire::verify
        // resolves on the receive side. The signed envelope carries `node_id`
        // which both produces the pinned-peer key and is what verify checks.
        let local_id = Arc::new(crate::federation::identity::ensure(&db).unwrap());
        db.with_conn(|c| {
            crate::federation::peers::pin(c, &local_id.node_id, &local_id.public_key, "loopback").map(|_| ())
        })
        .unwrap();
        let expected_node_id = local_id.node_id.clone();
        let signing_id = Arc::clone(&local_id);

        let transport = Transport::with_settings_full(
            String::new(), true, Some(local_id), false, Some(db.clone()),
        );

        let received = Arc::new(AtomicBool::new(false));
        let received_clone = Arc::clone(&received);
        let expected_node_id_clone = expected_node_id.clone();
        transport
            .set_on_event(Arc::new(move |_peer, _event, prov| {
                if prov.origin_node_id.as_deref() == Some(expected_node_id_clone.as_str()) {
                    received_clone.store(true, Ordering::SeqCst);
                }
            }))
            .await;

        let client_handle = tokio::spawn(async move {
            let url = format!("ws://127.0.0.1:{}", port);
            let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
            let event = super::super::FederationEvent {
                event_type: "test-v3".into(),
                node_name: "loopback".into(),
                timestamp: 99,
                payload: serde_json::Value::Null,
            };
            let signed = crate::federation::wire::sign(&signing_id, event, 42).unwrap();
            let json = serde_json::to_string(&signed).unwrap();
            tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
            ws.send(Message::Text(json.into())).await.unwrap();
            tokio::time::sleep(tokio::time::Duration::from_millis(150)).await;
            let _ = ws.close(None).await;
        });

        let (tcp_stream, _) = listener.accept().await.unwrap();
        let ws_stream = tokio_tungstenite::accept_async(MaybeTlsStream::Plain(tcp_stream))
            .await
            .unwrap();
        transport.handle_incoming("peer-v3-conn", ws_stream).await;

        tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
        assert!(received.load(Ordering::SeqCst), "expected v3 dispatch to fire");
        let _ = client_handle.await;
    }

    #[tokio::test]
    async fn read_pump_rejects_malformed_v3_event() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let (listener, port) = start_tcp_listener().await;
        // No identity / no DB → first branch picks up "v":3 in text but
        // serde_json::from_str::<SignedFederationEvent> fails on broken payload.
        let transport = Transport::with_settings_full(
            String::new(), true, None, false, None,
        );

        let received = Arc::new(AtomicBool::new(false));
        let received_clone = Arc::clone(&received);
        transport
            .set_on_event(Arc::new(move |_p, _e, _pr| {
                received_clone.store(true, Ordering::SeqCst);
            }))
            .await;

        let client_handle = tokio::spawn(async move {
            let url = format!("ws://127.0.0.1:{}", port);
            let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
            // Has "v":3 marker but lacks required SignedFederationEvent fields.
            let bad = r#"{"v":3,"node_id":"x","not_a_signed_event":true}"#;
            tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
            ws.send(Message::Text(bad.into())).await.unwrap();
            tokio::time::sleep(tokio::time::Duration::from_millis(150)).await;
            let _ = ws.close(None).await;
        });

        let (tcp_stream, _) = listener.accept().await.unwrap();
        let ws_stream = tokio_tungstenite::accept_async(MaybeTlsStream::Plain(tcp_stream))
            .await
            .unwrap();
        transport.handle_incoming("malformed-v3", ws_stream).await;

        tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
        assert!(!received.load(Ordering::SeqCst), "handler must NOT fire on malformed v3");
        let _ = client_handle.await;
    }

    #[tokio::test]
    async fn read_pump_dispatches_legacy_v1_event_to_handler() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let (listener, port) = start_tcp_listener().await;
        let transport = Transport::with_settings(String::new(), true);

        // Install a handler that flips a flag when an event arrives.
        let received = Arc::new(AtomicBool::new(false));
        let received_clone = Arc::clone(&received);
        transport
            .set_on_event(Arc::new(move |_peer, _event, _prov| {
                received_clone.store(true, Ordering::SeqCst);
            }))
            .await;

        let client_handle = tokio::spawn(async move {
            let url = format!("ws://127.0.0.1:{}", port);
            let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
            // Send a v1-shaped federation event. `event_type` is wire-renamed to "type".
            let event = serde_json::json!({
                "type": "test",
                "node_name": "remote",
                "timestamp": 42,
                "payload": null,
            });
            // Small delay so the server-side handle_incoming gets past
            // its setup and the read pump is listening when we send.
            tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
            ws.send(Message::Text(event.to_string().into())).await.unwrap();
            // Give the read pump time to dispatch.
            tokio::time::sleep(tokio::time::Duration::from_millis(150)).await;
            let _ = ws.close(None).await;
        });

        let (tcp_stream, _) = listener.accept().await.unwrap();
        let ws_stream = tokio_tungstenite::accept_async(MaybeTlsStream::Plain(tcp_stream))
            .await
            .unwrap();
        transport.handle_incoming("relay-peer", ws_stream).await;

        // Wait for the spawned read pump to process the event.
        tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
        assert!(received.load(Ordering::SeqCst), "expected on_event handler to fire");
        let _ = client_handle.await;
    }

    #[tokio::test]
    async fn send_succeeds_when_peer_connected_after_handshake() {
        let (listener, port) = start_tcp_listener().await;
        let transport = Transport::with_settings(String::new(), true);

        // Wire up the client that connects and listens.
        let client_handle = tokio::spawn(async move {
            let url = format!("ws://127.0.0.1:{}", port);
            let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
            // Read until close or a message.
            let _ = ws.next().await;
        });

        let (tcp_stream, _) = listener.accept().await.unwrap();
        let ws_stream = tokio_tungstenite::accept_async(MaybeTlsStream::Plain(tcp_stream))
            .await
            .unwrap();
        transport.handle_incoming("connected-peer", ws_stream).await;

        // Now send a federation event to the connected peer — exercises
        // send()'s Message::Text branch + serialize path.
        let ev = super::super::FederationEvent {
            event_type: "test".into(),
            node_name: "n".into(),
            timestamp: 1,
            payload: serde_json::Value::Null,
        };
        let res = transport.send("connected-peer", &ev).await;
        assert!(res.is_ok());

        // Broadcast also iterates the same connection so this hits the
        // broadcast-with-conns path.
        transport.broadcast(&ev).await;

        let _ = client_handle.await;
    }

    #[tokio::test]
    async fn handle_incoming_accepts_empty_join_secret_with_insecure() {
        let (listener, port) = start_tcp_listener().await;
        // Empty join secret + insecure=true → accepts anonymously (dev pattern).
        let transport = Transport::with_settings(String::new(), true);

        let client_handle = tokio::spawn(async move {
            let url = format!("ws://127.0.0.1:{}", port);
            let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
            // Close from client side so handle_incoming finishes cleanly.
            let _ = ws.close(None).await;
        });

        let (tcp_stream, _) = listener.accept().await.unwrap();
        let ws_stream = tokio_tungstenite::accept_async(MaybeTlsStream::Plain(tcp_stream))
            .await
            .unwrap();

        transport.handle_incoming("insecure-peer", ws_stream).await;

        let conns = transport.conns.read().await;
        assert!(conns.contains_key("insecure-peer"));
        client_handle.await.unwrap();
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
        // insecure=true so the test loopback ws:// connection isn't
        // refused by the production-mode plain-WebSocket guard.
        let transport = Transport::with_settings("outbound-secret".to_string(), true);

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
        // VULN-005/-021: empty join_secret in production mode refuses
        // anonymous peers. The test is exercising the "operator
        // explicitly opted into anonymous federation" path — i.e.,
        // insecure=true.
        let transport = Transport::with_settings(String::new(), true);

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
