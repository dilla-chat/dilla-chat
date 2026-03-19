use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::db::{self, Database};

use super::transport::Transport;
use super::{FederationEvent, FED_EVENT_STATE_SYNC_REQ, FED_EVENT_STATE_SYNC_RESP};

/// Data transferred during a state synchronization exchange.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateSyncData {
    pub channels: Vec<db::Channel>,
    pub messages: Vec<db::Message>,
    pub members: Vec<db::Member>,
    pub roles: Vec<db::Role>,
}

/// Lamport clock and state synchronization manager for federation.
///
/// Provides a monotonically increasing logical timestamp (Lamport clock)
/// for causal ordering of federated events, plus helpers for full state
/// synchronization between peers.
#[allow(dead_code)]
pub struct SyncManager {
    lamport_ts: AtomicU64,
    db: Database,
    transport: Arc<Transport>,
    node_name: String,
}

#[allow(dead_code)]
impl SyncManager {
    pub fn new(db: Database, transport: Arc<Transport>, node_name: String) -> Self {
        SyncManager {
            lamport_ts: AtomicU64::new(0),
            db,
            transport,
            node_name,
        }
    }

    /// Atomically increment the Lamport timestamp and return the new value.
    pub fn tick(&self) -> u64 {
        self.lamport_ts.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Update the Lamport timestamp with a received value.
    ///
    /// Sets the local clock to `max(current, received) + 1` using a CAS loop
    /// to ensure atomic correctness under concurrent access.
    pub fn update(&self, received: u64) -> u64 {
        loop {
            let current = self.lamport_ts.load(Ordering::SeqCst);
            let new_val = std::cmp::max(current, received) + 1;
            match self.lamport_ts.compare_exchange(
                current,
                new_val,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => return new_val,
                Err(_) => continue, // CAS failed, retry.
            }
        }
    }

    /// Return the current Lamport timestamp without modifying it.
    pub fn current(&self) -> u64 {
        self.lamport_ts.load(Ordering::SeqCst)
    }

    /// Send a state sync request to the given peer.
    pub async fn request_state_sync(&self, peer_addr: &str) -> Result<(), String> {
        let event = FederationEvent {
            event_type: FED_EVENT_STATE_SYNC_REQ.to_string(),
            node_name: self.node_name.clone(),
            timestamp: self.tick(),
            payload: serde_json::Value::Null,
        };

        self.transport.send(peer_addr, &event).await
    }

    /// Handle an incoming state sync request from a peer.
    ///
    /// Fetches all channels, messages, members, and roles from the local database
    /// and sends them back to the requesting peer.
    pub async fn handle_state_sync_request(&self, peer_addr: &str) -> Result<(), String> {
        let db = self.db.clone();

        let sync_data = tokio::task::spawn_blocking(move || {
            db.with_conn(|conn| {
                // Get the first team (federation is team-scoped).
                let team = db::get_first_team(conn)?;
                let team = match team {
                    Some(t) => t,
                    None => {
                        return Ok(StateSyncData {
                            channels: Vec::new(),
                            messages: Vec::new(),
                            members: Vec::new(),
                            roles: Vec::new(),
                        });
                    }
                };

                let channels = db::get_channels_by_team(conn, &team.id)?;
                let roles = db::get_roles_by_team(conn, &team.id)?;

                // Collect members (just the Member struct, not the User join).
                let member_pairs = db::get_members_by_team(conn, &team.id)?;
                let members: Vec<db::Member> = member_pairs.into_iter().map(|(m, _)| m).collect();

                // Collect recent messages across all channels.
                let mut messages = Vec::new();
                for ch in &channels {
                    let ch_msgs = db::get_messages_by_channel(conn, &ch.id, "", 100)?;
                    messages.extend(ch_msgs);
                }

                Ok(StateSyncData {
                    channels,
                    messages,
                    members,
                    roles,
                })
            })
        })
        .await
        .map_err(|e| format!("task join: {}", e))?
        .map_err(|e: rusqlite::Error| format!("db error: {}", e))?;

        let payload = serde_json::to_value(&sync_data)
            .map_err(|e| format!("serialize sync data: {}", e))?;

        let event = FederationEvent {
            event_type: FED_EVENT_STATE_SYNC_RESP.to_string(),
            node_name: self.node_name.clone(),
            timestamp: self.tick(),
            payload,
        };

        self.transport.send(peer_addr, &event).await
    }

    /// Handle an incoming state sync response by merging the data into the local DB.
    ///
    /// Uses "create if not exists" semantics — existing records are not overwritten.
    pub async fn handle_state_sync_response(&self, data: StateSyncData) -> Result<(), String> {
        let db = self.db.clone();

        let channel_count = data.channels.len();
        let message_count = data.messages.len();
        let member_count = data.members.len();
        let role_count = data.roles.len();

        tokio::task::spawn_blocking(move || {
            db.with_conn(|conn| {
                // Merge channels.
                for channel in &data.channels {
                    let existing = db::get_channel_by_id(conn, &channel.id)?;
                    if existing.is_none() {
                        db::create_channel(conn, channel)?;
                        tracing::debug!(
                            channel_id = %channel.id,
                            name = %channel.name,
                            "synced channel from peer"
                        );
                    }
                }

                // Merge roles.
                for role in &data.roles {
                    let existing = db::get_role_by_id(conn, &role.id)?;
                    if existing.is_none() {
                        db::create_role(conn, role)?;
                        tracing::debug!(
                            role_id = %role.id,
                            name = %role.name,
                            "synced role from peer"
                        );
                    }
                }

                // Merge members.
                for member in &data.members {
                    let existing =
                        db::get_member_by_user_and_team(conn, &member.user_id, &member.team_id)?;
                    if existing.is_none() {
                        db::create_member(conn, member)?;
                        tracing::debug!(
                            member_id = %member.id,
                            user_id = %member.user_id,
                            "synced member from peer"
                        );
                    }
                }

                // Merge messages.
                for message in &data.messages {
                    let existing = db::get_message_by_id(conn, &message.id)?;
                    if existing.is_none() {
                        db::create_message(conn, message)?;
                        tracing::debug!(
                            message_id = %message.id,
                            channel_id = %message.channel_id,
                            "synced message from peer"
                        );
                    }
                }

                Ok(())
            })
        })
        .await
        .map_err(|e| format!("task join: {}", e))?
        .map_err(|e: rusqlite::Error| format!("db merge error: {}", e))?;

        tracing::info!(
            channels = channel_count,
            messages = message_count,
            members = member_count,
            roles = role_count,
            "state sync merge complete"
        );

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{self, Database};
    use std::sync::Arc;

    fn test_db() -> Database {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
        db.run_migrations().unwrap();
        db
    }

    fn test_sync_manager() -> SyncManager {
        let db = test_db();
        let transport = Arc::new(Transport::new());
        SyncManager::new(db, transport, "test-node".into())
    }

    // ── Lamport clock tests ─────────────────────────────────────────

    #[test]
    fn tick_starts_at_one() {
        let mgr = test_sync_manager();
        assert_eq!(mgr.current(), 0);
        assert_eq!(mgr.tick(), 1);
        assert_eq!(mgr.current(), 1);
    }

    #[test]
    fn tick_increments_monotonically() {
        let mgr = test_sync_manager();
        assert_eq!(mgr.tick(), 1);
        assert_eq!(mgr.tick(), 2);
        assert_eq!(mgr.tick(), 3);
        assert_eq!(mgr.current(), 3);
    }

    #[test]
    fn update_advances_past_received_value() {
        let mgr = test_sync_manager();
        let result = mgr.update(10);
        assert_eq!(result, 11); // max(0, 10) + 1
        assert_eq!(mgr.current(), 11);
    }

    #[test]
    fn update_advances_past_current_when_higher() {
        let mgr = test_sync_manager();
        mgr.tick(); // 1
        mgr.tick(); // 2
        mgr.tick(); // 3
        // current = 3, received = 1 => max(3,1)+1 = 4
        let result = mgr.update(1);
        assert_eq!(result, 4);
    }

    #[test]
    fn update_advances_past_received_when_higher() {
        let mgr = test_sync_manager();
        mgr.tick(); // 1
        // current = 1, received = 100 => max(1,100)+1 = 101
        let result = mgr.update(100);
        assert_eq!(result, 101);
        assert_eq!(mgr.current(), 101);
    }

    #[test]
    fn update_with_zero_increments() {
        let mgr = test_sync_manager();
        // current = 0, received = 0 => max(0,0)+1 = 1
        let result = mgr.update(0);
        assert_eq!(result, 1);
    }

    #[test]
    fn tick_and_update_interleaved() {
        let mgr = test_sync_manager();
        assert_eq!(mgr.tick(), 1);
        assert_eq!(mgr.update(5), 6);
        assert_eq!(mgr.tick(), 7);
        assert_eq!(mgr.update(3), 8); // max(7,3)+1
        assert_eq!(mgr.tick(), 9);
    }

    #[test]
    fn current_does_not_modify_clock() {
        let mgr = test_sync_manager();
        mgr.tick();
        let c1 = mgr.current();
        let c2 = mgr.current();
        assert_eq!(c1, c2);
        assert_eq!(c1, 1);
    }

    #[test]
    fn concurrent_ticks() {
        let mgr = Arc::new(test_sync_manager());
        let mut handles = vec![];

        for _ in 0..10 {
            let m = Arc::clone(&mgr);
            handles.push(std::thread::spawn(move || {
                for _ in 0..100 {
                    m.tick();
                }
            }));
        }

        for h in handles {
            h.join().unwrap();
        }

        // 10 threads * 100 ticks = 1000
        assert_eq!(mgr.current(), 1000);
    }

    // ── StateSyncData serialization tests ───────────────────────────

    #[test]
    fn state_sync_data_serializes_empty() {
        let data = StateSyncData {
            channels: Vec::new(),
            messages: Vec::new(),
            members: Vec::new(),
            roles: Vec::new(),
        };
        let json = serde_json::to_value(&data).unwrap();
        assert_eq!(json["channels"], serde_json::json!([]));
        assert_eq!(json["messages"], serde_json::json!([]));
        assert_eq!(json["members"], serde_json::json!([]));
        assert_eq!(json["roles"], serde_json::json!([]));
    }

    #[test]
    fn state_sync_data_roundtrip() {
        let now = db::now_str();
        let data = StateSyncData {
            channels: vec![db::Channel {
                id: "ch1".into(),
                team_id: "t1".into(),
                name: "general".into(),
                topic: "topic".into(),
                channel_type: "text".into(),
                position: 0,
                category: String::new(),
                created_by: "u1".into(),
                created_at: now.clone(),
                updated_at: now.clone(),
            }],
            messages: vec![db::Message {
                id: "m1".into(),
                channel_id: "ch1".into(),
                dm_channel_id: String::new(),
                author_id: "u1".into(),
                content: "hello".into(),
                msg_type: "text".into(),
                thread_id: String::new(),
                edited_at: None,
                deleted: false,
                lamport_ts: 5,
                created_at: now.clone(),
            }],
            members: vec![db::Member {
                id: "mem1".into(),
                team_id: "t1".into(),
                user_id: "u1".into(),
                nickname: String::new(),
                joined_at: now.clone(),
                invited_by: String::new(),
            }],
            roles: vec![db::Role {
                id: "r1".into(),
                team_id: "t1".into(),
                name: "everyone".into(),
                color: "#99AAB5".into(),
                position: 0,
                permissions: 0,
                is_default: true,
                created_at: now.clone(),
            }],
        };

        let json_str = serde_json::to_string(&data).unwrap();
        let deserialized: StateSyncData = serde_json::from_str(&json_str).unwrap();

        assert_eq!(deserialized.channels.len(), 1);
        assert_eq!(deserialized.channels[0].name, "general");
        assert_eq!(deserialized.messages.len(), 1);
        assert_eq!(deserialized.messages[0].content, "hello");
        assert_eq!(deserialized.members.len(), 1);
        assert_eq!(deserialized.roles.len(), 1);
    }

    // ── handle_state_sync_response (DB merge) tests ──────────────────

    #[tokio::test]
    async fn merge_state_inserts_new_records() {
        let db = test_db();
        let transport = Arc::new(Transport::new());
        let mgr = SyncManager::new(db.clone(), transport, "test-node".into());

        let now = db::now_str();
        let team_id = db::new_id();
        let user_id = db::new_id();
        let channel_id = db::new_id();

        // Create team and user first (foreign key deps).
        db.with_conn(|conn| {
            db::create_team(conn, &db::Team {
                id: team_id.clone(),
                name: "Test".into(),
                description: String::new(),
                icon_url: String::new(),
                created_by: user_id.clone(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                created_at: now.clone(),
                updated_at: now.clone(),
            })?;
            db::create_user(conn, &db::User {
                id: user_id.clone(),
                username: "alice".into(),
                display_name: "Alice".into(),
                public_key: vec![0u8; 32],
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            })
        })
        .unwrap();

        let sync_data = StateSyncData {
            channels: vec![db::Channel {
                id: channel_id.clone(),
                team_id: team_id.clone(),
                name: "synced-channel".into(),
                topic: String::new(),
                channel_type: "text".into(),
                position: 0,
                category: String::new(),
                created_by: user_id.clone(),
                created_at: now.clone(),
                updated_at: now.clone(),
            }],
            messages: vec![db::Message {
                id: db::new_id(),
                channel_id: channel_id.clone(),
                dm_channel_id: String::new(),
                author_id: user_id.clone(),
                content: "synced message".into(),
                msg_type: "text".into(),
                thread_id: String::new(),
                edited_at: None,
                deleted: false,
                lamport_ts: 1,
                created_at: now.clone(),
            }],
            members: vec![db::Member {
                id: db::new_id(),
                team_id: team_id.clone(),
                user_id: user_id.clone(),
                nickname: String::new(),
                joined_at: now.clone(),
                invited_by: String::new(),
            }],
            roles: vec![db::Role {
                id: db::new_id(),
                team_id: team_id.clone(),
                name: "synced-role".into(),
                color: "#FF0000".into(),
                position: 0,
                permissions: 0,
                is_default: false,
                created_at: now.clone(),
            }],
        };

        mgr.handle_state_sync_response(sync_data).await.unwrap();

        // Verify records were inserted.
        db.with_conn(|conn| {
            let ch = db::get_channel_by_id(conn, &channel_id)?;
            assert!(ch.is_some());
            assert_eq!(ch.unwrap().name, "synced-channel");

            let channels = db::get_channels_by_team(conn, &team_id)?;
            assert_eq!(channels.len(), 1);

            let roles = db::get_roles_by_team(conn, &team_id)?;
            assert_eq!(roles.len(), 1);
            assert_eq!(roles[0].name, "synced-role");

            Ok(())
        })
        .unwrap();
    }

    #[tokio::test]
    async fn merge_state_skips_existing_channels() {
        let db = test_db();
        let transport = Arc::new(Transport::new());
        let mgr = SyncManager::new(db.clone(), transport, "test-node".into());

        let now = db::now_str();
        let team_id = db::new_id();
        let user_id = db::new_id();
        let channel_id = db::new_id();

        // Create team, user, and channel.
        db.with_conn(|conn| {
            db::create_team(conn, &db::Team {
                id: team_id.clone(),
                name: "Test".into(),
                description: String::new(),
                icon_url: String::new(),
                created_by: user_id.clone(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                created_at: now.clone(),
                updated_at: now.clone(),
            })?;
            db::create_user(conn, &db::User {
                id: user_id.clone(),
                username: "alice".into(),
                display_name: "Alice".into(),
                public_key: vec![0u8; 32],
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            })?;
            db::create_channel(conn, &db::Channel {
                id: channel_id.clone(),
                team_id: team_id.clone(),
                name: "original-name".into(),
                topic: String::new(),
                channel_type: "text".into(),
                position: 0,
                category: String::new(),
                created_by: user_id.clone(),
                created_at: now.clone(),
                updated_at: now.clone(),
            })
        })
        .unwrap();

        // Try to merge a channel with the same ID but different name.
        let sync_data = StateSyncData {
            channels: vec![db::Channel {
                id: channel_id.clone(),
                team_id: team_id.clone(),
                name: "different-name".into(),
                topic: String::new(),
                channel_type: "text".into(),
                position: 0,
                category: String::new(),
                created_by: user_id.clone(),
                created_at: now.clone(),
                updated_at: now.clone(),
            }],
            messages: Vec::new(),
            members: Vec::new(),
            roles: Vec::new(),
        };

        mgr.handle_state_sync_response(sync_data).await.unwrap();

        // Verify original name is preserved (not overwritten).
        db.with_conn(|conn| {
            let ch = db::get_channel_by_id(conn, &channel_id)?.unwrap();
            assert_eq!(ch.name, "original-name");
            Ok(())
        })
        .unwrap();
    }

    #[tokio::test]
    async fn merge_state_handles_empty_data() {
        let db = test_db();
        let transport = Arc::new(Transport::new());
        let mgr = SyncManager::new(db, transport, "test-node".into());

        let sync_data = StateSyncData {
            channels: Vec::new(),
            messages: Vec::new(),
            members: Vec::new(),
            roles: Vec::new(),
        };

        // Should succeed without error.
        mgr.handle_state_sync_response(sync_data).await.unwrap();
    }

    // ── SyncManager construction ─────────────────────────────────────

    #[test]
    fn sync_manager_initial_clock_is_zero() {
        let mgr = test_sync_manager();
        assert_eq!(mgr.current(), 0);
    }

    #[test]
    fn sync_manager_stores_node_name() {
        let db = test_db();
        let transport = Arc::new(Transport::new());
        let mgr = SyncManager::new(db, transport, "my-node".into());
        assert_eq!(mgr.node_name, "my-node");
    }
}
