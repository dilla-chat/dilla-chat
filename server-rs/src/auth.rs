use crate::db::{self, Database};
use crate::error::AppError;
use axum::{
    extract::Request,
    http::{self},
    middleware::Next,
    response::Response,
};
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Claims {
    sub: String,
    iat: i64,
    exp: i64,
}

struct Challenge {
    nonce: Vec<u8>,
    created_at: Instant,
}

#[derive(Clone)]
pub struct AuthService {
    db: Database,
    jwt_secret: Vec<u8>,
    challenges: Arc<RwLock<HashMap<String, Challenge>>>,
}

impl AuthService {
    pub fn new(database: Database) -> Self {
        // Load or generate JWT secret.
        let secret = database
            .with_conn(|conn| db::get_setting(conn, "jwt_secret"))
            .ok()
            .flatten();

        let jwt_secret = if let Some(s) = secret {
            base64::engine::general_purpose::STANDARD
                .decode(&s)
                .unwrap_or_else(|_| {
                    let mut raw = vec![0u8; 32];
                    rand::thread_rng().fill_bytes(&mut raw);
                    raw
                })
        } else {
            let mut raw = vec![0u8; 32];
            rand::thread_rng().fill_bytes(&mut raw);
            let encoded = base64::engine::general_purpose::STANDARD.encode(&raw);
            let _ = database.with_conn(|conn| db::set_setting(conn, "jwt_secret", &encoded));
            raw
        };

        let svc = AuthService {
            db: database,
            jwt_secret,
            challenges: Arc::new(RwLock::new(HashMap::new())),
        };

        // Spawn background challenge cleanup.
        let challenges = svc.challenges.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(300)).await;
                let mut map = challenges.write().unwrap();
                map.retain(|_, c| c.created_at.elapsed() < Duration::from_secs(360));
            }
        });

        svc
    }

    pub fn generate_challenge(&self) -> Result<(Vec<u8>, String), AppError> {
        let mut nonce = vec![0u8; 32];
        rand::thread_rng().fill_bytes(&mut nonce);

        let mut id_bytes = vec![0u8; 16];
        rand::thread_rng().fill_bytes(&mut id_bytes);
        let challenge_id = hex::encode(&id_bytes);

        self.challenges.write().unwrap().insert(
            challenge_id.clone(),
            Challenge {
                nonce: nonce.clone(),
                created_at: Instant::now(),
            },
        );

        Ok((nonce, challenge_id))
    }

    pub fn verify_challenge(
        &self,
        challenge_id: &str,
        public_key: &[u8],
        signature: &[u8],
    ) -> Result<bool, AppError> {
        let challenge = self
            .challenges
            .write()
            .unwrap()
            .remove(challenge_id)
            .ok_or_else(|| AppError::Unauthorized("challenge not found or expired".into()))?;

        if challenge.created_at.elapsed() > Duration::from_secs(300) {
            return Err(AppError::Unauthorized("challenge expired".into()));
        }

        let key_bytes: [u8; 32] = public_key
            .try_into()
            .map_err(|_| AppError::BadRequest("invalid public key length".into()))?;
        let verifying_key = VerifyingKey::from_bytes(&key_bytes)
            .map_err(|_| AppError::BadRequest("invalid public key".into()))?;

        let sig_bytes: [u8; 64] = signature
            .try_into()
            .map_err(|_| AppError::BadRequest("invalid signature length".into()))?;
        let sig = Signature::from_bytes(&sig_bytes);

        Ok(verifying_key.verify(&challenge.nonce, &sig).is_ok())
    }

    pub fn generate_jwt(&self, user_id: &str) -> Result<String, AppError> {
        let now = chrono::Utc::now().timestamp();
        let claims = Claims {
            sub: user_id.to_string(),
            iat: now,
            exp: now + 7 * 24 * 3600,
        };
        encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(&self.jwt_secret),
        )
        .map_err(|e| AppError::Internal(format!("jwt encode: {}", e)))
    }

    pub fn validate_jwt(&self, token: &str) -> Result<String, AppError> {
        let mut validation = Validation::default();
        validation.algorithms = vec![jsonwebtoken::Algorithm::HS256];

        let data = decode::<Claims>(
            token,
            &DecodingKey::from_secret(&self.jwt_secret),
            &validation,
        )
        .map_err(|e| AppError::Unauthorized(format!("invalid token: {}", e)))?;

        Ok(data.claims.sub)
    }

    pub fn generate_bootstrap_token(&self) -> Result<String, AppError> {
        let mut bytes = vec![0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        let token = hex::encode(&bytes);
        self.db
            .with_conn(|conn| db::create_bootstrap_token(conn, &token))
            .map_err(|e| AppError::Internal(format!("store bootstrap token: {}", e)))?;
        Ok(token)
    }

    pub fn generate_invite_token(&self) -> String {
        let mut bytes = vec![0u8; 16];
        rand::thread_rng().fill_bytes(&mut bytes);
        hex::encode(&bytes)
    }

    pub fn db(&self) -> &Database {
        &self.db
    }
}

/// Axum middleware that validates JWT from Authorization header.
pub async fn auth_middleware(
    auth: axum::extract::Extension<Arc<AuthService>>,
    mut req: Request,
    next: Next,
) -> Result<Response, AppError> {
    let auth_header = req
        .headers()
        .get(http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::Unauthorized("missing authorization header".into()))?;

    let token = auth_header
        .strip_prefix("Bearer ")
        .ok_or_else(|| AppError::Unauthorized("invalid authorization format".into()))?;

    let user_id = auth.validate_jwt(token)?;

    req.extensions_mut().insert(UserId(user_id));
    Ok(next.run(req).await)
}

#[derive(Debug, Clone)]
pub struct UserId(pub String);
