use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize)]
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
#[allow(dead_code)]
pub struct VoiceRoom {
    pub channel_id: String,
    pub team_id: String,
    pub peers: Vec<VoicePeer>,
}

pub struct RoomManager {
    rooms: Arc<RwLock<HashMap<String, HashMap<String, VoicePeer>>>>,
    /// Maps channel_id -> team_id for proper team-scoped room queries.
    channel_teams: Arc<RwLock<HashMap<String, String>>>,
}

#[allow(dead_code)]
impl RoomManager {
    pub fn new() -> Self {
        RoomManager {
            rooms: Arc::new(RwLock::new(HashMap::new())),
            channel_teams: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn add_peer(
        &self,
        channel_id: &str,
        user_id: &str,
        username: &str,
        team_id: &str,
    ) {
        // Track the channel -> team mapping.
        {
            let mut teams = self.channel_teams.write().await;
            teams.insert(channel_id.to_string(), team_id.to_string());
        }

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
                // Also clean up team mapping.
                let mut teams = self.channel_teams.write().await;
                teams.remove(channel_id);
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

    /// Returns the user_id of the peer currently screen sharing in the given channel, if any.
    pub async fn screen_sharer(&self, channel_id: &str) -> Option<String> {
        let rooms = self.rooms.read().await;
        rooms.get(channel_id).and_then(|room| {
            room.values()
                .find(|peer| peer.screen_sharing)
                .map(|peer| peer.user_id.clone())
        })
    }

    /// Returns all active voice rooms belonging to the specified team.
    pub async fn get_rooms_by_team(&self, team_id: &str) -> Vec<VoiceRoom> {
        let rooms = self.rooms.read().await;
        let teams = self.channel_teams.read().await;

        rooms
            .iter()
            .filter_map(|(channel_id, peers)| {
                let ch_team = teams.get(channel_id)?;
                if ch_team == team_id {
                    Some(VoiceRoom {
                        channel_id: channel_id.clone(),
                        team_id: ch_team.clone(),
                        peers: peers.values().cloned().collect(),
                    })
                } else {
                    None
                }
            })
            .collect()
    }
}
