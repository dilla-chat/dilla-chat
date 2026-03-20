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
#[allow(dead_code)]
pub struct JoinManager {
    secret: Vec<u8>,
    db: Database,
    transport: Arc<Transport>,
    node_name: String,
}

#[allow(dead_code)]
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
            rand::rng().fill_bytes(&mut bytes);
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

    fn test_join_manager(secret: &str) -> JoinManager {
        let db = test_db();
        let transport = Arc::new(Transport::new());
        JoinManager::new(db, transport, "test-node".into(), secret)
    }

    /// Create a JoinManager with a team in the DB so token generation works.
    fn test_join_manager_with_team() -> JoinManager {
        let db = test_db();
        let now = db::now_str();
        db.with_conn(|conn| {
            db::create_team(conn, &db::Team {
                id: "team1".into(),
                name: "Test Team".into(),
                description: String::new(),
                icon_url: String::new(),
                created_by: "user1".into(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                created_at: now.clone(),
                updated_at: now,
            })
        })
        .unwrap();

        let transport = Arc::new(Transport::new());
        JoinManager::new(db, transport, "test-node".into(), "test-secret")
    }

    // ── JoinManager construction ────────────────────────────────────

    #[test]
    fn new_with_explicit_secret() {
        let mgr = test_join_manager("my-secret");
        assert_eq!(mgr.secret, b"my-secret");
    }

    #[test]
    fn new_with_empty_secret_generates_random() {
        let mgr1 = test_join_manager("");
        let mgr2 = test_join_manager("");
        assert_eq!(mgr1.secret.len(), 32);
        assert_eq!(mgr2.secret.len(), 32);
        // Random secrets should differ (extremely unlikely to be equal).
        assert_ne!(mgr1.secret, mgr2.secret);
    }

    #[test]
    fn new_stores_node_name() {
        let mgr = test_join_manager("secret");
        assert_eq!(mgr.node_name, "test-node");
    }

    // ── Token generation ─────────────────────────────────────────────

    #[test]
    fn generate_join_token_returns_jwt() {
        let mgr = test_join_manager_with_team();
        let token = mgr.generate_join_token("user1").unwrap();

        // JWT has 3 dot-separated parts.
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3);
    }

    #[test]
    fn generate_join_token_fails_without_team() {
        let mgr = test_join_manager("secret");
        let result = mgr.generate_join_token("user1");
        assert!(result.is_err());
    }

    #[test]
    fn generate_join_token_with_peers() {
        let mgr = test_join_manager_with_team();
        let peers = vec!["ws://a:8081".into(), "ws://b:8082".into()];
        let token = mgr
            .generate_join_token_with_peers("user1", peers)
            .unwrap();

        let info = mgr.validate_join_token(&token).unwrap();
        assert_eq!(info.peers.len(), 2);
        assert_eq!(info.peers[0], "ws://a:8081");
        assert_eq!(info.peers[1], "ws://b:8082");
    }

    // ── Token validation ─────────────────────────────────────────────

    #[test]
    fn validate_join_token_roundtrip() {
        let mgr = test_join_manager_with_team();
        let token = mgr.generate_join_token("creator1").unwrap();
        let info = mgr.validate_join_token(&token).unwrap();

        assert_eq!(info.team_id, "team1");
        assert_eq!(info.team_name, "Test Team");
        assert!(info.expires_at > chrono::Utc::now().timestamp());
    }

    #[test]
    fn validate_join_token_wrong_secret_fails() {
        let mgr1 = test_join_manager_with_team();
        let token = mgr1.generate_join_token("user1").unwrap();

        // Create a second manager with a different secret.
        let db = test_db();
        let now = db::now_str();
        db.with_conn(|conn| {
            db::create_team(conn, &db::Team {
                id: "team2".into(),
                name: "Other".into(),
                description: String::new(),
                icon_url: String::new(),
                created_by: "user2".into(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                created_at: now.clone(),
                updated_at: now,
            })
        })
        .unwrap();
        let transport = Arc::new(Transport::new());
        let mgr2 = JoinManager::new(db, transport, "other-node".into(), "different-secret");

        let result = mgr2.validate_join_token(&token);
        assert!(result.is_err());
    }

    #[test]
    fn validate_join_token_garbage_input_fails() {
        let mgr = test_join_manager_with_team();
        assert!(mgr.validate_join_token("not-a-jwt").is_err());
        assert!(mgr.validate_join_token("").is_err());
        assert!(mgr.validate_join_token("a.b.c").is_err());
    }

    #[test]
    fn token_expiry_is_24_hours() {
        let mgr = test_join_manager_with_team();
        let token = mgr.generate_join_token("user1").unwrap();
        let info = mgr.validate_join_token(&token).unwrap();

        let now = chrono::Utc::now().timestamp();
        let diff = info.expires_at - now;
        // Should be ~24 hours (86400 seconds), allow 10s tolerance.
        assert!((diff - 86400).abs() < 10);
    }

    #[test]
    fn token_contains_empty_peers_by_default() {
        let mgr = test_join_manager_with_team();
        let token = mgr.generate_join_token("user1").unwrap();
        let info = mgr.validate_join_token(&token).unwrap();
        assert!(info.peers.is_empty());
    }

    // ── JoinInfo serialization ───────────────────────────────────────

    #[test]
    fn join_info_serializes() {
        let info = JoinInfo {
            team_id: "t1".into(),
            team_name: "Team".into(),
            peers: vec!["ws://a:8081".into()],
            expires_at: 1234567890,
        };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["team_id"], "t1");
        assert_eq!(json["team_name"], "Team");
        assert_eq!(json["expires_at"], 1234567890);
    }

    #[test]
    fn join_info_deserializes() {
        let json_str = r#"{"team_id":"t2","team_name":"My Team","peers":[],"expires_at":9999}"#;
        let info: JoinInfo = serde_json::from_str(json_str).unwrap();
        assert_eq!(info.team_id, "t2");
        assert_eq!(info.team_name, "My Team");
        assert!(info.peers.is_empty());
        assert_eq!(info.expires_at, 9999);
    }
}
