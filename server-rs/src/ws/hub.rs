use super::events::Event;
use crate::db::Database;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};

pub type ClientSender = mpsc::UnboundedSender<Vec<u8>>;

#[derive(Debug)]
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

pub struct Hub {
    pub db: Database,
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

    // Callbacks (set by main).
    pub on_message_send:
        RwLock<Option<Box<dyn Fn(&crate::db::Message, &str) + Send + Sync>>>,
    pub on_message_edit:
        RwLock<Option<Box<dyn Fn(&str, &str, &str) + Send + Sync>>>,
    pub on_message_delete:
        RwLock<Option<Box<dyn Fn(&str, &str) + Send + Sync>>>,
    pub on_client_connect: RwLock<Option<Box<dyn Fn(&str) + Send + Sync>>>,
    pub on_client_disconnect: RwLock<Option<Box<dyn Fn(&str) + Send + Sync>>>,
    pub on_client_activity: RwLock<Option<Box<dyn Fn(&str) + Send + Sync>>>,
    pub on_presence_update:
        RwLock<Option<Box<dyn Fn(&str, &str, &str) + Send + Sync>>>,
    pub on_voice_join:
        RwLock<Option<Box<dyn Fn(&str, &str, &str) + Send + Sync>>>,
    pub on_voice_leave: RwLock<Option<Box<dyn Fn(&str, &str) + Send + Sync>>>,
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

        Hub {
            db,
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
            on_message_send: RwLock::new(None),
            on_message_edit: RwLock::new(None),
            on_message_delete: RwLock::new(None),
            on_client_connect: RwLock::new(None),
            on_client_disconnect: RwLock::new(None),
            on_client_activity: RwLock::new(None),
            on_presence_update: RwLock::new(None),
            on_voice_join: RwLock::new(None),
            on_voice_leave: RwLock::new(None),
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

                    if let Some(cb) = self.on_client_connect.read().await.as_ref() {
                        cb(&user_id);
                    }
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
                                if let Some(cb) = self.on_client_disconnect.read().await.as_ref() {
                                    cb(&user_id);
                                }
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
}
