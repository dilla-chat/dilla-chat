use crate::db::Database;
use crate::voice::RoomManager;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, RwLock};

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum HubEvent {
    ClientConnected { user_id: String },
    ClientDisconnected { user_id: String },
    ClientActivity { user_id: String },
    PresenceUpdate { user_id: String, status: String, custom_status: String },
    MessageSent { message: crate::db::Message, team_id: String },
    MessageEdited { message_id: String, channel_id: String, content: String },
    MessageDeleted { message_id: String, channel_id: String },
    VoiceJoined { channel_id: String, user_id: String, team_id: String },
    VoiceLeft { channel_id: String, user_id: String },
}

pub type ClientSender = mpsc::UnboundedSender<Vec<u8>>;

#[derive(Debug)]
#[allow(dead_code)]
pub struct ClientHandle {
    pub id: String,
    pub user_id: String,
    pub username: String,
    pub team_id: String,
    pub sender: ClientSender,
}

pub struct Subscription {
    pub client_id: String,
    pub channel_id: String,
}

pub struct ChannelMessage {
    pub channel_id: String,
    pub data: Vec<u8>,
    pub exclude_client_id: Option<String>,
}

pub struct DirectMessage {
    pub user_id: String,
    pub data: Vec<u8>,
}

/// Trait for the Voice SFU, so client.rs can call SFU methods without depending
/// on the full webrtc implementation at compile time.
#[async_trait::async_trait]
pub trait VoiceSFU: Send + Sync {
    async fn handle_join(&self, channel_id: &str, user_id: &str) -> Result<String, String>;
    async fn handle_leave(&self, channel_id: &str, user_id: &str);
    async fn handle_answer(&self, channel_id: &str, user_id: &str, sdp: &str) -> Result<(), String>;
    async fn handle_ice_candidate(&self, channel_id: &str, user_id: &str, candidate: &str, sdp_mid: &str, sdp_mline_index: u16) -> Result<(), String>;
    async fn add_screen_track(&self, channel_id: &str, user_id: &str) -> Result<(), String>;
    async fn remove_screen_track(&self, channel_id: &str, user_id: &str) -> Result<(), String>;
    async fn add_webcam_track(&self, channel_id: &str, user_id: &str) -> Result<(), String>;
    async fn remove_webcam_track(&self, channel_id: &str, user_id: &str) -> Result<(), String>;
    async fn renegotiate_all(&self, channel_id: &str);
}

pub struct Hub {
    pub db: Database,
    pub voice_room_manager: Option<Arc<RoomManager>>,
    pub voice_sfu: Option<Arc<dyn VoiceSFU>>,
    pub telemetry_relay: Option<Arc<crate::telemetry::TelemetryRelay>>,
    clients: Arc<RwLock<HashMap<String, ClientHandle>>>,
    channels: Arc<RwLock<HashMap<String, HashSet<String>>>>,
    user_index: Arc<RwLock<HashMap<String, Vec<String>>>>,
    typing_throttle: Arc<RwLock<HashMap<String, i64>>>,

    register_tx: mpsc::Sender<ClientHandle>,
    register_rx: tokio::sync::Mutex<mpsc::Receiver<ClientHandle>>,
    unregister_tx: mpsc::Sender<String>,
    unregister_rx: tokio::sync::Mutex<mpsc::Receiver<String>>,
    subscribe_tx: mpsc::Sender<Subscription>,
    subscribe_rx: tokio::sync::Mutex<mpsc::Receiver<Subscription>>,
    unsubscribe_tx: mpsc::Sender<Subscription>,
    unsubscribe_rx: tokio::sync::Mutex<mpsc::Receiver<Subscription>>,
    broadcast_tx: mpsc::Sender<ChannelMessage>,
    broadcast_rx: tokio::sync::Mutex<mpsc::Receiver<ChannelMessage>>,
    direct_tx: mpsc::Sender<DirectMessage>,
    direct_rx: tokio::sync::Mutex<mpsc::Receiver<DirectMessage>>,
    broadcast_all_tx: mpsc::Sender<Vec<u8>>,
    broadcast_all_rx: tokio::sync::Mutex<mpsc::Receiver<Vec<u8>>>,

    event_tx: broadcast::Sender<HubEvent>,
}

impl Hub {
    pub fn new(db: Database) -> Self {
        let (register_tx, register_rx) = mpsc::channel(256);
        let (unregister_tx, unregister_rx) = mpsc::channel(256);
        let (subscribe_tx, subscribe_rx) = mpsc::channel(256);
        let (unsubscribe_tx, unsubscribe_rx) = mpsc::channel(256);
        let (broadcast_tx, broadcast_rx) = mpsc::channel(256);
        let (direct_tx, direct_rx) = mpsc::channel(256);
        let (broadcast_all_tx, broadcast_all_rx) = mpsc::channel(256);
        let (event_tx, _) = broadcast::channel(256);

        Hub {
            db,
            voice_room_manager: None,
            voice_sfu: None,
            telemetry_relay: None,
            clients: Arc::new(RwLock::new(HashMap::new())),
            channels: Arc::new(RwLock::new(HashMap::new())),
            user_index: Arc::new(RwLock::new(HashMap::new())),
            typing_throttle: Arc::new(RwLock::new(HashMap::new())),
            register_tx,
            register_rx: tokio::sync::Mutex::new(register_rx),
            unregister_tx,
            unregister_rx: tokio::sync::Mutex::new(unregister_rx),
            subscribe_tx,
            subscribe_rx: tokio::sync::Mutex::new(subscribe_rx),
            unsubscribe_tx,
            unsubscribe_rx: tokio::sync::Mutex::new(unsubscribe_rx),
            broadcast_tx,
            broadcast_rx: tokio::sync::Mutex::new(broadcast_rx),
            direct_tx,
            direct_rx: tokio::sync::Mutex::new(direct_rx),
            broadcast_all_tx,
            broadcast_all_rx: tokio::sync::Mutex::new(broadcast_all_rx),
            event_tx,
        }
    }

    /// Run the hub dispatch loop. Call this in a spawned task.
    pub async fn run(&self) {
        let mut register_rx = self.register_rx.lock().await;
        let mut unregister_rx = self.unregister_rx.lock().await;
        let mut subscribe_rx = self.subscribe_rx.lock().await;
        let mut unsubscribe_rx = self.unsubscribe_rx.lock().await;
        let mut broadcast_rx = self.broadcast_rx.lock().await;
        let mut direct_rx = self.direct_rx.lock().await;
        let mut broadcast_all_rx = self.broadcast_all_rx.lock().await;

        loop {
            tokio::select! {
                Some(client) = register_rx.recv() => {
                    let user_id = client.user_id.clone();
                    let client_id = client.id.clone();
                    self.clients.write().await.insert(client_id.clone(), client);
                    self.user_index.write().await
                        .entry(user_id.clone())
                        .or_default()
                        .push(client_id);

                    self.emit_event(HubEvent::ClientConnected { user_id });
                }
                Some(client_id) = unregister_rx.recv() => {
                    let mut clients = self.clients.write().await;
                    if let Some(client) = clients.remove(&client_id) {
                        let user_id = client.user_id.clone();

                        // Remove from user index.
                        let mut idx = self.user_index.write().await;
                        if let Some(ids) = idx.get_mut(&user_id) {
                            ids.retain(|id| id != &client_id);
                            if ids.is_empty() {
                                idx.remove(&user_id);
                                // Last connection for this user — notify disconnect.
                                drop(idx);
                                drop(clients);
                                self.emit_event(HubEvent::ClientDisconnected { user_id });
                            }
                        }

                        // Remove from all channels.
                        let mut channels = self.channels.write().await;
                        for subscribers in channels.values_mut() {
                            subscribers.remove(&client_id);
                        }
                    }
                }
                Some(sub) = subscribe_rx.recv() => {
                    self.channels.write().await
                        .entry(sub.channel_id)
                        .or_default()
                        .insert(sub.client_id);
                }
                Some(sub) = unsubscribe_rx.recv() => {
                    let mut channels = self.channels.write().await;
                    if let Some(subscribers) = channels.get_mut(&sub.channel_id) {
                        subscribers.remove(&sub.client_id);
                    }
                }
                Some(msg) = broadcast_rx.recv() => {
                    let channels = self.channels.read().await;
                    if let Some(subscribers) = channels.get(&msg.channel_id) {
                        let clients = self.clients.read().await;
                        for client_id in subscribers {
                            if let Some(exclude) = &msg.exclude_client_id {
                                if client_id == exclude {
                                    continue;
                                }
                            }
                            if let Some(client) = clients.get(client_id) {
                                let _ = client.sender.send(msg.data.clone());
                            }
                        }
                    }
                }
                Some(msg) = direct_rx.recv() => {
                    let idx = self.user_index.read().await;
                    if let Some(client_ids) = idx.get(&msg.user_id) {
                        let clients = self.clients.read().await;
                        for cid in client_ids {
                            if let Some(client) = clients.get(cid) {
                                let _ = client.sender.send(msg.data.clone());
                            }
                        }
                    }
                }
                Some(data) = broadcast_all_rx.recv() => {
                    let clients = self.clients.read().await;
                    for client in clients.values() {
                        let _ = client.sender.send(data.clone());
                    }
                }
            }
        }
    }

    // ── Public API ──────────────────────────────────────────────────────────

    pub async fn register(&self, client: ClientHandle) {
        let _ = self.register_tx.send(client).await;
    }

    pub async fn unregister(&self, client_id: &str) {
        let _ = self.unregister_tx.send(client_id.to_string()).await;
    }

    pub async fn subscribe(&self, client_id: &str, channel_id: &str) {
        let _ = self
            .subscribe_tx
            .send(Subscription {
                client_id: client_id.to_string(),
                channel_id: channel_id.to_string(),
            })
            .await;
    }

    pub async fn unsubscribe(&self, client_id: &str, channel_id: &str) {
        let _ = self
            .unsubscribe_tx
            .send(Subscription {
                client_id: client_id.to_string(),
                channel_id: channel_id.to_string(),
            })
            .await;
    }

    pub async fn broadcast_to_channel(
        &self,
        channel_id: &str,
        data: Vec<u8>,
        exclude_client_id: Option<String>,
    ) {
        let _ = self
            .broadcast_tx
            .send(ChannelMessage {
                channel_id: channel_id.to_string(),
                data,
                exclude_client_id,
            })
            .await;
    }

    pub async fn send_to_user(&self, user_id: &str, data: Vec<u8>) {
        let _ = self
            .direct_tx
            .send(DirectMessage {
                user_id: user_id.to_string(),
                data,
            })
            .await;
    }

    pub async fn broadcast_to_all(&self, data: Vec<u8>) {
        let _ = self.broadcast_all_tx.send(data).await;
    }

    pub fn typing_throttle(&self) -> &Arc<RwLock<HashMap<String, i64>>> {
        &self.typing_throttle
    }

    pub fn emit_event(&self, event: HubEvent) {
        let _ = self.event_tx.send(event);
    }

    pub fn event_tx(&self) -> broadcast::Sender<HubEvent> {
        self.event_tx.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use std::sync::Arc;
    use tokio::sync::mpsc;
    use tokio::time::{timeout, Duration};

    /// Create a fresh Hub backed by a temporary SQLite database.
    fn test_hub() -> Arc<Hub> {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.run_migrations().unwrap();
        // Leak the tempdir so it isn't deleted while the hub is alive.
        std::mem::forget(tmp);
        Arc::new(Hub::new(db))
    }

    /// Spawn the hub dispatch loop and return the handle.
    fn spawn_hub(hub: &Arc<Hub>) -> tokio::task::JoinHandle<()> {
        let hub = Arc::clone(hub);
        tokio::spawn(async move { hub.run().await })
    }

    /// Create a ClientHandle with an unbounded sender, returning both the handle and the receiver.
    fn make_client(
        id: &str,
        user_id: &str,
        username: &str,
        team_id: &str,
    ) -> (ClientHandle, mpsc::UnboundedReceiver<Vec<u8>>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let handle = ClientHandle {
            id: id.to_string(),
            user_id: user_id.to_string(),
            username: username.to_string(),
            team_id: team_id.to_string(),
            sender: tx,
        };
        (handle, rx)
    }

    /// Small helper — give the hub loop time to process pending messages.
    async fn settle() {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // ── register ──────────────────────────────────────────────────────────

    #[tokio::test]
    async fn register_adds_client_to_clients_map() {
        let hub = test_hub();
        let _handle = spawn_hub(&hub);

        let (client, _rx) = make_client("c1", "u1", "alice", "t1");
        hub.register(client).await;
        settle().await;

        let clients = hub.clients.read().await;
        assert!(clients.contains_key("c1"), "client should be registered");
        assert_eq!(clients.get("c1").unwrap().user_id, "u1");
    }

    #[tokio::test]
    async fn register_adds_client_to_user_index() {
        let hub = test_hub();
        let _handle = spawn_hub(&hub);

        let (client, _rx) = make_client("c1", "u1", "alice", "t1");
        hub.register(client).await;
        settle().await;

        let idx = hub.user_index.read().await;
        let ids = idx.get("u1").expect("user_index should contain u1");
        assert!(ids.contains(&"c1".to_string()));
    }

    #[tokio::test]
    async fn register_multiple_clients_same_user() {
        let hub = test_hub();
        let _handle = spawn_hub(&hub);

        let (c1, _rx1) = make_client("c1", "u1", "alice", "t1");
        let (c2, _rx2) = make_client("c2", "u1", "alice", "t1");
        hub.register(c1).await;
        hub.register(c2).await;
        settle().await;

        let idx = hub.user_index.read().await;
        let ids = idx.get("u1").unwrap();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&"c1".to_string()));
        assert!(ids.contains(&"c2".to_string()));
    }

    // ── unregister ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn unregister_removes_client_from_clients_map() {
        let hub = test_hub();
        let _handle = spawn_hub(&hub);

        let (client, _rx) = make_client("c1", "u1", "alice", "t1");
        hub.register(client).await;
        settle().await;

        hub.unregister("c1").await;
        settle().await;

        let clients = hub.clients.read().await;
        assert!(!clients.contains_key("c1"), "client should be removed");
    }

    #[tokio::test]
    async fn unregister_removes_client_from_user_index() {
        let hub = test_hub();
        let _handle = spawn_hub(&hub);

        let (client, _rx) = make_client("c1", "u1", "alice", "t1");
        hub.register(client).await;
        settle().await;

        hub.unregister("c1").await;
        settle().await;

        let idx = hub.user_index.read().await;
        // Last client for user — entry should be fully removed.
        assert!(!idx.contains_key("u1"));
    }

    #[tokio::test]
    async fn unregister_one_of_two_clients_keeps_user_in_index() {
        let hub = test_hub();
        let _handle = spawn_hub(&hub);

        let (c1, _rx1) = make_client("c1", "u1", "alice", "t1");
        let (c2, _rx2) = make_client("c2", "u1", "alice", "t1");
        hub.register(c1).await;
        hub.register(c2).await;
        settle().await;

        hub.unregister("c1").await;
        settle().await;

        let idx = hub.user_index.read().await;
        let ids = idx.get("u1").expect("user should still be in index");
        assert_eq!(ids.len(), 1);
        assert!(ids.contains(&"c2".to_string()));
    }

    #[tokio::test]
    async fn unregister_removes_client_from_all_channels() {
        let hub = test_hub();
        let _handle = spawn_hub(&hub);

        let (client, _rx) = make_client("c1", "u1", "alice", "t1");
        hub.register(client).await;
        settle().await;

        hub.subscribe("c1", "chan-a").await;
        hub.subscribe("c1", "chan-b").await;
        settle().await;

        hub.unregister("c1").await;
        settle().await;

        let channels = hub.channels.read().await;
        for (_, subscribers) in channels.iter() {
            assert!(
                !subscribers.contains("c1"),
                "client should be removed from all channels"
            );
        }
    }

    // ── subscribe / unsubscribe ───────────────────────────────────────────

    #[tokio::test]
    async fn subscribe_adds_client_to_channel() {
        let hub = test_hub();
        let _handle = spawn_hub(&hub);

        let (client, _rx) = make_client("c1", "u1", "alice", "t1");
        hub.register(client).await;
        settle().await;

        hub.subscribe("c1", "chan-a").await;
        settle().await;

        let channels = hub.channels.read().await;
        let subs = channels.get("chan-a").expect("channel should exist");
        assert!(subs.contains("c1"));
    }

    #[tokio::test]
    async fn subscribe_multiple_clients_to_channel() {
        let hub = test_hub();
        let _handle = spawn_hub(&hub);

        let (c1, _rx1) = make_client("c1", "u1", "alice", "t1");
        let (c2, _rx2) = make_client("c2", "u2", "bob", "t1");
        hub.register(c1).await;
        hub.register(c2).await;
        settle().await;

        hub.subscribe("c1", "chan-a").await;
        hub.subscribe("c2", "chan-a").await;
        settle().await;

        let channels = hub.channels.read().await;
        let subs = channels.get("chan-a").unwrap();
        assert_eq!(subs.len(), 2);
    }

    #[tokio::test]
    async fn unsubscribe_removes_client_from_channel() {
        let hub = test_hub();
        let _handle = spawn_hub(&hub);

        let (client, _rx) = make_client("c1", "u1", "alice", "t1");
        hub.register(client).await;
        settle().await;

        hub.subscribe("c1", "chan-a").await;
        settle().await;

        hub.unsubscribe("c1", "chan-a").await;
        settle().await;

        let channels = hub.channels.read().await;
        if let Some(subs) = channels.get("chan-a") {
            assert!(!subs.contains("c1"), "client should be unsubscribed");
        }
    }

    #[tokio::test]
    async fn unsubscribe_nonexistent_channel_does_not_panic() {
        let hub = test_hub();
        let _handle = spawn_hub(&hub);

        // Should not panic even if the channel doesn't exist.
        hub.unsubscribe("c1", "no-such-channel").await;
        settle().await;
    }

    // ── broadcast_to_channel ──────────────────────────────────────────────

    #[tokio::test]
    async fn broadcast_to_channel_delivers_to_all_subscribers() {
        let hub = test_hub();
        let _handle = spawn_hub(&hub);

        let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
        let (c2, mut rx2) = make_client("c2", "u2", "bob", "t1");
        hub.register(c1).await;
        hub.register(c2).await;
        settle().await;

        hub.subscribe("c1", "chan-a").await;
        hub.subscribe("c2", "chan-a").await;
        settle().await;

        let payload = b"hello channel".to_vec();
        hub.broadcast_to_channel("chan-a", payload.clone(), None)
            .await;
        settle().await;

        let msg1 = timeout(Duration::from_millis(100), rx1.recv())
            .await
            .expect("should receive within timeout")
            .expect("channel should not be closed");
        let msg2 = timeout(Duration::from_millis(100), rx2.recv())
            .await
            .expect("should receive within timeout")
            .expect("channel should not be closed");

        assert_eq!(msg1, b"hello channel");
        assert_eq!(msg2, b"hello channel");
    }

    #[tokio::test]
    async fn broadcast_to_channel_excludes_specified_client() {
        let hub = test_hub();
        let _handle = spawn_hub(&hub);

        let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
        let (c2, mut rx2) = make_client("c2", "u2", "bob", "t1");
        hub.register(c1).await;
        hub.register(c2).await;
        settle().await;

        hub.subscribe("c1", "chan-a").await;
        hub.subscribe("c2", "chan-a").await;
        settle().await;

        hub.broadcast_to_channel(
            "chan-a",
            b"secret".to_vec(),
            Some("c1".to_string()),
        )
        .await;
        settle().await;

        // c2 should receive.
        let msg = timeout(Duration::from_millis(100), rx2.recv())
            .await
            .expect("c2 should receive")
            .expect("channel open");
        assert_eq!(msg, b"secret");

        // c1 should NOT receive.
        let result = timeout(Duration::from_millis(100), rx1.recv()).await;
        assert!(result.is_err(), "c1 should not receive the message (excluded)");
    }

    #[tokio::test]
    async fn broadcast_to_nonexistent_channel_does_not_panic() {
        let hub = test_hub();
        let _handle = spawn_hub(&hub);

        hub.broadcast_to_channel("ghost-channel", b"data".to_vec(), None)
            .await;
        settle().await;
        // No panic = pass.
    }

    #[tokio::test]
    async fn broadcast_skips_non_subscriber() {
        let hub = test_hub();
        let _handle = spawn_hub(&hub);

        let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
        let (c2, mut rx2) = make_client("c2", "u2", "bob", "t1");
        hub.register(c1).await;
        hub.register(c2).await;
        settle().await;

        // Only c1 subscribes.
        hub.subscribe("c1", "chan-a").await;
        settle().await;

        hub.broadcast_to_channel("chan-a", b"only-c1".to_vec(), None)
            .await;
        settle().await;

        let msg = timeout(Duration::from_millis(100), rx1.recv())
            .await
            .expect("c1 should receive")
            .unwrap();
        assert_eq!(msg, b"only-c1");

        // c2 should NOT receive anything.
        let result = timeout(Duration::from_millis(100), rx2.recv()).await;
        assert!(result.is_err(), "c2 is not subscribed, should not receive");
    }

    // ── send_to_user ──────────────────────────────────────────────────────

    #[tokio::test]
    async fn send_to_user_delivers_to_all_clients_of_that_user() {
        let hub = test_hub();
        let _handle = spawn_hub(&hub);

        let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
        let (c2, mut rx2) = make_client("c2", "u1", "alice", "t1");
        hub.register(c1).await;
        hub.register(c2).await;
        settle().await;

        hub.send_to_user("u1", b"dm-data".to_vec()).await;
        settle().await;

        let m1 = timeout(Duration::from_millis(100), rx1.recv())
            .await
            .unwrap()
            .unwrap();
        let m2 = timeout(Duration::from_millis(100), rx2.recv())
            .await
            .unwrap()
            .unwrap();

        assert_eq!(m1, b"dm-data");
        assert_eq!(m2, b"dm-data");
    }

    #[tokio::test]
    async fn send_to_user_does_not_deliver_to_other_users() {
        let hub = test_hub();
        let _handle = spawn_hub(&hub);

        let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
        let (c2, mut rx2) = make_client("c2", "u2", "bob", "t1");
        hub.register(c1).await;
        hub.register(c2).await;
        settle().await;

        hub.send_to_user("u1", b"private".to_vec()).await;
        settle().await;

        let m1 = timeout(Duration::from_millis(100), rx1.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(m1, b"private");

        let result = timeout(Duration::from_millis(100), rx2.recv()).await;
        assert!(result.is_err(), "u2 should not receive u1's direct message");
    }

    #[tokio::test]
    async fn send_to_nonexistent_user_does_not_panic() {
        let hub = test_hub();
        let _handle = spawn_hub(&hub);

        hub.send_to_user("no-such-user", b"hello".to_vec()).await;
        settle().await;
    }

    // ── broadcast_to_all ──────────────────────────────────────────────────

    #[tokio::test]
    async fn broadcast_to_all_delivers_to_every_client() {
        let hub = test_hub();
        let _handle = spawn_hub(&hub);

        let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
        let (c2, mut rx2) = make_client("c2", "u2", "bob", "t1");
        hub.register(c1).await;
        hub.register(c2).await;
        settle().await;

        hub.broadcast_to_all(b"global".to_vec()).await;
        settle().await;

        let m1 = timeout(Duration::from_millis(100), rx1.recv())
            .await
            .unwrap()
            .unwrap();
        let m2 = timeout(Duration::from_millis(100), rx2.recv())
            .await
            .unwrap()
            .unwrap();

        assert_eq!(m1, b"global");
        assert_eq!(m2, b"global");
    }

    // ── typing_throttle ───────────────────────────────────────────────────

    #[tokio::test]
    async fn typing_throttle_returns_shared_map() {
        let hub = test_hub();

        // Insert a value and verify it persists.
        {
            let mut throttle = hub.typing_throttle().write().await;
            throttle.insert("u1:chan-a".to_string(), 12345);
        }

        let throttle = hub.typing_throttle().read().await;
        assert_eq!(throttle.get("u1:chan-a"), Some(&12345));
    }

    // ── hub events ──────────────────────────────────────────────────────

    #[tokio::test]
    async fn client_connected_event_fires_on_register() {
        let hub = test_hub();
        let mut event_rx = hub.event_tx().subscribe();

        let _handle = spawn_hub(&hub);

        let (client, _rx) = make_client("c1", "u1", "alice", "t1");
        hub.register(client).await;
        settle().await;

        let evt = timeout(Duration::from_millis(100), event_rx.recv())
            .await
            .unwrap()
            .unwrap();
        match evt {
            super::HubEvent::ClientConnected { user_id } => assert_eq!(user_id, "u1"),
            other => panic!("expected ClientConnected, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn client_disconnected_event_fires_when_last_client_removed() {
        let hub = test_hub();
        let mut event_rx = hub.event_tx().subscribe();

        let _handle = spawn_hub(&hub);

        let (c1, _rx1) = make_client("c1", "u1", "alice", "t1");
        let (c2, _rx2) = make_client("c2", "u1", "alice", "t1");
        hub.register(c1).await;
        hub.register(c2).await;
        settle().await;

        // Drain connect events.
        let _ = timeout(Duration::from_millis(50), event_rx.recv()).await;
        let _ = timeout(Duration::from_millis(50), event_rx.recv()).await;

        // Remove first client — should NOT fire disconnect (user still has c2).
        hub.unregister("c1").await;
        settle().await;

        let result = timeout(Duration::from_millis(50), event_rx.recv()).await;
        assert!(result.is_err(), "disconnect should not fire while user has active connections");

        // Remove last client — SHOULD fire disconnect.
        hub.unregister("c2").await;
        settle().await;

        let evt = timeout(Duration::from_millis(100), event_rx.recv())
            .await
            .unwrap()
            .unwrap();
        match evt {
            super::HubEvent::ClientDisconnected { user_id } => assert_eq!(user_id, "u1"),
            other => panic!("expected ClientDisconnected, got {:?}", other),
        }
    }

    // ── subscribe after unregister ────────────────────────────────────────

    #[tokio::test]
    async fn subscribe_client_to_multiple_channels() {
        let hub = test_hub();
        let _handle = spawn_hub(&hub);

        let (client, _rx) = make_client("c1", "u1", "alice", "t1");
        hub.register(client).await;
        settle().await;

        hub.subscribe("c1", "chan-a").await;
        hub.subscribe("c1", "chan-b").await;
        hub.subscribe("c1", "chan-c").await;
        settle().await;

        let channels = hub.channels.read().await;
        assert!(channels.get("chan-a").unwrap().contains("c1"));
        assert!(channels.get("chan-b").unwrap().contains("c1"));
        assert!(channels.get("chan-c").unwrap().contains("c1"));
    }

    #[tokio::test]
    async fn idempotent_subscribe() {
        let hub = test_hub();
        let _handle = spawn_hub(&hub);

        let (client, _rx) = make_client("c1", "u1", "alice", "t1");
        hub.register(client).await;
        settle().await;

        hub.subscribe("c1", "chan-a").await;
        hub.subscribe("c1", "chan-a").await;
        settle().await;

        let channels = hub.channels.read().await;
        // HashSet ensures no duplicates.
        assert_eq!(channels.get("chan-a").unwrap().len(), 1);
    }

    // ── end-to-end scenario ───────────────────────────────────────────────

    #[tokio::test]
    async fn full_lifecycle_register_subscribe_broadcast_unsubscribe_unregister() {
        let hub = test_hub();
        let _handle = spawn_hub(&hub);

        let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
        let (c2, mut rx2) = make_client("c2", "u2", "bob", "t1");
        hub.register(c1).await;
        hub.register(c2).await;
        settle().await;

        // Both join a channel.
        hub.subscribe("c1", "general").await;
        hub.subscribe("c2", "general").await;
        settle().await;

        // Broadcast — both should receive.
        hub.broadcast_to_channel("general", b"msg1".to_vec(), None)
            .await;
        settle().await;
        assert_eq!(
            timeout(Duration::from_millis(100), rx1.recv()).await.unwrap().unwrap(),
            b"msg1"
        );
        assert_eq!(
            timeout(Duration::from_millis(100), rx2.recv()).await.unwrap().unwrap(),
            b"msg1"
        );

        // c1 leaves the channel.
        hub.unsubscribe("c1", "general").await;
        settle().await;

        // Broadcast again — only c2 should receive.
        hub.broadcast_to_channel("general", b"msg2".to_vec(), None)
            .await;
        settle().await;
        assert_eq!(
            timeout(Duration::from_millis(100), rx2.recv()).await.unwrap().unwrap(),
            b"msg2"
        );
        let result = timeout(Duration::from_millis(100), rx1.recv()).await;
        assert!(result.is_err(), "c1 unsubscribed, should not receive msg2");

        // Unregister c2 — should be removed from channel too.
        hub.unregister("c2").await;
        settle().await;

        let channels = hub.channels.read().await;
        if let Some(subs) = channels.get("general") {
            assert!(!subs.contains("c2"));
        }
    }
}
