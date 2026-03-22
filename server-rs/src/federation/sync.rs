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
    /// Uses last-writer-wins conflict resolution: if a remote record has a newer
    /// `updated_at` (or `edited_at` for messages), the local record is overwritten.
    /// New records are inserted. The entire merge runs in a single transaction.
    pub async fn handle_state_sync_response(&self, data: StateSyncData) -> Result<(), String> {
        let db = self.db.clone();

        let channel_count = data.channels.len();
        let message_count = data.messages.len();
        let member_count = data.members.len();
        let role_count = data.roles.len();

        tokio::task::spawn_blocking(move || {
            db.with_conn(|conn| {
                conn.execute_batch("BEGIN")?;

                let result = (|| {
                    merge_channels(conn, &data.channels)?;
                    merge_roles(conn, &data.roles)?;
                    merge_members(conn, &data.members)?;
                    merge_messages(conn, &data.messages)?;
                    Ok::<(), rusqlite::Error>(())
                })();

                match result {
                    Ok(()) => {
                        conn.execute_batch("COMMIT")?;
                        Ok(())
                    }
                    Err(e) => {
                        let _ = conn.execute_batch("ROLLBACK");
                        Err(e)
                    }
                }
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

/// Merge channels using last-writer-wins on updated_at.
fn merge_channels(conn: &rusqlite::Connection, channels: &[db::Channel]) -> Result<(), rusqlite::Error> {
    for channel in channels {
        if let Some(existing) = db::get_channel_by_id(conn, &channel.id)? {
            if channel.updated_at > existing.updated_at {
                db::update_channel_from_sync(conn, channel)?;
                tracing::debug!(channel_id = %channel.id, name = %channel.name, "updated channel from peer (newer)");
            }
        } else {
            db::create_channel(conn, channel)?;
            tracing::debug!(channel_id = %channel.id, name = %channel.name, "synced channel from peer");
        }
    }
    Ok(())
}

/// Merge roles using last-writer-wins on updated_at.
fn merge_roles(conn: &rusqlite::Connection, roles: &[db::Role]) -> Result<(), rusqlite::Error> {
    for role in roles {
        if let Some(existing) = db::get_role_by_id(conn, &role.id)? {
            if role.updated_at > existing.updated_at {
                db::update_role_from_sync(conn, role)?;
                tracing::debug!(role_id = %role.id, name = %role.name, "updated role from peer (newer)");
            }
        } else {
            db::create_role(conn, role)?;
            tracing::debug!(role_id = %role.id, name = %role.name, "synced role from peer");
        }
    }
    Ok(())
}

/// Merge members using last-writer-wins on updated_at.
fn merge_members(conn: &rusqlite::Connection, members: &[db::Member]) -> Result<(), rusqlite::Error> {
    for member in members {
        if let Some(existing) = db::get_member_by_user_and_team(conn, &member.user_id, &member.team_id)? {
            if member.updated_at > existing.updated_at {
                db::update_member_from_sync(conn, member)?;
                tracing::debug!(member_id = %member.id, user_id = %member.user_id, "updated member from peer (newer)");
            }
        } else {
            db::create_member(conn, member)?;
            tracing::debug!(member_id = %member.id, user_id = %member.user_id, "synced member from peer");
        }
    }
    Ok(())
}

/// Merge messages using last-writer-wins on edited_at, handling soft-deletes.
fn merge_messages(conn: &rusqlite::Connection, messages: &[db::Message]) -> Result<(), rusqlite::Error> {
    for message in messages {
        if let Some(existing) = db::get_message_by_id(conn, &message.id)? {
            if should_update_message(message, &existing) {
                db::update_message_from_sync(conn, message)?;
                tracing::debug!(message_id = %message.id, channel_id = %message.channel_id, deleted = message.deleted, "updated message from peer (newer)");
            }
        } else {
            db::create_message(conn, message)?;
            tracing::debug!(message_id = %message.id, channel_id = %message.channel_id, "synced message from peer");
        }
    }
    Ok(())
}

/// Determine if a remote message should overwrite a local message.
fn should_update_message(remote: &db::Message, local: &db::Message) -> bool {
    let remote_ts = remote.edited_at.as_deref().unwrap_or("");
    let local_ts = local.edited_at.as_deref().unwrap_or("");
    if remote.deleted && !local.deleted {
        remote_ts >= local_ts
    } else {
        remote_ts > local_ts
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
                updated_at: now.clone(),
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
                updated_at: now.clone(),
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
                updated_at: now.clone(),
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
                updated_at: now.clone(),
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

    // ── Conflict resolution (last-writer-wins) tests ────────────────

    /// Helper: create a team + user in the given database, returning (team_id, user_id).
    fn setup_team_and_user(db: &Database) -> (String, String) {
        let now = db::now_str();
        let team_id = db::new_id();
        let user_id = db::new_id();
        db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: user_id.clone(),
                username: format!("user-{}", &user_id[..8]),
                display_name: "Test User".into(),
                public_key: user_id.as_bytes().to_vec(),
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            })?;
            db::create_team(conn, &db::Team {
                id: team_id.clone(),
                name: "Test Team".into(),
                description: String::new(),
                icon_url: String::new(),
                created_by: user_id.clone(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                created_at: now.clone(),
                updated_at: now.clone(),
            })
        })
        .unwrap();
        (team_id, user_id)
    }

    #[tokio::test]
    async fn test_sync_merge_updates_existing_channel_when_newer() {
        let db = test_db();
        let transport = Arc::new(Transport::new());
        let mgr = SyncManager::new(db.clone(), transport, "test-node".into());
        let (team_id, user_id) = setup_team_and_user(&db);

        let channel_id = db::new_id();
        let old_time = "2025-01-01 00:00:00".to_string();
        let new_time = "2025-06-01 00:00:00".to_string();

        // Insert local channel with old timestamp.
        db.with_conn(|conn| {
            db::create_channel(conn, &db::Channel {
                id: channel_id.clone(),
                team_id: team_id.clone(),
                name: "old-name".into(),
                topic: "old-topic".into(),
                channel_type: "text".into(),
                position: 0,
                category: String::new(),
                created_by: user_id.clone(),
                created_at: old_time.clone(),
                updated_at: old_time.clone(),
            })
        })
        .unwrap();

        // Sync a newer version from a peer.
        let sync_data = StateSyncData {
            channels: vec![db::Channel {
                id: channel_id.clone(),
                team_id: team_id.clone(),
                name: "new-name".into(),
                topic: "new-topic".into(),
                channel_type: "text".into(),
                position: 1,
                category: "announcements".into(),
                created_by: user_id.clone(),
                created_at: old_time.clone(),
                updated_at: new_time.clone(),
            }],
            messages: Vec::new(),
            members: Vec::new(),
            roles: Vec::new(),
        };

        mgr.handle_state_sync_response(sync_data).await.unwrap();

        // Verify the channel was updated.
        db.with_conn(|conn| {
            let ch = db::get_channel_by_id(conn, &channel_id)?.unwrap();
            assert_eq!(ch.name, "new-name");
            assert_eq!(ch.topic, "new-topic");
            assert_eq!(ch.position, 1);
            assert_eq!(ch.category, "announcements");
            assert_eq!(ch.updated_at, new_time);
            Ok(())
        })
        .unwrap();
    }

    #[tokio::test]
    async fn test_sync_merge_keeps_local_channel_when_newer() {
        let db = test_db();
        let transport = Arc::new(Transport::new());
        let mgr = SyncManager::new(db.clone(), transport, "test-node".into());
        let (team_id, user_id) = setup_team_and_user(&db);

        let channel_id = db::new_id();
        let old_time = "2025-01-01 00:00:00".to_string();
        let new_time = "2025-06-01 00:00:00".to_string();

        // Insert local channel with NEWER timestamp.
        db.with_conn(|conn| {
            db::create_channel(conn, &db::Channel {
                id: channel_id.clone(),
                team_id: team_id.clone(),
                name: "local-name".into(),
                topic: "local-topic".into(),
                channel_type: "text".into(),
                position: 0,
                category: String::new(),
                created_by: user_id.clone(),
                created_at: old_time.clone(),
                updated_at: new_time.clone(),
            })
        })
        .unwrap();

        // Sync an older version from a peer.
        let sync_data = StateSyncData {
            channels: vec![db::Channel {
                id: channel_id.clone(),
                team_id: team_id.clone(),
                name: "remote-name".into(),
                topic: "remote-topic".into(),
                channel_type: "text".into(),
                position: 5,
                category: String::new(),
                created_by: user_id.clone(),
                created_at: old_time.clone(),
                updated_at: old_time.clone(),
            }],
            messages: Vec::new(),
            members: Vec::new(),
            roles: Vec::new(),
        };

        mgr.handle_state_sync_response(sync_data).await.unwrap();

        // Verify local channel was NOT overwritten.
        db.with_conn(|conn| {
            let ch = db::get_channel_by_id(conn, &channel_id)?.unwrap();
            assert_eq!(ch.name, "local-name");
            assert_eq!(ch.topic, "local-topic");
            assert_eq!(ch.position, 0);
            Ok(())
        })
        .unwrap();
    }

    #[tokio::test]
    async fn test_sync_merge_updates_existing_role_when_newer() {
        let db = test_db();
        let transport = Arc::new(Transport::new());
        let mgr = SyncManager::new(db.clone(), transport, "test-node".into());
        let (team_id, _user_id) = setup_team_and_user(&db);

        let role_id = db::new_id();
        let old_time = "2025-01-01 00:00:00".to_string();
        let new_time = "2025-06-01 00:00:00".to_string();

        // Insert local role with old timestamp.
        db.with_conn(|conn| {
            db::create_role(conn, &db::Role {
                id: role_id.clone(),
                team_id: team_id.clone(),
                name: "old-role".into(),
                color: "#000000".into(),
                position: 0,
                permissions: 0,
                is_default: false,
                created_at: old_time.clone(),
                updated_at: old_time.clone(),
            })
        })
        .unwrap();

        // Sync a newer version.
        let sync_data = StateSyncData {
            channels: Vec::new(),
            messages: Vec::new(),
            members: Vec::new(),
            roles: vec![db::Role {
                id: role_id.clone(),
                team_id: team_id.clone(),
                name: "new-role".into(),
                color: "#FF0000".into(),
                position: 5,
                permissions: 255,
                is_default: false,
                created_at: old_time.clone(),
                updated_at: new_time.clone(),
            }],
        };

        mgr.handle_state_sync_response(sync_data).await.unwrap();

        // Verify role was updated.
        db.with_conn(|conn| {
            let role = db::get_role_by_id(conn, &role_id)?.unwrap();
            assert_eq!(role.name, "new-role");
            assert_eq!(role.color, "#FF0000");
            assert_eq!(role.position, 5);
            assert_eq!(role.permissions, 255);
            assert_eq!(role.updated_at, new_time);
            Ok(())
        })
        .unwrap();
    }

    #[tokio::test]
    async fn test_sync_merge_in_transaction() {
        let db = test_db();
        let transport = Arc::new(Transport::new());
        let mgr = SyncManager::new(db.clone(), transport, "test-node".into());
        let (team_id, user_id) = setup_team_and_user(&db);

        let ch1_id = db::new_id();
        let ch2_id = db::new_id();
        let now = db::now_str();

        // Sync two channels at once — both should appear atomically.
        let sync_data = StateSyncData {
            channels: vec![
                db::Channel {
                    id: ch1_id.clone(),
                    team_id: team_id.clone(),
                    name: "channel-1".into(),
                    topic: String::new(),
                    channel_type: "text".into(),
                    position: 0,
                    category: String::new(),
                    created_by: user_id.clone(),
                    created_at: now.clone(),
                    updated_at: now.clone(),
                },
                db::Channel {
                    id: ch2_id.clone(),
                    team_id: team_id.clone(),
                    name: "channel-2".into(),
                    topic: String::new(),
                    channel_type: "text".into(),
                    position: 1,
                    category: String::new(),
                    created_by: user_id.clone(),
                    created_at: now.clone(),
                    updated_at: now.clone(),
                },
            ],
            messages: Vec::new(),
            members: Vec::new(),
            roles: Vec::new(),
        };

        mgr.handle_state_sync_response(sync_data).await.unwrap();

        // Both channels should exist.
        db.with_conn(|conn| {
            let channels = db::get_channels_by_team(conn, &team_id)?;
            assert_eq!(channels.len(), 2);
            let names: Vec<&str> = channels.iter().map(|c| c.name.as_str()).collect();
            assert!(names.contains(&"channel-1"));
            assert!(names.contains(&"channel-2"));
            Ok(())
        })
        .unwrap();
    }

    #[tokio::test]
    async fn test_sync_merge_handles_deleted_messages() {
        let db = test_db();
        let transport = Arc::new(Transport::new());
        let mgr = SyncManager::new(db.clone(), transport, "test-node".into());
        let (team_id, user_id) = setup_team_and_user(&db);

        let channel_id = db::new_id();
        let message_id = db::new_id();
        let now = "2025-01-01 00:00:00".to_string();
        let edit_time = "2025-06-01 00:00:00".to_string();

        // Create channel and message locally.
        db.with_conn(|conn| {
            db::create_channel(conn, &db::Channel {
                id: channel_id.clone(),
                team_id: team_id.clone(),
                name: "general".into(),
                topic: String::new(),
                channel_type: "text".into(),
                position: 0,
                category: String::new(),
                created_by: user_id.clone(),
                created_at: now.clone(),
                updated_at: now.clone(),
            })?;
            db::create_message(conn, &db::Message {
                id: message_id.clone(),
                channel_id: channel_id.clone(),
                dm_channel_id: String::new(),
                author_id: user_id.clone(),
                content: "original content".into(),
                msg_type: "text".into(),
                thread_id: String::new(),
                edited_at: None,
                deleted: false,
                lamport_ts: 1,
                created_at: now.clone(),
            })
        })
        .unwrap();

        // Sync a deleted version of the same message from a peer.
        let sync_data = StateSyncData {
            channels: Vec::new(),
            messages: vec![db::Message {
                id: message_id.clone(),
                channel_id: channel_id.clone(),
                dm_channel_id: String::new(),
                author_id: user_id.clone(),
                content: String::new(),
                msg_type: "text".into(),
                thread_id: String::new(),
                edited_at: Some(edit_time.clone()),
                deleted: true,
                lamport_ts: 1,
                created_at: now.clone(),
            }],
            members: Vec::new(),
            roles: Vec::new(),
        };

        mgr.handle_state_sync_response(sync_data).await.unwrap();

        // Verify message is now soft-deleted.
        db.with_conn(|conn| {
            let msg = db::get_message_by_id(conn, &message_id)?.unwrap();
            assert!(msg.deleted);
            assert!(msg.content.is_empty());
            Ok(())
        })
        .unwrap();
    }
}
