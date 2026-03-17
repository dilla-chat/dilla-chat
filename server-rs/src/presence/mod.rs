use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Online,
    Idle,
    Dnd,
    Offline,
}

impl Status {
    pub fn as_str(&self) -> &'static str {
        match self {
            Status::Online => "online",
            Status::Idle => "idle",
            Status::Dnd => "dnd",
            Status::Offline => "offline",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "idle" => Status::Idle,
            "dnd" | "do_not_disturb" => Status::Dnd,
            "offline" => Status::Offline,
            _ => Status::Online,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct UserPresence {
    pub user_id: String,
    pub status: Status,
    pub custom_status: String,
    #[serde(skip)]
    pub last_activity: Instant,
}

pub struct PresenceManager {
    presences: Arc<RwLock<HashMap<String, UserPresence>>>,
    stop_tx: Option<tokio::sync::mpsc::Sender<()>>,
    pub on_broadcast:
        RwLock<Option<Box<dyn Fn(&str, &str, &str) + Send + Sync>>>,
    pub on_federation:
        RwLock<Option<Box<dyn Fn(&str, &str, &str) + Send + Sync>>>,
}

impl PresenceManager {
    pub fn new() -> Self {
        PresenceManager {
            presences: Arc::new(RwLock::new(HashMap::new())),
            stop_tx: None,
            on_broadcast: RwLock::new(None),
            on_federation: RwLock::new(None),
        }
    }

    pub async fn set_online(&self, user_id: &str) {
        let mut map = self.presences.write().await;
        let entry = map.entry(user_id.to_string()).or_insert_with(|| UserPresence {
            user_id: user_id.to_string(),
            status: Status::Online,
            custom_status: String::new(),
            last_activity: Instant::now(),
        });
        if entry.status == Status::Offline || entry.status == Status::Idle {
            entry.status = Status::Online;
        }
        entry.last_activity = Instant::now();

        let status = entry.status.as_str().to_string();
        let custom = entry.custom_status.clone();
        drop(map);

        self.broadcast(user_id, &status, &custom).await;
    }

    pub async fn set_offline(&self, user_id: &str) {
        let mut map = self.presences.write().await;
        if let Some(entry) = map.get_mut(user_id) {
            entry.status = Status::Offline;
        }
        drop(map);

        self.broadcast(user_id, "offline", "").await;
    }

    pub async fn update_presence(&self, user_id: &str, status: Status, custom_status: &str) {
        let mut map = self.presences.write().await;
        let entry = map.entry(user_id.to_string()).or_insert_with(|| UserPresence {
            user_id: user_id.to_string(),
            status,
            custom_status: custom_status.to_string(),
            last_activity: Instant::now(),
        });
        entry.status = status;
        entry.custom_status = custom_status.to_string();
        entry.last_activity = Instant::now();

        let s = entry.status.as_str().to_string();
        let c = entry.custom_status.clone();
        drop(map);

        self.broadcast(user_id, &s, &c).await;
        self.federate(user_id, &s, &c).await;
    }

    pub async fn update_activity(&self, user_id: &str) {
        let mut map = self.presences.write().await;
        if let Some(entry) = map.get_mut(user_id) {
            entry.last_activity = Instant::now();
            if entry.status == Status::Idle {
                entry.status = Status::Online;
                let s = entry.status.as_str().to_string();
                let c = entry.custom_status.clone();
                drop(map);
                self.broadcast(user_id, &s, &c).await;
                return;
            }
        }
    }

    pub async fn get_presence(&self, user_id: &str) -> Option<UserPresence> {
        self.presences.read().await.get(user_id).cloned()
    }

    pub async fn get_all_presences(&self) -> Vec<UserPresence> {
        self.presences.read().await.values().cloned().collect()
    }

    pub async fn handle_federated_presence(
        &self,
        user_id: &str,
        status_type: &str,
        custom_status: &str,
    ) {
        let status = Status::from_str(status_type);
        let mut map = self.presences.write().await;
        let entry = map.entry(user_id.to_string()).or_insert_with(|| UserPresence {
            user_id: user_id.to_string(),
            status,
            custom_status: custom_status.to_string(),
            last_activity: Instant::now(),
        });
        entry.status = status;
        entry.custom_status = custom_status.to_string();
        drop(map);

        self.broadcast(user_id, status_type, custom_status).await;
    }

    pub fn start_idle_checker(&mut self, interval: Duration) {
        let presences = self.presences.clone();
        let (stop_tx, mut stop_rx) = tokio::sync::mpsc::channel(1);
        self.stop_tx = Some(stop_tx);

        tokio::spawn(async move {
            let mut tick = tokio::time::interval(interval);
            loop {
                tokio::select! {
                    _ = tick.tick() => {
                        let mut map = presences.write().await;
                        let idle_threshold = Duration::from_secs(300); // 5 minutes
                        let mut to_idle = Vec::new();
                        for (uid, presence) in map.iter_mut() {
                            if presence.status == Status::Online
                                && presence.last_activity.elapsed() > idle_threshold
                            {
                                presence.status = Status::Idle;
                                to_idle.push(uid.clone());
                            }
                        }
                        drop(map);
                        // Note: can't call self.broadcast here, but changes are visible.
                    }
                    _ = stop_rx.recv() => {
                        break;
                    }
                }
            }
        });
    }

    pub fn stop(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.try_send(());
        }
    }

    async fn broadcast(&self, user_id: &str, status: &str, custom: &str) {
        if let Some(cb) = self.on_broadcast.read().await.as_ref() {
            cb(user_id, status, custom);
        }
    }

    async fn federate(&self, user_id: &str, status: &str, custom: &str) {
        if let Some(cb) = self.on_federation.read().await.as_ref() {
            cb(user_id, status, custom);
        }
    }
}
