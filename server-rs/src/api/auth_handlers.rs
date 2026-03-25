use axum::{extract::State, Json};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::api::helpers::spawn_db;
use crate::api::AppState;
use crate::db;
use crate::error::AppError;

#[derive(Deserialize)]
pub struct ChallengeRequest {
    pub public_key: String,
}

#[derive(Deserialize)]
pub struct VerifyRequest {
    pub challenge_id: String,
    pub public_key: String,
    pub signature: String,
}

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub challenge_id: String,
    pub public_key: String,
    pub signature: String,
    pub username: String,
    pub invite_token: String,
}

#[derive(Deserialize)]
pub struct BootstrapRequest {
    pub challenge_id: String,
    pub public_key: String,
    pub signature: String,
    pub username: String,
    pub bootstrap_token: String,
    #[serde(default)]
    pub team_name: String,
}

pub async fn challenge(
    State(state): State<AppState>,
    Json(body): Json<ChallengeRequest>,
) -> Result<Json<Value>, AppError> {
    // Validate the public key is valid base64 and 32 bytes.
    let pk_bytes = base64::engine::general_purpose::STANDARD
        .decode(&body.public_key)
        .map_err(|_| AppError::BadRequest("invalid base64 public key".into()))?;

    if pk_bytes.len() != 32 {
        return Err(AppError::BadRequest("public key must be 32 bytes".into()));
    }

    let (nonce, challenge_id) = state.auth.generate_challenge()?;

    let nonce_b64 = base64::engine::general_purpose::STANDARD.encode(&nonce);

    Ok(Json(json!({
        "challenge_id": challenge_id,
        "nonce": nonce_b64,
    })))
}

pub async fn verify(
    State(state): State<AppState>,
    Json(body): Json<VerifyRequest>,
) -> Result<Json<Value>, AppError> {
    let pk_bytes = base64::engine::general_purpose::STANDARD
        .decode(&body.public_key)
        .map_err(|_| AppError::BadRequest("invalid base64 public key".into()))?;

    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(&body.signature)
        .map_err(|_| AppError::BadRequest("invalid base64 signature".into()))?;

    let valid = state
        .auth
        .verify_challenge(&body.challenge_id, &pk_bytes, &sig_bytes)?;

    if !valid {
        return Err(AppError::Unauthorized("invalid signature".into()));
    }

    // Look up user by public key.
    let pk = pk_bytes.clone();
    let user = spawn_db(state.db.clone(), move |conn| {
        db::get_user_by_public_key(conn, &pk)
    })
    .await?;

    let user = user.ok_or_else(|| {
        AppError::Unauthorized("no account found for this public key — register first".into())
    })?;

    let token = state.auth.generate_jwt(&user.id)?;
    let refresh_token = state.auth.generate_refresh_token(&user.id)?;

    Ok(Json(json!({
        "token": token,
        "refresh_token": refresh_token,
        "user": user,
    })))
}

pub async fn register(
    State(state): State<AppState>,
    Json(body): Json<RegisterRequest>,
) -> Result<Json<Value>, AppError> {
    let pk_bytes = decode_and_verify_challenge(
        &state, &body.challenge_id, &body.public_key, &body.signature,
    )?;

    if body.username.is_empty() {
        return Err(AppError::BadRequest("username is required".into()));
    }

    if body.invite_token.is_empty() {
        return Err(AppError::BadRequest("invite_token is required".into()));
    }

    let username = body.username.clone();
    let invite_token = body.invite_token.clone();
    let pk = pk_bytes;

    let (user, team_id) = spawn_db(state.db.clone(), move |conn| {
        check_username_and_key_available(conn, &username, &pk)?;
        let invite = validate_invite(conn, &invite_token)?;

        let (user, member) = create_user_and_member(conn, &username, &pk, &invite.team_id, &invite.created_by, false);
        db::create_user(conn, &user)?;
        db::create_member(conn, &member)?;

        if let Some(role) = db::get_default_role_for_team(conn, &invite.team_id)? {
            db::assign_role_to_member(conn, &member.id, &role.id)?;
        }

        db::increment_invite_uses(conn, &invite.id)?;
        db::log_invite_use(conn, &invite.id, &user.id)?;

        Ok((user, invite.team_id))
    })
    .await
    .map_err(|e| match e {
        AppError::NotFound(_) => AppError::Conflict("username or public key already registered".into()),
        AppError::Forbidden(msg) => AppError::BadRequest(msg),
        other => other,
    })?;

    let token = state.auth.generate_jwt(&user.id)?;
    let refresh_token = state.auth.generate_refresh_token(&user.id)?;

    Ok(Json(json!({
        "token": token,
        "refresh_token": refresh_token,
        "user": user,
        "team_id": team_id,
    })))
}

pub async fn bootstrap(
    State(state): State<AppState>,
    Json(body): Json<BootstrapRequest>,
) -> Result<Json<Value>, AppError> {
    let pk_bytes = decode_and_verify_challenge(
        &state, &body.challenge_id, &body.public_key, &body.signature,
    )?;

    if body.username.is_empty() {
        return Err(AppError::BadRequest("username is required".into()));
    }

    if body.bootstrap_token.is_empty() {
        return Err(AppError::BadRequest("bootstrap_token is required".into()));
    }

    let username = body.username.clone();
    let bootstrap_token = body.bootstrap_token.clone();
    let pk = pk_bytes;
    let team_name = resolve_team_name(&body.team_name, &state.config.team_name);

    let (user, team_id) = spawn_db(state.db.clone(), move |conn| {
        // Wrap in transaction so partial failures roll back cleanly.
        let tx = conn.unchecked_transaction()?;

        validate_bootstrap_token(&tx, &bootstrap_token)?;

        let (user, _member) = create_user_and_member(&tx, &username, &pk, "", "", true);
        db::create_user(&tx, &user)?;

        let team_id = create_bootstrap_team(&tx, &team_name, &user.id)?;

        let member = db::Member {
            id: db::new_id(),
            team_id: team_id.clone(),
            user_id: user.id.clone(),
            nickname: String::new(),
            joined_at: db::now_str(),
            invited_by: user.id.clone(), // self-invited for bootstrap
            updated_at: String::new(),
        };
        db::create_member(&tx, &member)?;

        create_bootstrap_defaults(&tx, &team_id, &user.id)?;

        tx.commit()?;
        Ok((user, team_id))
    })
    .await
    .map_err(|e| match e {
        AppError::Forbidden(msg) => AppError::BadRequest(msg),
        other => other,
    })?;

    let token = state.auth.generate_jwt(&user.id)?;
    let refresh_token = state.auth.generate_refresh_token(&user.id)?;

    Ok(Json(json!({
        "token": token,
        "refresh_token": refresh_token,
        "user": user,
        "team_id": team_id,
    })))
}

// --- Shared helper functions ---

/// Decode base64 public key and signature, then verify the challenge.
fn decode_and_verify_challenge(
    state: &AppState,
    challenge_id: &str,
    public_key: &str,
    signature: &str,
) -> Result<Vec<u8>, AppError> {
    let pk_bytes = base64::engine::general_purpose::STANDARD
        .decode(public_key)
        .map_err(|_| AppError::BadRequest("invalid base64 public key".into()))?;

    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(signature)
        .map_err(|_| AppError::BadRequest("invalid base64 signature".into()))?;

    let valid = state.auth.verify_challenge(challenge_id, &pk_bytes, &sig_bytes)?;

    if !valid {
        return Err(AppError::Unauthorized("invalid signature".into()));
    }

    Ok(pk_bytes)
}

/// Check that neither username nor public key is already registered.
fn check_username_and_key_available(
    conn: &rusqlite::Connection,
    username: &str,
    pk: &[u8],
) -> Result<(), rusqlite::Error> {
    if db::get_user_by_username(conn, username)?.is_some() {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    if db::get_user_by_public_key(conn, pk)?.is_some() {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    Ok(())
}

/// Validate an invite token (existence, revocation, max uses, expiry).
fn validate_invite(
    conn: &rusqlite::Connection,
    invite_token: &str,
) -> Result<db::Invite, rusqlite::Error> {
    let invite = db::get_invite_by_token(conn, invite_token)?
        .ok_or_else(|| rusqlite::Error::InvalidParameterName("invite not found".into()))?;

    if invite.revoked {
        return Err(rusqlite::Error::InvalidParameterName("invite has been revoked".into()));
    }
    if let Some(max) = invite.max_uses {
        if invite.uses >= max {
            return Err(rusqlite::Error::InvalidParameterName("invite max uses reached".into()));
        }
    }
    if let Some(ref expires) = invite.expires_at {
        if db::now_str() > *expires {
            return Err(rusqlite::Error::InvalidParameterName("invite has expired".into()));
        }
    }
    Ok(invite)
}

/// Create a User and a placeholder Member struct.
fn create_user_and_member(
    _conn: &rusqlite::Connection,
    username: &str,
    pk: &[u8],
    team_id: &str,
    invited_by: &str,
    is_admin: bool,
) -> (db::User, db::Member) {
    let now = db::now_str();
    let user_id = db::new_id();
    let user = db::User {
        id: user_id.clone(),
        username: username.to_string(),
        display_name: username.to_string(),
        public_key: pk.to_vec(),
        avatar_url: String::new(),
        status_text: String::new(),
        status_type: "online".into(),
        is_admin,
        created_at: now.clone(),
        updated_at: now.clone(),
    };
    let member = db::Member {
        id: db::new_id(),
        team_id: team_id.to_string(),
        user_id: user_id.clone(),
        nickname: String::new(),
        joined_at: now,
        invited_by: invited_by.to_string(),
        updated_at: String::new(),
    };
    (user, member)
}

/// Validate and consume a bootstrap token.
fn validate_bootstrap_token(
    conn: &rusqlite::Connection,
    token: &str,
) -> Result<(), rusqlite::Error> {
    let bt = db::get_bootstrap_token(conn, token)?
        .ok_or_else(|| rusqlite::Error::InvalidParameterName("invalid bootstrap token".into()))?;

    if bt.used {
        return Err(rusqlite::Error::InvalidParameterName("bootstrap token already used".into()));
    }

    db::use_bootstrap_token(conn, token)
}

/// Resolve team name with fallbacks.
fn resolve_team_name(body_name: &str, config_name: &str) -> String {
    if !body_name.is_empty() {
        return body_name.to_string();
    }
    if !config_name.is_empty() {
        return config_name.to_string();
    }
    "My Team".to_string()
}

/// Create the bootstrap team and return its ID.
fn create_bootstrap_team(
    conn: &rusqlite::Connection,
    team_name: &str,
    user_id: &str,
) -> Result<String, rusqlite::Error> {
    let now = db::now_str();
    let team_id = db::new_id();
    let team = db::Team {
        id: team_id.clone(),
        name: team_name.to_string(),
        description: String::new(),
        icon_url: String::new(),
        created_by: user_id.to_string(),
        max_file_size: 25 * 1024 * 1024,
        allow_member_invites: true,
        created_at: now.clone(),
        updated_at: now,
    };
    db::create_team(conn, &team)?;
    Ok(team_id)
}

/// Create the default role and #general channel for a bootstrap team.
fn create_bootstrap_defaults(
    conn: &rusqlite::Connection,
    team_id: &str,
    user_id: &str,
) -> Result<(), rusqlite::Error> {
    let now = db::now_str();
    let role = db::Role {
        id: db::new_id(),
        team_id: team_id.to_string(),
        name: "everyone".into(),
        color: "#99AAB5".into(),
        position: 0,
        permissions: db::PERM_SEND_MESSAGES | db::PERM_CREATE_INVITES,
        is_default: true,
        created_at: now.clone(),
        updated_at: String::new(),
    };
    db::create_role(conn, &role)?;

    let channel = db::Channel {
        id: db::new_id(),
        team_id: team_id.to_string(),
        name: "general".into(),
        topic: "General discussion".into(),
        channel_type: "text".into(),
        position: 0,
        category: String::new(),
        created_by: user_id.to_string(),
        created_at: now.clone(),
        updated_at: now,
    };
    db::create_channel(conn, &channel)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{self, Database};

    fn test_db() -> (Database, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
        db.run_migrations().unwrap();
        (db, tmp)
    }

    // ── resolve_team_name tests ─────────────────────────────────────────

    #[test]
    fn resolve_team_name_uses_body_name() {
        assert_eq!(resolve_team_name("My Custom Team", "Config Team"), "My Custom Team");
    }

    #[test]
    fn resolve_team_name_falls_back_to_config() {
        assert_eq!(resolve_team_name("", "Config Team"), "Config Team");
    }

    #[test]
    fn resolve_team_name_falls_back_to_default() {
        assert_eq!(resolve_team_name("", ""), "My Team");
    }

    // ── check_username_and_key_available tests ──────────────────────────

    #[test]
    fn check_username_and_key_available_success() {
        let (db, _tmp) = test_db();
        db.with_conn(|conn| {
            check_username_and_key_available(conn, "newuser", &[42u8; 32])
        })
        .unwrap();
    }

    #[test]
    fn check_username_and_key_available_username_taken() {
        let (db, _tmp) = test_db();
        let now = db::now_str();
        db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: "u1".into(),
                username: "alice".into(),
                display_name: "Alice".into(),
                public_key: vec![1u8; 32],
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            })
        })
        .unwrap();

        let result = db.with_conn(|conn| {
            check_username_and_key_available(conn, "alice", &[42u8; 32])
        });
        assert!(result.is_err());
    }

    #[test]
    fn check_username_and_key_available_key_taken() {
        let (db, _tmp) = test_db();
        let now = db::now_str();
        let pk = vec![1u8; 32];
        db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: "u1".into(),
                username: "alice".into(),
                display_name: "Alice".into(),
                public_key: pk.clone(),
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            })
        })
        .unwrap();

        let result = db.with_conn(|conn| {
            check_username_and_key_available(conn, "newuser", &pk)
        });
        assert!(result.is_err());
    }

    // ── validate_invite tests ───────────────────────────────────────────

    #[test]
    fn validate_invite_success() {
        let (db, _tmp) = test_db();
        let now = db::now_str();
        db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: "u1".into(),
                username: "alice".into(),
                display_name: "Alice".into(),
                public_key: vec![1u8; 32],
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            })?;
            db::create_team(conn, &db::Team {
                id: "t1".into(),
                name: "Team".into(),
                description: String::new(),
                icon_url: String::new(),
                created_by: "u1".into(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                created_at: now.clone(),
                updated_at: now.clone(),
            })?;
            db::create_invite(conn, &db::Invite {
                id: "inv1".into(),
                team_id: "t1".into(),
                created_by: "u1".into(),
                token: "test-token".into(),
                max_uses: None,
                uses: 0,
                expires_at: None,
                revoked: false,
                created_at: now.clone(),
            })?;
            let invite = validate_invite(conn, "test-token")?;
            assert_eq!(invite.token, "test-token");
            assert_eq!(invite.team_id, "t1");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn validate_invite_not_found() {
        let (db, _tmp) = test_db();
        let result = db.with_conn(|conn| validate_invite(conn, "nonexistent"));
        assert!(result.is_err());
    }

    #[test]
    fn validate_invite_revoked() {
        let (db, _tmp) = test_db();
        let now = db::now_str();
        let result = db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: "u1".into(),
                username: "alice".into(),
                display_name: "Alice".into(),
                public_key: vec![1u8; 32],
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            })?;
            db::create_team(conn, &db::Team {
                id: "t1".into(),
                name: "Team".into(),
                description: String::new(),
                icon_url: String::new(),
                created_by: "u1".into(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                created_at: now.clone(),
                updated_at: now.clone(),
            })?;
            db::create_invite(conn, &db::Invite {
                id: "inv1".into(),
                team_id: "t1".into(),
                created_by: "u1".into(),
                token: "revoked-token".into(),
                max_uses: None,
                uses: 0,
                expires_at: None,
                revoked: true,
                created_at: now.clone(),
            })?;
            validate_invite(conn, "revoked-token")
        });
        assert!(result.is_err());
        match result.unwrap_err() {
            rusqlite::Error::InvalidParameterName(msg) => {
                assert!(msg.contains("revoked"));
            }
            other => panic!("expected InvalidParameterName, got {:?}", other),
        }
    }

    #[test]
    fn validate_invite_max_uses_reached() {
        let (db, _tmp) = test_db();
        let now = db::now_str();
        let result = db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: "u1".into(),
                username: "alice".into(),
                display_name: "Alice".into(),
                public_key: vec![1u8; 32],
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            })?;
            db::create_team(conn, &db::Team {
                id: "t1".into(),
                name: "Team".into(),
                description: String::new(),
                icon_url: String::new(),
                created_by: "u1".into(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                created_at: now.clone(),
                updated_at: now.clone(),
            })?;
            db::create_invite(conn, &db::Invite {
                id: "inv1".into(),
                team_id: "t1".into(),
                created_by: "u1".into(),
                token: "maxed-token".into(),
                max_uses: Some(5),
                uses: 5,
                expires_at: None,
                revoked: false,
                created_at: now.clone(),
            })?;
            validate_invite(conn, "maxed-token")
        });
        assert!(result.is_err());
        match result.unwrap_err() {
            rusqlite::Error::InvalidParameterName(msg) => {
                assert!(msg.contains("max uses"));
            }
            other => panic!("expected InvalidParameterName, got {:?}", other),
        }
    }

    #[test]
    fn validate_invite_expired() {
        let (db, _tmp) = test_db();
        let now = db::now_str();
        let result = db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: "u1".into(),
                username: "alice".into(),
                display_name: "Alice".into(),
                public_key: vec![1u8; 32],
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            })?;
            db::create_team(conn, &db::Team {
                id: "t1".into(),
                name: "Team".into(),
                description: String::new(),
                icon_url: String::new(),
                created_by: "u1".into(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                created_at: now.clone(),
                updated_at: now.clone(),
            })?;
            db::create_invite(conn, &db::Invite {
                id: "inv1".into(),
                team_id: "t1".into(),
                created_by: "u1".into(),
                token: "expired-token".into(),
                max_uses: None,
                uses: 0,
                expires_at: Some("2000-01-01 00:00:00".into()),
                revoked: false,
                created_at: now.clone(),
            })?;
            validate_invite(conn, "expired-token")
        });
        assert!(result.is_err());
        match result.unwrap_err() {
            rusqlite::Error::InvalidParameterName(msg) => {
                assert!(msg.contains("expired"));
            }
            other => panic!("expected InvalidParameterName, got {:?}", other),
        }
    }

    // ── validate_bootstrap_token tests ──────────────────────────────────

    #[test]
    fn validate_bootstrap_token_success() {
        let (db, _tmp) = test_db();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO bootstrap_tokens (token, used, created_at) VALUES (?1, 0, ?2)",
                rusqlite::params!["boot-token", db::now_str()],
            )?;
            validate_bootstrap_token(conn, "boot-token")
        })
        .unwrap();
    }

    #[test]
    fn validate_bootstrap_token_already_used() {
        let (db, _tmp) = test_db();
        let result = db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO bootstrap_tokens (token, used, created_at) VALUES (?1, 1, ?2)",
                rusqlite::params!["used-token", db::now_str()],
            )?;
            validate_bootstrap_token(conn, "used-token")
        });
        assert!(result.is_err());
        match result.unwrap_err() {
            rusqlite::Error::InvalidParameterName(msg) => {
                assert!(msg.contains("already used"));
            }
            other => panic!("expected InvalidParameterName, got {:?}", other),
        }
    }

    #[test]
    fn validate_bootstrap_token_not_found() {
        let (db, _tmp) = test_db();
        let result = db.with_conn(|conn| validate_bootstrap_token(conn, "nonexistent"));
        assert!(result.is_err());
    }

    // ── create_user_and_member tests ────────────────────────────────────

    #[test]
    fn create_user_and_member_basic() {
        let (db, _tmp) = test_db();
        let (user, member) = db
            .with_conn(|conn| {
                Ok(create_user_and_member(conn, "testuser", &[42u8; 32], "t1", "inviter", false))
            })
            .unwrap();

        assert_eq!(user.username, "testuser");
        assert_eq!(user.display_name, "testuser");
        assert_eq!(user.public_key, vec![42u8; 32]);
        assert!(!user.is_admin);
        assert_eq!(member.team_id, "t1");
        assert_eq!(member.invited_by, "inviter");
    }

    #[test]
    fn create_user_and_member_admin() {
        let (db, _tmp) = test_db();
        let (user, _member) = db
            .with_conn(|conn| {
                Ok(create_user_and_member(conn, "admin", &[1u8; 32], "t1", "", true))
            })
            .unwrap();

        assert!(user.is_admin);
    }

    // ── create_bootstrap_team tests ─────────────────────────────────────

    #[test]
    fn create_bootstrap_team_creates_team() {
        let (db, _tmp) = test_db();
        let now = db::now_str();
        db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: "u1".into(),
                username: "alice".into(),
                display_name: "Alice".into(),
                public_key: vec![1u8; 32],
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: true,
                created_at: now.clone(),
                updated_at: now.clone(),
            })
        })
        .unwrap();

        let team_id = db
            .with_conn(|conn| create_bootstrap_team(conn, "My Server", "u1"))
            .unwrap();

        let team = db
            .with_conn(|conn| db::get_team(conn, &team_id))
            .unwrap()
            .unwrap();
        assert_eq!(team.name, "My Server");
        assert_eq!(team.created_by, "u1");
    }

    // ── create_bootstrap_defaults tests ─────────────────────────────────

    #[test]
    fn create_bootstrap_defaults_creates_role_and_channel() {
        let (db, _tmp) = test_db();
        let now = db::now_str();
        db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: "u1".into(),
                username: "alice".into(),
                display_name: "Alice".into(),
                public_key: vec![1u8; 32],
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: true,
                created_at: now.clone(),
                updated_at: now.clone(),
            })?;
            let team_id = create_bootstrap_team(conn, "Server", "u1")?;
            create_bootstrap_defaults(conn, &team_id, "u1")?;

            let roles = db::get_roles_by_team(conn, &team_id)?;
            assert!(!roles.is_empty());
            let default_role = roles.iter().find(|r| r.is_default);
            assert!(default_role.is_some());
            assert_eq!(default_role.unwrap().name, "everyone");

            let channels = db::get_channels_by_team(conn, &team_id)?;
            assert!(!channels.is_empty());
            assert_eq!(channels[0].name, "general");

            Ok(())
        })
        .unwrap();
    }
}
