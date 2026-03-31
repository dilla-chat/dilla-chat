pub mod join;
pub mod sync;
pub mod transport;

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::RwLock;

use crate::db::{self, Database, Message};
use crate::ws::Hub;

use join::JoinManager;
use sync::{StateSyncData, SyncManager};
use transport::Transport;

// ── Federation event type constants ────────────────────────────────────────

pub const FED_EVENT_MESSAGE_NEW: &str = "message:new";
pub const FED_EVENT_MESSAGE_EDIT: &str = "message:edit";
pub const FED_EVENT_MESSAGE_DELETE: &str = "message:delete";
pub const FED_EVENT_PRESENCE_CHANGED: &str = "presence:changed";
pub const FED_EVENT_VOICE_USER_JOINED: &str = "voice:user:joined";
pub const FED_EVENT_VOICE_USER_LEFT: &str = "voice:user:left";
pub const FED_EVENT_STATE_SYNC_REQ: &str = "state:sync:req";
pub const FED_EVENT_STATE_SYNC_RESP: &str = "state:sync:resp";
pub const FED_EVENT_MEMBER_JOINED: &str = "member:joined";
pub const FED_EVENT_MEMBER_LEFT: &str = "member:left";

// ── Wire format types ──────────────────────────────────────────────────────

/// A federation event sent between mesh nodes over WebSocket.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FederationEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub node_name: String,
    pub timestamp: u64,
    pub payload: serde_json::Value,
}

/// A replicated message, matching the Go implementation's wire format.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplicationMessage {
    pub message_id: String,
    pub channel_id: String,
    pub author_id: String,
    pub username: String,
    pub content: String,
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(default)]
    pub thread_id: String,
    pub lamport_ts: u64,
    pub created_at: String,
}

// ── Peer info ──────────────────────────────────────────────────────────────

/// Status of a federation peer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerInfo {
    pub address: String,
    pub status: String, // "connected", "disconnected", "syncing"
    pub node_name: String,
    pub last_seen: String,
}

// ── MeshNode configuration ────────────────────────────────────────────────

/// Configuration for a federation mesh node.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct MeshConfig {
    pub node_name: String,
    pub bind_addr: String,
    pub bind_port: u16,
    pub advertise_addr: String,
    pub advertise_port: u16,
    pub peers: Vec<String>,
    pub tls_cert: String,
    pub tls_key: String,
    pub join_secret: String,
}

// ── MeshNode ───────────────────────────────────────────────────────────────

/// The central federation mesh node. Manages peer connections, event routing,
/// state synchronization, and join token management.
///
/// This is a port of the Go MeshNode that used Hashicorp Memberlist. Instead of
/// a SWIM gossip layer, it uses WebSocket transport for peer-to-peer communication.
/// The SWIM gossip integration can be added as a hook point via the transport layer.
#[allow(dead_code)]
pub struct MeshNode {
    pub node_name: String,
    config: MeshConfig,
    transport: Arc<Transport>,
    sync_mgr: Arc<SyncManager>,
    join_mgr: Arc<JoinManager>,
    db: Database,
    hub: Arc<Hub>,
    peers: Arc<RwLock<HashMap<String, PeerInfo>>>,
}

#[allow(dead_code)]
impl MeshNode {
    /// Create a new MeshNode with the given configuration, database, and hub references.
    pub fn new(config: MeshConfig, db: Database, hub: Arc<Hub>) -> Self {
        let transport = Arc::new(Transport::with_join_secret(config.join_secret.clone()));
        let sync_mgr = Arc::new(SyncManager::new(
            db.clone(),
            Arc::clone(&transport),
            config.node_name.clone(),
        ));
        let join_mgr = Arc::new(JoinManager::new(
            db.clone(),
            Arc::clone(&transport),
            config.node_name.clone(),
            &config.join_secret,
        ));

        MeshNode {
            node_name: config.node_name.clone(),
            config,
            transport,
            sync_mgr,
            join_mgr,
            db,
            hub,
            peers: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Start the mesh node.
    ///
    /// Connects to initial peers from configuration, starts background reconnect
    /// and ping loops, and sets up the federation event handler.
    pub async fn start(self: &Arc<Self>) -> Result<(), String> {
        tracing::info!(
            node = %self.node_name,
            peers = ?self.config.peers,
            "starting federation mesh node"
        );

        // Wire up the event handler on the transport.
        let mesh = Arc::clone(self);
        self.transport
            .set_on_event(Arc::new(move |peer_addr, event| {
                let mesh = Arc::clone(&mesh);
                tokio::spawn(async move {
                    if let Err(e) = mesh.handle_federation_event(&peer_addr, event).await {
                        tracing::error!(
                            peer = %peer_addr,
                            "error handling federation event: {}",
                            e
                        );
                    }
                });
            }))
            .await;

        // Connect to initial peers.
        for peer_addr in &self.config.peers {
            if peer_addr.is_empty() {
                continue;
            }
            match self.transport.connect_to_peer(peer_addr).await {
                Ok(()) => {
                    let mut peers = self.peers.write().await;
                    peers.insert(
                        peer_addr.clone(),
                        PeerInfo {
                            address: peer_addr.clone(),
                            status: "connected".to_string(),
                            node_name: String::new(),
                            last_seen: db::now_str(),
                        },
                    );
                    tracing::info!(peer = %peer_addr, "connected to initial peer");
                }
                Err(e) => {
                    let mut peers = self.peers.write().await;
                    peers.insert(
                        peer_addr.clone(),
                        PeerInfo {
                            address: peer_addr.clone(),
                            status: "disconnected".to_string(),
                            node_name: String::new(),
                            last_seen: String::new(),
                        },
                    );
                    tracing::warn!(peer = %peer_addr, "failed to connect to initial peer: {}", e);
                }
            }
        }

        // Start background loops.
        self.transport.start_reconnect_loop();
        self.transport.start_ping_loop();

        tracing::info!(node = %self.node_name, "federation mesh started");
        Ok(())
    }

    /// Graceful shutdown — closes all peer connections.
    pub async fn stop(&self) {
        tracing::info!(node = %self.node_name, "stopping federation mesh");
        self.transport.stop().await;
        tracing::info!("federation mesh stopped");
    }

    /// Get the list of all known peers and their statuses.
    pub async fn get_peers(&self) -> Vec<PeerInfo> {
        let statuses = self.transport.peer_statuses().await;
        let mut peers = self.peers.write().await;

        // Update statuses from transport.
        for (addr, connected) in &statuses {
            if let Some(peer) = peers.get_mut(addr) {
                peer.status = if *connected {
                    "connected".to_string()
                } else {
                    "disconnected".to_string()
                };
                if *connected {
                    peer.last_seen = db::now_str();
                }
            }
        }

        peers.values().cloned().collect()
    }

    /// Get a reference to the sync manager (for Lamport clock access).
    pub fn sync_manager(&self) -> &Arc<SyncManager> {
        &self.sync_mgr
    }

    /// Get a reference to the join manager.
    pub fn join_manager(&self) -> &Arc<JoinManager> {
        &self.join_mgr
    }

    // ── Broadcast helpers ──────────────────────────────────────────────────

    /// Generic helper: build a `FederationEvent` and broadcast it to all peers.
    async fn broadcast_event(&self, event_type: &str, payload: serde_json::Value) {
        let event = FederationEvent {
            event_type: event_type.to_string(),
            node_name: self.node_name.clone(),
            timestamp: self.sync_mgr.tick(),
            payload,
        };
        self.transport.broadcast(&event).await;
    }

    /// Broadcast a new message to all federation peers.
    pub async fn broadcast_message(&self, msg: &ReplicationMessage) {
        let payload = match serde_json::to_value(msg) {
            Ok(p) => p,
            Err(e) => {
                tracing::error!("failed to serialize replication message: {}", e);
                return;
            }
        };
        self.broadcast_event(FED_EVENT_MESSAGE_NEW, payload).await;
    }

    /// Broadcast a message edit to all federation peers.
    pub async fn broadcast_message_edit(
        &self,
        message_id: &str,
        channel_id: &str,
        content: &str,
    ) {
        self.broadcast_event(
            FED_EVENT_MESSAGE_EDIT,
            json!({
                "message_id": message_id,
                "channel_id": channel_id,
                "content": content,
            }),
        )
        .await;
    }

    /// Broadcast a message deletion to all federation peers.
    pub async fn broadcast_message_delete(&self, message_id: &str, channel_id: &str) {
        self.broadcast_event(
            FED_EVENT_MESSAGE_DELETE,
            json!({
                "message_id": message_id,
                "channel_id": channel_id,
            }),
        )
        .await;
    }

    /// Broadcast a presence change to all federation peers.
    pub async fn broadcast_presence_changed(
        &self,
        user_id: &str,
        status_type: &str,
        custom_status: &str,
    ) {
        self.broadcast_event(
            FED_EVENT_PRESENCE_CHANGED,
            json!({
                "user_id": user_id,
                "status_type": status_type,
                "custom_status": custom_status,
            }),
        )
        .await;
    }

    /// Broadcast that a user joined a voice channel to all federation peers.
    pub async fn broadcast_voice_user_joined(
        &self,
        channel_id: &str,
        user_id: &str,
        username: &str,
    ) {
        self.broadcast_event(
            FED_EVENT_VOICE_USER_JOINED,
            json!({
                "channel_id": channel_id,
                "user_id": user_id,
                "username": username,
            }),
        )
        .await;
    }

    /// Broadcast that a user left a voice channel to all federation peers.
    pub async fn broadcast_voice_user_left(&self, channel_id: &str, user_id: &str) {
        self.broadcast_event(
            FED_EVENT_VOICE_USER_LEFT,
            json!({
                "channel_id": channel_id,
                "user_id": user_id,
            }),
        )
        .await;
    }

    // ── Event dispatch ─────────────────────────────────────────────────────

    /// Dispatch an incoming federation event from a peer to the appropriate handler.
    async fn handle_federation_event(
        &self,
        peer_addr: &str,
        event: FederationEvent,
    ) -> Result<(), String> {
        // Update Lamport clock.
        self.sync_mgr.update(event.timestamp);

        // Update peer info.
        {
            let mut peers = self.peers.write().await;
            let peer = peers
                .entry(peer_addr.to_string())
                .or_insert_with(|| PeerInfo {
                    address: peer_addr.to_string(),
                    status: "connected".to_string(),
                    node_name: String::new(),
                    last_seen: String::new(),
                });
            peer.node_name = event.node_name.clone();
            peer.last_seen = db::now_str();
            peer.status = "connected".to_string();
        }

        match event.event_type.as_str() {
            FED_EVENT_MESSAGE_NEW => self.handle_message_new(event.payload).await,
            FED_EVENT_MESSAGE_EDIT => self.handle_message_edit(event.payload).await,
            FED_EVENT_MESSAGE_DELETE => self.handle_message_delete(event.payload).await,
            FED_EVENT_PRESENCE_CHANGED => self.handle_presence_changed(event.payload).await,
            FED_EVENT_VOICE_USER_JOINED => self.handle_voice_user_joined(event.payload).await,
            FED_EVENT_VOICE_USER_LEFT => self.handle_voice_user_left(event.payload).await,
            FED_EVENT_STATE_SYNC_REQ => {
                self.sync_mgr.handle_state_sync_request(peer_addr).await
            }
            FED_EVENT_STATE_SYNC_RESP => self.handle_state_sync_response(event.payload).await,
            FED_EVENT_MEMBER_JOINED => {
                tracing::info!(
                    peer = %peer_addr,
                    node = %event.node_name,
                    "peer node joined the mesh"
                );
                Ok(())
            }
            FED_EVENT_MEMBER_LEFT => {
                tracing::info!(
                    peer = %peer_addr,
                    node = %event.node_name,
                    "peer node left the mesh"
                );
                Ok(())
            }
            other => {
                tracing::warn!(
                    peer = %peer_addr,
                    event_type = %other,
                    "unknown federation event type"
                );
                Ok(())
            }
        }
    }

    // ── Event handlers ─────────────────────────────────────────────────────

    /// Handle a replicated new message: create in local DB and broadcast to local WS clients.
    async fn handle_message_new(&self, payload: serde_json::Value) -> Result<(), String> {
        let repl: ReplicationMessage = serde_json::from_value(payload)
            .map_err(|e| format!("parse replication message: {}", e))?;

        let db = self.db.clone();
        let msg = Message {
            id: repl.message_id.clone(),
            channel_id: repl.channel_id.clone(),
            dm_channel_id: String::new(),
            author_id: repl.author_id.clone(),
            content: repl.content.clone(),
            msg_type: repl.msg_type.clone(),
            thread_id: repl.thread_id.clone(),
            edited_at: None,
            deleted: false,
            lamport_ts: repl.lamport_ts as i64,
            created_at: repl.created_at.clone(),
        };

        let msg_clone = msg.clone();
        tokio::task::spawn_blocking(move || {
            db.with_conn(|conn| {
                // Only create if it doesn't already exist (idempotent).
                let existing = db::get_message_by_id(conn, &msg_clone.id)?;
                if existing.is_none() {
                    db::create_message(conn, &msg_clone)?;
                }
                Ok(())
            })
        })
        .await
        .map_err(|e| format!("task join: {}", e))?
        .map_err(|e: rusqlite::Error| format!("db: {}", e))?;

        // Broadcast to local WebSocket clients.
        let ws_event = crate::ws::events::Event::new(
            crate::ws::events::EVENT_MESSAGE_NEW,
            crate::ws::events::MessageNewPayload {
                id: repl.message_id,
                channel_id: repl.channel_id.clone(),
                author_id: repl.author_id,
                username: repl.username,
                content: repl.content,
                msg_type: repl.msg_type,
                thread_id: repl.thread_id,
                created_at: repl.created_at,
            },
        )
        .map_err(|e| format!("serialize ws event: {}", e))?;

        let data = ws_event
            .to_bytes()
            .map_err(|e| format!("serialize ws event bytes: {}", e))?;

        self.hub
            .broadcast_to_channel(&repl.channel_id, data, None)
            .await;

        Ok(())
    }

    /// Handle a replicated message edit: update in local DB and broadcast to local WS clients.
    async fn handle_message_edit(&self, payload: serde_json::Value) -> Result<(), String> {
        let message_id = payload["message_id"]
            .as_str()
            .ok_or("missing message_id")?
            .to_string();
        let channel_id = payload["channel_id"]
            .as_str()
            .ok_or("missing channel_id")?
            .to_string();
        let content = payload["content"]
            .as_str()
            .ok_or("missing content")?
            .to_string();

        let db = self.db.clone();
        let mid = message_id.clone();
        let c = content.clone();
        tokio::task::spawn_blocking(move || {
            db.with_conn(|conn| db::update_message_content(conn, &mid, &c))
        })
        .await
        .map_err(|e| format!("task join: {}", e))?
        .map_err(|e| format!("db: {}", e))?;

        // Broadcast to local WS clients.
        let ws_event = crate::ws::events::Event::new(
            crate::ws::events::EVENT_MESSAGE_UPDATED,
            json!({
                "message_id": message_id,
                "channel_id": channel_id,
                "content": content,
                "edited_at": db::now_str(),
            }),
        )
        .map_err(|e| format!("serialize ws event: {}", e))?;

        let data = ws_event
            .to_bytes()
            .map_err(|e| format!("serialize ws event bytes: {}", e))?;

        self.hub
            .broadcast_to_channel(&channel_id, data, None)
            .await;

        Ok(())
    }

    /// Handle a replicated message deletion: soft-delete in local DB and broadcast to local WS clients.
    async fn handle_message_delete(&self, payload: serde_json::Value) -> Result<(), String> {
        let message_id = payload["message_id"]
            .as_str()
            .ok_or("missing message_id")?
            .to_string();
        let channel_id = payload["channel_id"]
            .as_str()
            .ok_or("missing channel_id")?
            .to_string();

        let db = self.db.clone();
        let mid = message_id.clone();
        tokio::task::spawn_blocking(move || {
            db.with_conn(|conn| db::soft_delete_message(conn, &mid))
        })
        .await
        .map_err(|e| format!("task join: {}", e))?
        .map_err(|e| format!("db: {}", e))?;

        // Broadcast to local WS clients.
        let ws_event = crate::ws::events::Event::new(
            crate::ws::events::EVENT_MESSAGE_DELETED,
            json!({
                "message_id": message_id,
                "channel_id": channel_id,
            }),
        )
        .map_err(|e| format!("serialize ws event: {}", e))?;

        let data = ws_event
            .to_bytes()
            .map_err(|e| format!("serialize ws event bytes: {}", e))?;

        self.hub
            .broadcast_to_channel(&channel_id, data, None)
            .await;

        Ok(())
    }

    /// Handle a replicated presence change: broadcast to local WS clients.
    async fn handle_presence_changed(&self, payload: serde_json::Value) -> Result<(), String> {
        let user_id = payload["user_id"]
            .as_str()
            .ok_or("missing user_id")?
            .to_string();
        let status_type = payload["status_type"]
            .as_str()
            .ok_or("missing status_type")?
            .to_string();
        let custom_status = payload["custom_status"]
            .as_str()
            .unwrap_or("")
            .to_string();

        // Update in local DB.
        let db = self.db.clone();
        let uid = user_id.clone();
        let st = status_type.clone();
        let cs = custom_status.clone();
        tokio::task::spawn_blocking(move || {
            db.with_conn(|conn| db::update_user_status(conn, &uid, &st, &cs))
        })
        .await
        .map_err(|e| format!("task join: {}", e))?
        .map_err(|e| format!("db: {}", e))?;

        // Broadcast to local WS clients.
        let ws_event = crate::ws::events::Event::new(
            crate::ws::events::EVENT_PRESENCE_CHANGED,
            crate::ws::events::PresenceUpdatePayload {
                user_id,
                status_type,
                status_text: custom_status,
            },
        )
        .map_err(|e| format!("serialize ws event: {}", e))?;

        let data = ws_event
            .to_bytes()
            .map_err(|e| format!("serialize ws event bytes: {}", e))?;

        self.hub.broadcast_to_all(data).await;

        Ok(())
    }

    /// Handle a replicated voice user join: broadcast to local WS clients.
    async fn handle_voice_user_joined(&self, payload: serde_json::Value) -> Result<(), String> {
        let channel_id = payload["channel_id"]
            .as_str()
            .ok_or("missing channel_id")?
            .to_string();
        let user_id = payload["user_id"]
            .as_str()
            .ok_or("missing user_id")?
            .to_string();
        let username = payload["username"]
            .as_str()
            .unwrap_or("")
            .to_string();

        let ws_event = crate::ws::events::Event::new(
            crate::ws::events::EVENT_VOICE_USER_JOINED,
            crate::ws::events::VoiceUserJoinedPayload {
                channel_id: channel_id.clone(),
                user_id,
                username,
            },
        )
        .map_err(|e| format!("serialize ws event: {}", e))?;

        let data = ws_event
            .to_bytes()
            .map_err(|e| format!("serialize ws event bytes: {}", e))?;

        self.hub
            .broadcast_to_channel(&channel_id, data, None)
            .await;

        Ok(())
    }

    /// Handle a replicated voice user leave: broadcast to local WS clients.
    async fn handle_voice_user_left(&self, payload: serde_json::Value) -> Result<(), String> {
        let channel_id = payload["channel_id"]
            .as_str()
            .ok_or("missing channel_id")?
            .to_string();
        let user_id = payload["user_id"]
            .as_str()
            .ok_or("missing user_id")?
            .to_string();

        let ws_event = crate::ws::events::Event::new(
            crate::ws::events::EVENT_VOICE_USER_LEFT,
            crate::ws::events::VoiceUserLeftPayload {
                channel_id: channel_id.clone(),
                user_id,
            },
        )
        .map_err(|e| format!("serialize ws event: {}", e))?;

        let data = ws_event
            .to_bytes()
            .map_err(|e| format!("serialize ws event bytes: {}", e))?;

        self.hub
            .broadcast_to_channel(&channel_id, data, None)
            .await;

        Ok(())
    }

    /// Handle a state sync response by delegating to the SyncManager.
    async fn handle_state_sync_response(
        &self,
        payload: serde_json::Value,
    ) -> Result<(), String> {
        let data: StateSyncData = serde_json::from_value(payload)
            .map_err(|e| format!("parse state sync data: {}", e))?;

        self.sync_mgr.handle_state_sync_response(data).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Event type constants ─────────────────────────────────────────

    #[test]
    fn event_type_constants_are_correct() {
        assert_eq!(FED_EVENT_MESSAGE_NEW, "message:new");
        assert_eq!(FED_EVENT_MESSAGE_EDIT, "message:edit");
        assert_eq!(FED_EVENT_MESSAGE_DELETE, "message:delete");
        assert_eq!(FED_EVENT_PRESENCE_CHANGED, "presence:changed");
        assert_eq!(FED_EVENT_VOICE_USER_JOINED, "voice:user:joined");
        assert_eq!(FED_EVENT_VOICE_USER_LEFT, "voice:user:left");
        assert_eq!(FED_EVENT_STATE_SYNC_REQ, "state:sync:req");
        assert_eq!(FED_EVENT_STATE_SYNC_RESP, "state:sync:resp");
        assert_eq!(FED_EVENT_MEMBER_JOINED, "member:joined");
        assert_eq!(FED_EVENT_MEMBER_LEFT, "member:left");
    }

    // ── FederationEvent serialization ────────────────────────────────

    #[test]
    fn federation_event_serializes_correctly() {
        let event = FederationEvent {
            event_type: FED_EVENT_MESSAGE_NEW.to_string(),
            node_name: "node-1".into(),
            timestamp: 42,
            payload: serde_json::json!({"message_id": "m1"}),
        };

        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "message:new"); // Renamed via serde
        assert_eq!(json["node_name"], "node-1");
        assert_eq!(json["timestamp"], 42);
        assert_eq!(json["payload"]["message_id"], "m1");
    }

    #[test]
    fn federation_event_deserializes_correctly() {
        let json_str = r#"{
            "type": "message:edit",
            "node_name": "node-2",
            "timestamp": 99,
            "payload": {"content": "updated"}
        }"#;

        let event: FederationEvent = serde_json::from_str(json_str).unwrap();
        assert_eq!(event.event_type, "message:edit");
        assert_eq!(event.node_name, "node-2");
        assert_eq!(event.timestamp, 99);
        assert_eq!(event.payload["content"], "updated");
    }

    #[test]
    fn federation_event_roundtrip() {
        let event = FederationEvent {
            event_type: FED_EVENT_PRESENCE_CHANGED.to_string(),
            node_name: "test".into(),
            timestamp: 1000,
            payload: serde_json::json!({"user_id": "u1", "status_type": "online"}),
        };

        let serialized = serde_json::to_string(&event).unwrap();
        let deserialized: FederationEvent = serde_json::from_str(&serialized).unwrap();

        assert_eq!(deserialized.event_type, event.event_type);
        assert_eq!(deserialized.node_name, event.node_name);
        assert_eq!(deserialized.timestamp, event.timestamp);
        assert_eq!(deserialized.payload, event.payload);
    }

    #[test]
    fn federation_event_with_null_payload() {
        let event = FederationEvent {
            event_type: FED_EVENT_STATE_SYNC_REQ.to_string(),
            node_name: "node".into(),
            timestamp: 0,
            payload: serde_json::Value::Null,
        };

        let json = serde_json::to_string(&event).unwrap();
        let parsed: FederationEvent = serde_json::from_str(&json).unwrap();
        assert!(parsed.payload.is_null());
    }

    // ── ReplicationMessage serialization ─────────────────────────────

    #[test]
    fn replication_message_serializes() {
        let msg = ReplicationMessage {
            message_id: "m1".into(),
            channel_id: "ch1".into(),
            author_id: "u1".into(),
            username: "alice".into(),
            content: "hello".into(),
            msg_type: "text".into(),
            thread_id: String::new(),
            lamport_ts: 5,
            created_at: "2024-01-01 00:00:00".into(),
        };

        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["message_id"], "m1");
        assert_eq!(json["channel_id"], "ch1");
        assert_eq!(json["author_id"], "u1");
        assert_eq!(json["username"], "alice");
        assert_eq!(json["content"], "hello");
        assert_eq!(json["type"], "text"); // Renamed via serde
        assert_eq!(json["lamport_ts"], 5);
    }

    #[test]
    fn replication_message_deserializes_with_defaults() {
        let json_str = r#"{
            "message_id": "m2",
            "channel_id": "ch2",
            "author_id": "u2",
            "username": "bob",
            "content": "hi",
            "type": "text",
            "lamport_ts": 10,
            "created_at": "2024-01-01"
        }"#;

        let msg: ReplicationMessage = serde_json::from_str(json_str).unwrap();
        assert_eq!(msg.message_id, "m2");
        assert_eq!(msg.thread_id, ""); // Default
    }

    // ── PeerInfo serialization ───────────────────────────────────────

    #[test]
    fn peer_info_serializes() {
        let peer = PeerInfo {
            address: "ws://192.168.1.10:8081".into(),
            status: "connected".into(),
            node_name: "node-1".into(),
            last_seen: "2024-01-01 12:00:00".into(),
        };

        let json = serde_json::to_value(&peer).unwrap();
        assert_eq!(json["address"], "ws://192.168.1.10:8081");
        assert_eq!(json["status"], "connected");
        assert_eq!(json["node_name"], "node-1");
    }

    #[test]
    fn peer_info_clone() {
        let peer = PeerInfo {
            address: "ws://a:8081".into(),
            status: "connected".into(),
            node_name: "n1".into(),
            last_seen: "now".into(),
        };
        let cloned = peer.clone();
        assert_eq!(peer.address, cloned.address);
        assert_eq!(peer.status, cloned.status);
    }

    // ── MeshConfig construction ──────────────────────────────────────

    #[test]
    fn mesh_config_construction() {
        let config = MeshConfig {
            node_name: "my-node".into(),
            bind_addr: "0.0.0.0".into(),
            bind_port: 8081,
            advertise_addr: "192.168.1.10".into(),
            advertise_port: 8081,
            peers: vec!["ws://peer1:8081".into(), "ws://peer2:8081".into()],
            tls_cert: String::new(),
            tls_key: String::new(),
            join_secret: "secret".into(),
        };

        assert_eq!(config.node_name, "my-node");
        assert_eq!(config.bind_port, 8081);
        assert_eq!(config.peers.len(), 2);
        assert_eq!(config.join_secret, "secret");
    }

    #[test]
    fn mesh_config_clone() {
        let config = MeshConfig {
            node_name: "n1".into(),
            bind_addr: "0.0.0.0".into(),
            bind_port: 8081,
            advertise_addr: String::new(),
            advertise_port: 0,
            peers: vec![],
            tls_cert: String::new(),
            tls_key: String::new(),
            join_secret: String::new(),
        };
        let cloned = config.clone();
        assert_eq!(config.node_name, cloned.node_name);
    }

    #[test]
    fn mesh_config_with_empty_peers() {
        let config = MeshConfig {
            node_name: "solo".into(),
            bind_addr: "0.0.0.0".into(),
            bind_port: 8080,
            advertise_addr: String::new(),
            advertise_port: 0,
            peers: vec![],
            tls_cert: String::new(),
            tls_key: String::new(),
            join_secret: String::new(),
        };
        assert!(config.peers.is_empty());
    }

    // ── MeshNode construction ────────────────────────────────────────

    #[test]
    fn mesh_node_construction() {
        let db = {
            let tmp = tempfile::tempdir().unwrap();
            let db = db::Database::open(tmp.path().to_str().unwrap(), "").unwrap();
            db.run_migrations().unwrap();
            db
        };
        let hub = Arc::new(crate::ws::Hub::new(db.clone()));

        let config = MeshConfig {
            node_name: "test-node".into(),
            bind_addr: "0.0.0.0".into(),
            bind_port: 8081,
            advertise_addr: String::new(),
            advertise_port: 0,
            peers: vec![],
            tls_cert: String::new(),
            tls_key: String::new(),
            join_secret: "secret".into(),
        };

        let node = MeshNode::new(config, db, hub);
        assert_eq!(node.node_name, "test-node");
    }

    #[test]
    fn mesh_node_sync_and_join_managers_accessible() {
        let db = {
            let tmp = tempfile::tempdir().unwrap();
            let db = db::Database::open(tmp.path().to_str().unwrap(), "").unwrap();
            db.run_migrations().unwrap();
            db
        };
        let hub = Arc::new(crate::ws::Hub::new(db.clone()));

        let config = MeshConfig {
            node_name: "node".into(),
            bind_addr: "0.0.0.0".into(),
            bind_port: 8081,
            advertise_addr: String::new(),
            advertise_port: 0,
            peers: vec![],
            tls_cert: String::new(),
            tls_key: String::new(),
            join_secret: "s".into(),
        };

        let node = MeshNode::new(config, db, hub);

        // Verify we can access the sync and join managers.
        assert_eq!(node.sync_manager().current(), 0);
        assert_eq!(node.sync_manager().tick(), 1);
    }
}
