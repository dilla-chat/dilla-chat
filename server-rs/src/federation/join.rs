use std::sync::Arc;

use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::db::{self, Database};

use super::transport::Transport;
use super::{FederationEvent, FED_EVENT_MEMBER_JOINED, FED_EVENT_STATE_SYNC_REQ};

/// Claims embedded in a federation join token (JWT).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct JoinClaims {
    pub team_id: String,
    pub team_name: String,
    pub peers: Vec<String>,
    pub creator: String,
    pub iat: i64,
    pub exp: i64,
}

/// Information extracted from a validated join token.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JoinInfo {
    pub team_id: String,
    pub team_name: String,
    pub peers: Vec<String>,
    pub expires_at: i64,
}

/// Manages federation join tokens — generating and validating JWTs that allow
/// new nodes to join the federation mesh.
pub struct JoinManager {
    secret: Vec<u8>,
    db: Database,
    transport: Arc<Transport>,
    node_name: String,
}

impl JoinManager {
    pub fn new(
        db: Database,
        transport: Arc<Transport>,
        node_name: String,
        join_secret: &str,
    ) -> Self {
        let secret = if join_secret.is_empty() {
            // Generate a random 32-byte secret.
            let mut bytes = vec![0u8; 32];
            rand::thread_rng().fill_bytes(&mut bytes);
            bytes
        } else {
            join_secret.as_bytes().to_vec()
        };

        JoinManager {
            secret,
            db,
            transport,
            node_name,
        }
    }

    /// Generate a federation join token.
    ///
    /// The token is a JWT containing the team ID, team name, the list of known
    /// peers, the creator's user ID, and a 24-hour expiry.
    pub fn generate_join_token(&self, creator_id: &str) -> Result<String, String> {
        let db = self.db.clone();
        let creator_id = creator_id.to_string();

        // Fetch team info synchronously (called from spawn_blocking context).
        let (team_id, team_name) = db
            .with_conn(|conn| {
                let team = db::get_first_team(conn)?;
                match team {
                    Some(t) => Ok((t.id, t.name)),
                    None => Err(rusqlite::Error::QueryReturnedNoRows),
                }
            })
            .map_err(|e| format!("db error: {}", e))?;

        // Collect known peer addresses.
        // Note: This is called from a sync context; the transport peer list
        // must be gathered before calling this method if needed.
        let now = chrono::Utc::now().timestamp();
        let claims = JoinClaims {
            team_id,
            team_name,
            peers: Vec::new(), // Populated by caller via set_peers if needed.
            creator: creator_id,
            iat: now,
            exp: now + 24 * 3600, // 24 hours.
        };

        encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(&self.secret),
        )
        .map_err(|e| format!("jwt encode: {}", e))
    }

    /// Generate a join token with explicit peer list.
    pub fn generate_join_token_with_peers(
        &self,
        creator_id: &str,
        peers: Vec<String>,
    ) -> Result<String, String> {
        let db = self.db.clone();

        let (team_id, team_name) = db
            .with_conn(|conn| {
                let team = db::get_first_team(conn)?;
                match team {
                    Some(t) => Ok((t.id, t.name)),
                    None => Err(rusqlite::Error::QueryReturnedNoRows),
                }
            })
            .map_err(|e| format!("db error: {}", e))?;

        let now = chrono::Utc::now().timestamp();
        let claims = JoinClaims {
            team_id,
            team_name,
            peers,
            creator: creator_id.to_string(),
            iat: now,
            exp: now + 24 * 3600,
        };

        encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(&self.secret),
        )
        .map_err(|e| format!("jwt encode: {}", e))
    }

    /// Validate a federation join token and return the embedded join information.
    pub fn validate_join_token(&self, token: &str) -> Result<JoinInfo, String> {
        let mut validation = Validation::default();
        validation.algorithms = vec![jsonwebtoken::Algorithm::HS256];
        // We validate expiry via the `exp` claim automatically.

        let data = decode::<JoinClaims>(
            token,
            &DecodingKey::from_secret(&self.secret),
            &validation,
        )
        .map_err(|e| format!("invalid join token: {}", e))?;

        Ok(JoinInfo {
            team_id: data.claims.team_id,
            team_name: data.claims.team_name,
            peers: data.claims.peers,
            expires_at: data.claims.exp,
        })
    }

    /// Handle a node joining the mesh.
    ///
    /// Sends a state sync request to the new peer and broadcasts a
    /// `member:joined` federation event to all other peers.
    pub async fn handle_node_join(&self, peer_addr: &str) -> Result<(), String> {
        // Request state sync from the new peer.
        let sync_event = FederationEvent {
            event_type: FED_EVENT_STATE_SYNC_REQ.to_string(),
            node_name: self.node_name.clone(),
            timestamp: chrono::Utc::now().timestamp_millis() as u64,
            payload: serde_json::Value::Null,
        };
        self.transport.send(peer_addr, &sync_event).await?;

        // Broadcast that a new node has joined.
        let join_event = FederationEvent {
            event_type: FED_EVENT_MEMBER_JOINED.to_string(),
            node_name: self.node_name.clone(),
            timestamp: chrono::Utc::now().timestamp_millis() as u64,
            payload: json!({
                "peer_addr": peer_addr,
            }),
        };
        self.transport.broadcast(&join_event).await;

        tracing::info!(peer = %peer_addr, "node join handled — sync requested, peers notified");

        Ok(())
    }
}
