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

    /// Add the user to a voice channel. Enforces the server-side
    /// invariant "a user is in at most one voice channel at a time" —
    /// any prior channel they were in is silently evicted. Returns the
    /// list of channels they were evicted from so the caller can
    /// broadcast `voice:user-left` and tear down their SFU peers.
    /// This makes voice:join a self-sufficient operation: the client
    /// doesn't need to coordinate a leave-before-join.
    pub async fn add_peer(
        &self,
        channel_id: &str,
        user_id: &str,
        username: &str,
        team_id: &str,
    ) -> Vec<String> {
        {
            let mut teams = self.channel_teams.write().await;
            teams.insert(channel_id.to_string(), team_id.to_string());
        }

        let mut evicted_channels: Vec<String> = Vec::new();
        let mut emptied: Vec<String> = Vec::new();
        {
            let mut rooms = self.rooms.write().await;
            for (cid, room) in rooms.iter_mut() {
                if cid == channel_id {
                    continue;
                }
                if room.remove(user_id).is_some() {
                    evicted_channels.push(cid.clone());
                    if room.is_empty() {
                        emptied.push(cid.clone());
                    }
                }
            }
            for cid in &emptied {
                rooms.remove(cid);
            }
        }
        if !emptied.is_empty() {
            let mut teams = self.channel_teams.write().await;
            for cid in &emptied {
                teams.remove(cid);
            }
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

        evicted_channels
    }

    /// Evict a user from every voice channel they're in. Called when
    /// their last WS connection closes — voice membership is bound
    /// to WS-lifetime so a closed tab cleans up automatically.
    /// Returns the channels they were removed from so the caller can
    /// broadcast voice:user-left.
    pub async fn remove_peer_everywhere(&self, user_id: &str) -> Vec<String> {
        let mut rooms = self.rooms.write().await;
        let mut removed_channels = Vec::new();
        let mut emptied = Vec::new();
        for (cid, room) in rooms.iter_mut() {
            if room.remove(user_id).is_some() {
                removed_channels.push(cid.clone());
                if room.is_empty() {
                    emptied.push(cid.clone());
                }
            }
        }
        for cid in &emptied {
            rooms.remove(cid);
        }
        if !emptied.is_empty() {
            drop(rooms);
            let mut teams = self.channel_teams.write().await;
            for cid in &emptied {
                teams.remove(cid);
            }
        }
        removed_channels
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn add_peer_places_user_into_named_channel_with_default_flags() {
        let m = RoomManager::new();
        let evicted = m.add_peer("c1", "u1", "alice", "t1").await;
        assert_eq!(evicted, Vec::<String>::new());
        let room = m.get_room("c1").await.unwrap();
        assert_eq!(room.len(), 1);
        assert_eq!(room[0].user_id, "u1");
        assert_eq!(room[0].username, "alice");
        assert!(!room[0].muted);
        assert!(!room[0].deafened);
        assert!(!room[0].speaking);
        assert!(!room[0].screen_sharing);
        assert!(!room[0].webcam_sharing);
    }

    #[tokio::test]
    async fn add_peer_evicts_from_any_prior_channel_one_voice_at_a_time() {
        let m = RoomManager::new();
        m.add_peer("c1", "u1", "alice", "t1").await;
        let evicted = m.add_peer("c2", "u1", "alice", "t1").await;
        assert_eq!(evicted, vec!["c1".to_string()]);
        // c1 was emptied → removed
        assert!(m.get_room("c1").await.is_none());
        // u1 now lives in c2
        assert_eq!(m.get_room("c2").await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn add_peer_doesnt_evict_others_when_user_moves() {
        let m = RoomManager::new();
        m.add_peer("c1", "u1", "alice", "t1").await;
        m.add_peer("c1", "u2", "bob", "t1").await;
        m.add_peer("c2", "u1", "alice", "t1").await;
        // c1 still holds bob — not emptied.
        let c1 = m.get_room("c1").await.unwrap();
        assert_eq!(c1.len(), 1);
        assert_eq!(c1[0].user_id, "u2");
    }

    #[tokio::test]
    async fn remove_peer_drops_empty_channel() {
        let m = RoomManager::new();
        m.add_peer("c1", "u1", "alice", "t1").await;
        m.remove_peer("c1", "u1").await;
        assert!(m.get_room("c1").await.is_none());
    }

    #[tokio::test]
    async fn remove_peer_everywhere_returns_every_channel_the_user_was_in() {
        let m = RoomManager::new();
        m.add_peer("c1", "u1", "alice", "t1").await;
        // (manually inject another channel by joining a different user
        // first, then adding u1 there)
        m.add_peer("c2", "u2", "bob", "t1").await;
        m.add_peer("c2", "u1", "alice2", "t1").await;
        // u1 should now be in c2 only (was evicted from c1 by the second add_peer).
        let removed = m.remove_peer_everywhere("u1").await;
        assert!(removed.contains(&"c2".to_string()));
        // c1 was emptied by the eviction earlier — already gone.
        assert!(!removed.contains(&"c1".to_string()));
    }

    #[tokio::test]
    async fn set_muted_and_set_deafened_update_the_peer() {
        let m = RoomManager::new();
        m.add_peer("c1", "u1", "alice", "t1").await;
        m.set_muted("c1", "u1", true).await;
        m.set_deafened("c1", "u1", true).await;
        let r = m.get_room("c1").await.unwrap();
        assert!(r[0].muted);
        assert!(r[0].deafened);
    }

    #[tokio::test]
    async fn screen_sharer_returns_the_active_sharer_or_none() {
        let m = RoomManager::new();
        m.add_peer("c1", "u1", "alice", "t1").await;
        m.add_peer("c1", "u2", "bob", "t1").await;
        assert!(m.screen_sharer("c1").await.is_none());
        m.set_screen_sharing("c1", "u2", true).await;
        assert_eq!(m.screen_sharer("c1").await, Some("u2".to_string()));
        m.set_screen_sharing("c1", "u2", false).await;
        assert!(m.screen_sharer("c1").await.is_none());
    }

    #[tokio::test]
    async fn get_rooms_by_team_filters_correctly() {
        let m = RoomManager::new();
        m.add_peer("c1", "u1", "alice", "tA").await;
        m.add_peer("c2", "u2", "bob", "tA").await;
        m.add_peer("c3", "u3", "carol", "tB").await;
        let rooms_a = m.get_rooms_by_team("tA").await;
        let mut ids: Vec<&str> = rooms_a.iter().map(|r| r.channel_id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, vec!["c1", "c2"]);
        let rooms_b = m.get_rooms_by_team("tB").await;
        assert_eq!(rooms_b.len(), 1);
        assert_eq!(rooms_b[0].channel_id, "c3");
    }

    #[tokio::test]
    async fn set_muted_on_unknown_user_is_a_noop() {
        let m = RoomManager::new();
        m.add_peer("c1", "u1", "alice", "t1").await;
        m.set_muted("c1", "ghost", true).await;
        let r = m.get_room("c1").await.unwrap();
        // u1 still unmuted; ghost was never added.
        assert!(!r[0].muted);
        assert_eq!(r.len(), 1);
    }

    #[tokio::test]
    async fn webcam_sharing_can_be_toggled_per_peer() {
        let m = RoomManager::new();
        m.add_peer("c1", "u1", "alice", "t1").await;
        m.set_webcam_sharing("c1", "u1", true).await;
        assert!(m.get_room("c1").await.unwrap()[0].webcam_sharing);
        m.set_webcam_sharing("c1", "u1", false).await;
        assert!(!m.get_room("c1").await.unwrap()[0].webcam_sharing);
    }
}
