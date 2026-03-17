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

    Ok(Json(json!({
        "token": token,
        "user": user,
    })))
}

pub async fn register(
    State(state): State<AppState>,
    Json(body): Json<RegisterRequest>,
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

    if body.username.is_empty() {
        return Err(AppError::BadRequest("username is required".into()));
    }

    if body.invite_token.is_empty() {
        return Err(AppError::BadRequest("invite_token is required".into()));
    }

    let db = state.db.clone();
    let username = body.username.clone();
    let invite_token = body.invite_token.clone();
    let pk = pk_bytes.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            // Check if username is taken.
            if let Some(_) = db::get_user_by_username(conn, &username)? {
                return Err(rusqlite::Error::QueryReturnedNoRows); // sentinel
            }

            // Check if public key already registered.
            if let Some(_) = db::get_user_by_public_key(conn, &pk)? {
                return Err(rusqlite::Error::QueryReturnedNoRows); // sentinel
            }

            // Validate invite token.
            let invite = db::get_invite_by_token(conn, &invite_token)?
                .ok_or_else(|| {
                    rusqlite::Error::InvalidParameterName("invite not found".into())
                })?;

            if invite.revoked {
                return Err(rusqlite::Error::InvalidParameterName(
                    "invite has been revoked".into(),
                ));
            }

            if let Some(max) = invite.max_uses {
                if invite.uses >= max {
                    return Err(rusqlite::Error::InvalidParameterName(
                        "invite max uses reached".into(),
                    ));
                }
            }

            if let Some(ref expires) = invite.expires_at {
                let now = db::now_str();
                if now > *expires {
                    return Err(rusqlite::Error::InvalidParameterName(
                        "invite has expired".into(),
                    ));
                }
            }

            // Create user.
            let now = db::now_str();
            let user_id = db::new_id();
            let user = db::User {
                id: user_id.clone(),
                username: username.clone(),
                display_name: username.clone(),
                public_key: pk.to_vec(),
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            };
            db::create_user(conn, &user)?;

            // Add as team member.
            let member = db::Member {
                id: db::new_id(),
                team_id: invite.team_id.clone(),
                user_id: user_id.clone(),
                nickname: String::new(),
                joined_at: now.clone(),
                invited_by: invite.created_by.clone(),
            };
            db::create_member(conn, &member)?;

            // Assign default role if exists.
            if let Some(role) = db::get_default_role_for_team(conn, &invite.team_id)? {
                db::assign_role_to_member(conn, &member.id, &role.id)?;
            }

            // Increment invite usage.
            db::increment_invite_uses(conn, &invite.id)?;
            db::log_invite_use(conn, &invite.id, &user_id)?;

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

    Ok(Json(json!({
        "token": token,
        "user": user,
        "team_id": team_id,
    })))
}

pub async fn bootstrap(
    State(state): State<AppState>,
    Json(body): Json<BootstrapRequest>,
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

    if body.username.is_empty() {
        return Err(AppError::BadRequest("username is required".into()));
    }

    if body.bootstrap_token.is_empty() {
        return Err(AppError::BadRequest("bootstrap_token is required".into()));
    }

    let db = state.db.clone();
    let username = body.username.clone();
    let bootstrap_token = body.bootstrap_token.clone();
    let pk = pk_bytes.clone();
    let team_name = if body.team_name.is_empty() {
        state.config.team_name.clone()
    } else {
        body.team_name.clone()
    };
    let team_name = if team_name.is_empty() {
        "My Team".to_string()
    } else {
        team_name
    };

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            // Validate bootstrap token.
            let bt = db::get_bootstrap_token(conn, &bootstrap_token)?
                .ok_or_else(|| {
                    rusqlite::Error::InvalidParameterName("invalid bootstrap token".into())
                })?;

            if bt.used {
                return Err(rusqlite::Error::InvalidParameterName(
                    "bootstrap token already used".into(),
                ));
            }

            // Mark token as used.
            db::use_bootstrap_token(conn, &bootstrap_token)?;

            // Create admin user.
            let now = db::now_str();
            let user_id = db::new_id();
            let user = db::User {
                id: user_id.clone(),
                username: username.clone(),
                display_name: username.clone(),
                public_key: pk.to_vec(),
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: true,
                created_at: now.clone(),
                updated_at: now.clone(),
            };
            db::create_user(conn, &user)?;

            // Create team.
            let team_id = db::new_id();
            let team = db::Team {
                id: team_id.clone(),
                name: team_name,
                description: String::new(),
                icon_url: String::new(),
                created_by: user_id.clone(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                created_at: now.clone(),
                updated_at: now.clone(),
            };
            db::create_team(conn, &team)?;

            // Add user as team member.
            let member = db::Member {
                id: db::new_id(),
                team_id: team_id.clone(),
                user_id: user_id.clone(),
                nickname: String::new(),
                joined_at: now.clone(),
                invited_by: String::new(),
            };
            db::create_member(conn, &member)?;

            // Create default role.
            let role = db::Role {
                id: db::new_id(),
                team_id: team_id.clone(),
                name: "everyone".into(),
                color: "#99AAB5".into(),
                position: 0,
                permissions: db::PERM_SEND_MESSAGES | db::PERM_CREATE_INVITES,
                is_default: true,
                created_at: now.clone(),
            };
            db::create_role(conn, &role)?;

            // Create #general channel.
            let channel = db::Channel {
                id: db::new_id(),
                team_id: team_id.clone(),
                name: "general".into(),
                topic: "General discussion".into(),
                channel_type: "text".into(),
                position: 0,
                category: String::new(),
                created_by: user_id.clone(),
                created_at: now.clone(),
                updated_at: now.clone(),
            };
            db::create_channel(conn, &channel)?;

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

    Ok(Json(json!({
        "token": token,
        "user": user,
        "team_id": team_id,
    })))
}
