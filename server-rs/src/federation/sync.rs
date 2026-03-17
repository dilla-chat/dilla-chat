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
pub struct SyncManager {
    lamport_ts: AtomicU64,
    db: Database,
    transport: Arc<Transport>,
    node_name: String,
}

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
