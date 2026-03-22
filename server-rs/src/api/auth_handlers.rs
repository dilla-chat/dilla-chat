use axum::{extract::State, Json};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

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
    let db = state.db.clone();
    let pk = pk_bytes.clone();
    let user = tokio::task::spawn_blocking(move || db.with_conn(|conn| db::get_user_by_public_key(conn, &pk)))
        .await
        .map_err(|e| AppError::Internal(format!("task join: {}", e)))?
        .map_err(|e| AppError::Internal(format!("db: {}", e)))?;

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

    let db = state.db.clone();
    let username = body.username.clone();
    let invite_token = body.invite_token.clone();
    let pk = pk_bytes;

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
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
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    let (user, team_id) = match result {
        Ok(v) => v,
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            return Err(AppError::Conflict(
                "username or public key already registered".into(),
            ));
        }
        Err(rusqlite::Error::InvalidParameterName(msg)) => {
            return Err(AppError::BadRequest(msg));
        }
        Err(e) => {
            return Err(AppError::Internal(format!("db: {}", e)));
        }
    };

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

    let db = state.db.clone();
    let username = body.username.clone();
    let bootstrap_token = body.bootstrap_token.clone();
    let pk = pk_bytes;
    let team_name = resolve_team_name(&body.team_name, &state.config.team_name);

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            validate_bootstrap_token(conn, &bootstrap_token)?;

            let (user, _member) = create_user_and_member(conn, &username, &pk, "", "", true);
            db::create_user(conn, &user)?;

            let team_id = create_bootstrap_team(conn, &team_name, &user.id)?;

            let member = db::Member {
                id: db::new_id(),
                team_id: team_id.clone(),
                user_id: user.id.clone(),
                nickname: String::new(),
                joined_at: db::now_str(),
                invited_by: String::new(),
                updated_at: String::new(),
            };
            db::create_member(conn, &member)?;

            create_bootstrap_defaults(conn, &team_id, &user.id)?;

            Ok((user, team_id))
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("task join: {}", e)))?;

    let (user, team_id) = match result {
        Ok(v) => v,
        Err(rusqlite::Error::InvalidParameterName(msg)) => {
            return Err(AppError::BadRequest(msg));
        }
        Err(e) => {
            return Err(AppError::Internal(format!("db: {}", e)));
        }
    };

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
