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
    #[allow(dead_code)]
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

    #[allow(dead_code)]
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

    #[allow(dead_code)]
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    // --- Status unit tests ---

    #[test]
    fn status_as_str() {
        assert_eq!(Status::Online.as_str(), "online");
        assert_eq!(Status::Idle.as_str(), "idle");
        assert_eq!(Status::Dnd.as_str(), "dnd");
        assert_eq!(Status::Offline.as_str(), "offline");
    }

    #[test]
    fn status_from_str_known_values() {
        assert_eq!(Status::from_str("idle"), Status::Idle);
        assert_eq!(Status::from_str("dnd"), Status::Dnd);
        assert_eq!(Status::from_str("do_not_disturb"), Status::Dnd);
        assert_eq!(Status::from_str("offline"), Status::Offline);
        assert_eq!(Status::from_str("online"), Status::Online);
    }

    #[test]
    fn status_from_str_unknown_defaults_to_online() {
        assert_eq!(Status::from_str("unknown"), Status::Online);
        assert_eq!(Status::from_str(""), Status::Online);
        assert_eq!(Status::from_str("IDLE"), Status::Online); // case-sensitive
    }

    #[test]
    fn status_roundtrip() {
        for status in [Status::Online, Status::Idle, Status::Dnd, Status::Offline] {
            assert_eq!(Status::from_str(status.as_str()), status);
        }
    }

    #[test]
    fn status_serde_roundtrip() {
        for status in [Status::Online, Status::Idle, Status::Dnd, Status::Offline] {
            let json = serde_json::to_string(&status).unwrap();
            let back: Status = serde_json::from_str(&json).unwrap();
            assert_eq!(back, status);
        }
    }

    #[test]
    fn status_serde_lowercase() {
        let json = serde_json::to_string(&Status::Dnd).unwrap();
        assert_eq!(json, "\"dnd\"");
        let json = serde_json::to_string(&Status::Online).unwrap();
        assert_eq!(json, "\"online\"");
    }

    // --- PresenceManager tests ---

    #[tokio::test]
    async fn set_online_creates_entry() {
        let pm = PresenceManager::new();
        pm.set_online("user1").await;

        let p = pm.get_presence("user1").await.unwrap();
        assert_eq!(p.status, Status::Online);
        assert_eq!(p.user_id, "user1");
        assert!(p.custom_status.is_empty());
    }

    #[tokio::test]
    async fn get_presence_returns_none_for_unknown_user() {
        let pm = PresenceManager::new();
        assert!(pm.get_presence("nonexistent").await.is_none());
    }

    #[tokio::test]
    async fn set_offline_changes_status() {
        let pm = PresenceManager::new();
        pm.set_online("user1").await;
        pm.set_offline("user1").await;

        let p = pm.get_presence("user1").await.unwrap();
        assert_eq!(p.status, Status::Offline);
    }

    #[tokio::test]
    async fn set_offline_unknown_user_does_not_create_entry() {
        let pm = PresenceManager::new();
        pm.set_offline("ghost").await;
        assert!(pm.get_presence("ghost").await.is_none());
    }

    #[tokio::test]
    async fn set_online_transitions_from_offline() {
        let pm = PresenceManager::new();
        pm.set_online("user1").await;
        pm.set_offline("user1").await;
        assert_eq!(pm.get_presence("user1").await.unwrap().status, Status::Offline);

        pm.set_online("user1").await;
        assert_eq!(pm.get_presence("user1").await.unwrap().status, Status::Online);
    }

    #[tokio::test]
    async fn set_online_transitions_from_idle() {
        let pm = PresenceManager::new();
        pm.update_presence("user1", Status::Idle, "").await;
        assert_eq!(pm.get_presence("user1").await.unwrap().status, Status::Idle);

        pm.set_online("user1").await;
        assert_eq!(pm.get_presence("user1").await.unwrap().status, Status::Online);
    }

    #[tokio::test]
    async fn set_online_does_not_override_dnd() {
        let pm = PresenceManager::new();
        pm.update_presence("user1", Status::Dnd, "busy").await;
        pm.set_online("user1").await;
        // DND is neither Offline nor Idle, so set_online should not change it
        assert_eq!(pm.get_presence("user1").await.unwrap().status, Status::Dnd);
    }

    #[tokio::test]
    async fn update_presence_sets_status_and_custom() {
        let pm = PresenceManager::new();
        pm.update_presence("user1", Status::Dnd, "in a meeting").await;

        let p = pm.get_presence("user1").await.unwrap();
        assert_eq!(p.status, Status::Dnd);
        assert_eq!(p.custom_status, "in a meeting");
    }

    #[tokio::test]
    async fn update_presence_overwrites_previous() {
        let pm = PresenceManager::new();
        pm.update_presence("user1", Status::Online, "hello").await;
        pm.update_presence("user1", Status::Idle, "brb").await;

        let p = pm.get_presence("user1").await.unwrap();
        assert_eq!(p.status, Status::Idle);
        assert_eq!(p.custom_status, "brb");
    }

    #[tokio::test]
    async fn update_activity_transitions_idle_to_online() {
        let pm = PresenceManager::new();
        pm.update_presence("user1", Status::Idle, "").await;
        pm.update_activity("user1").await;

        assert_eq!(pm.get_presence("user1").await.unwrap().status, Status::Online);
    }

    #[tokio::test]
    async fn update_activity_keeps_online_as_online() {
        let pm = PresenceManager::new();
        pm.set_online("user1").await;
        pm.update_activity("user1").await;
        assert_eq!(pm.get_presence("user1").await.unwrap().status, Status::Online);
    }

    #[tokio::test]
    async fn update_activity_does_not_change_dnd() {
        let pm = PresenceManager::new();
        pm.update_presence("user1", Status::Dnd, "").await;
        pm.update_activity("user1").await;
        assert_eq!(pm.get_presence("user1").await.unwrap().status, Status::Dnd);
    }

    #[tokio::test]
    async fn update_activity_noop_for_unknown_user() {
        let pm = PresenceManager::new();
        // Should not panic
        pm.update_activity("ghost").await;
        assert!(pm.get_presence("ghost").await.is_none());
    }

    #[tokio::test]
    async fn get_all_presences_empty() {
        let pm = PresenceManager::new();
        assert!(pm.get_all_presences().await.is_empty());
    }

    #[tokio::test]
    async fn get_all_presences_multiple_users() {
        let pm = PresenceManager::new();
        pm.set_online("alice").await;
        pm.update_presence("bob", Status::Dnd, "coding").await;
        pm.update_presence("charlie", Status::Idle, "").await;

        let all = pm.get_all_presences().await;
        assert_eq!(all.len(), 3);

        let ids: Vec<String> = all.iter().map(|p| p.user_id.clone()).collect();
        assert!(ids.contains(&"alice".to_string()));
        assert!(ids.contains(&"bob".to_string()));
        assert!(ids.contains(&"charlie".to_string()));
    }

    #[tokio::test]
    async fn handle_federated_presence_creates_and_updates() {
        let pm = PresenceManager::new();
        pm.handle_federated_presence("remote_user", "dnd", "do not disturb me").await;

        let p = pm.get_presence("remote_user").await.unwrap();
        assert_eq!(p.status, Status::Dnd);
        assert_eq!(p.custom_status, "do not disturb me");

        // Update existing
        pm.handle_federated_presence("remote_user", "online", "").await;
        let p = pm.get_presence("remote_user").await.unwrap();
        assert_eq!(p.status, Status::Online);
        assert_eq!(p.custom_status, "");
    }

    #[tokio::test]
    async fn broadcast_callback_is_invoked() {
        let pm = PresenceManager::new();
        let count = Arc::new(AtomicU32::new(0));
        let count_clone = count.clone();

        *pm.on_broadcast.write().await = Some(Box::new(move |_user, _status, _custom| {
            count_clone.fetch_add(1, Ordering::SeqCst);
        }));

        pm.set_online("user1").await;
        pm.set_offline("user1").await;
        pm.update_presence("user1", Status::Dnd, "busy").await;

        // set_online, set_offline, update_presence each broadcast once
        assert_eq!(count.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn federation_callback_invoked_on_update_presence() {
        let pm = PresenceManager::new();
        let count = Arc::new(AtomicU32::new(0));
        let count_clone = count.clone();

        *pm.on_federation.write().await = Some(Box::new(move |_user, _status, _custom| {
            count_clone.fetch_add(1, Ordering::SeqCst);
        }));

        pm.update_presence("user1", Status::Online, "").await;
        assert_eq!(count.load(Ordering::SeqCst), 1);

        // set_online and set_offline do NOT call federate
        pm.set_online("user2").await;
        pm.set_offline("user2").await;
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn user_presence_serializes_to_json() {
        let pm = PresenceManager::new();
        pm.update_presence("user1", Status::Dnd, "busy").await;

        let p = pm.get_presence("user1").await.unwrap();
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["user_id"], "user1");
        assert_eq!(json["status"], "dnd");
        assert_eq!(json["custom_status"], "busy");
        // last_activity is #[serde(skip)] so should not appear
        assert!(json.get("last_activity").is_none());
    }
}
