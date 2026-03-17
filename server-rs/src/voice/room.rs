use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize)]
pub struct VoicePeer {
    pub user_id: String,
    pub username: String,
    pub muted: bool,
    pub deafened: bool,
    pub speaking: bool,
    pub screen_sharing: bool,
    pub webcam_sharing: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct VoiceRoom {
    pub channel_id: String,
    pub team_id: String,
    pub peers: Vec<VoicePeer>,
}

pub struct RoomManager {
    rooms: Arc<RwLock<HashMap<String, HashMap<String, VoicePeer>>>>,
}

impl RoomManager {
    pub fn new() -> Self {
        RoomManager {
            rooms: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn add_peer(
        &self,
        channel_id: &str,
        user_id: &str,
        username: &str,
    ) {
        let mut rooms = self.rooms.write().await;
        let room = rooms.entry(channel_id.to_string()).or_default();
        room.insert(
            user_id.to_string(),
            VoicePeer {
                user_id: user_id.to_string(),
                username: username.to_string(),
                muted: false,
                deafened: false,
                speaking: false,
                screen_sharing: false,
                webcam_sharing: false,
            },
        );
    }

    pub async fn remove_peer(&self, channel_id: &str, user_id: &str) {
        let mut rooms = self.rooms.write().await;
        if let Some(room) = rooms.get_mut(channel_id) {
            room.remove(user_id);
            if room.is_empty() {
                rooms.remove(channel_id);
            }
        }
    }

    pub async fn get_room(&self, channel_id: &str) -> Option<Vec<VoicePeer>> {
        let rooms = self.rooms.read().await;
        rooms
            .get(channel_id)
            .map(|room| room.values().cloned().collect())
    }

    pub async fn set_muted(&self, channel_id: &str, user_id: &str, muted: bool) {
        let mut rooms = self.rooms.write().await;
        if let Some(room) = rooms.get_mut(channel_id) {
            if let Some(peer) = room.get_mut(user_id) {
                peer.muted = muted;
            }
        }
    }

    pub async fn set_deafened(&self, channel_id: &str, user_id: &str, deafened: bool) {
        let mut rooms = self.rooms.write().await;
        if let Some(room) = rooms.get_mut(channel_id) {
            if let Some(peer) = room.get_mut(user_id) {
                peer.deafened = deafened;
            }
        }
    }

    pub async fn set_screen_sharing(
        &self,
        channel_id: &str,
        user_id: &str,
        sharing: bool,
    ) {
        let mut rooms = self.rooms.write().await;
        if let Some(room) = rooms.get_mut(channel_id) {
            if let Some(peer) = room.get_mut(user_id) {
                peer.screen_sharing = sharing;
            }
        }
    }

    pub async fn set_webcam_sharing(
        &self,
        channel_id: &str,
        user_id: &str,
        sharing: bool,
    ) {
        let mut rooms = self.rooms.write().await;
        if let Some(room) = rooms.get_mut(channel_id) {
            if let Some(peer) = room.get_mut(user_id) {
                peer.webcam_sharing = sharing;
            }
        }
    }

    pub async fn get_rooms_by_team(&self, team_id: &str) -> Vec<VoiceRoom> {
        // Note: In a full implementation, rooms would track team_id.
        // For now, return all rooms.
        let rooms = self.rooms.read().await;
        rooms
            .iter()
            .map(|(channel_id, peers)| VoiceRoom {
                channel_id: channel_id.clone(),
                team_id: team_id.to_string(),
                peers: peers.values().cloned().collect(),
            })
            .collect()
    }
}
