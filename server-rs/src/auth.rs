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

    #[allow(dead_code)]
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

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn test_db() -> Database {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
        db.run_migrations().unwrap();
        db
    }

    /// Create an AuthService without spawning the background cleanup task.
    /// We manually construct it to avoid requiring a tokio runtime for most tests.
    fn test_auth_service() -> AuthService {
        let db = test_db();
        let mut raw = vec![0u8; 32];
        rand::thread_rng().fill_bytes(&mut raw);
        AuthService {
            db,
            jwt_secret: raw,
            challenges: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    // ── Challenge tests ─────────────────────────────────────────────────

    #[test]
    fn test_generate_challenge_returns_nonce_and_id() {
        let auth = test_auth_service();
        let (nonce, challenge_id) = auth.generate_challenge().unwrap();

        assert_eq!(nonce.len(), 32);
        assert_eq!(challenge_id.len(), 32); // hex-encoded 16 bytes
        assert!(auth.challenges.read().unwrap().contains_key(&challenge_id));
    }

    #[test]
    fn test_generate_multiple_challenges_unique() {
        let auth = test_auth_service();
        let (n1, id1) = auth.generate_challenge().unwrap();
        let (n2, id2) = auth.generate_challenge().unwrap();

        assert_ne!(id1, id2);
        assert_ne!(n1, n2);
        assert_eq!(auth.challenges.read().unwrap().len(), 2);
    }

    #[test]
    fn test_verify_challenge_valid_signature() {
        let auth = test_auth_service();
        let (nonce, challenge_id) = auth.generate_challenge().unwrap();

        // Generate a keypair and sign the nonce
        let signing_key = SigningKey::generate(&mut rand::thread_rng());
        let verifying_key = signing_key.verifying_key();
        let signature = signing_key.sign(&nonce);

        let result = auth
            .verify_challenge(
                &challenge_id,
                verifying_key.as_bytes(),
                &signature.to_bytes(),
            )
            .unwrap();
        assert!(result);
    }

    #[test]
    fn test_verify_challenge_wrong_signature() {
        let auth = test_auth_service();
        let (_nonce, challenge_id) = auth.generate_challenge().unwrap();

        let signing_key = SigningKey::generate(&mut rand::thread_rng());
        let verifying_key = signing_key.verifying_key();
        // Sign wrong data
        let wrong_sig = signing_key.sign(b"wrong data");

        let result = auth
            .verify_challenge(
                &challenge_id,
                verifying_key.as_bytes(),
                &wrong_sig.to_bytes(),
            )
            .unwrap();
        assert!(!result);
    }

    #[test]
    fn test_verify_challenge_nonexistent_id() {
        let auth = test_auth_service();

        let signing_key = SigningKey::generate(&mut rand::thread_rng());
        let verifying_key = signing_key.verifying_key();
        let sig = signing_key.sign(b"data");

        let result = auth.verify_challenge(
            "nonexistent_id",
            verifying_key.as_bytes(),
            &sig.to_bytes(),
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_verify_challenge_consumed_after_use() {
        let auth = test_auth_service();
        let (nonce, challenge_id) = auth.generate_challenge().unwrap();

        let signing_key = SigningKey::generate(&mut rand::thread_rng());
        let verifying_key = signing_key.verifying_key();
        let signature = signing_key.sign(&nonce);

        // First verification succeeds
        auth.verify_challenge(
            &challenge_id,
            verifying_key.as_bytes(),
            &signature.to_bytes(),
        )
        .unwrap();

        // Second verification should fail (challenge consumed)
        let result = auth.verify_challenge(
            &challenge_id,
            verifying_key.as_bytes(),
            &signature.to_bytes(),
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_verify_challenge_invalid_public_key_length() {
        let auth = test_auth_service();
        let (_nonce, challenge_id) = auth.generate_challenge().unwrap();

        let result = auth.verify_challenge(
            &challenge_id,
            &[0u8; 16], // Wrong length
            &[0u8; 64],
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_verify_challenge_invalid_signature_length() {
        let auth = test_auth_service();
        let (_nonce, challenge_id) = auth.generate_challenge().unwrap();

        let result = auth.verify_challenge(
            &challenge_id,
            &[0u8; 32],
            &[0u8; 32], // Wrong length (should be 64)
        );
        assert!(result.is_err());
    }

    // ── JWT tests ───────────────────────────────────────────────────────

    #[test]
    fn test_generate_and_validate_jwt() {
        let auth = test_auth_service();
        let token = auth.generate_jwt("user-123").unwrap();

        let user_id = auth.validate_jwt(&token).unwrap();
        assert_eq!(user_id, "user-123");
    }

    #[test]
    fn test_validate_jwt_returns_correct_user_id() {
        let auth = test_auth_service();

        let t1 = auth.generate_jwt("alice").unwrap();
        let t2 = auth.generate_jwt("bob").unwrap();

        assert_eq!(auth.validate_jwt(&t1).unwrap(), "alice");
        assert_eq!(auth.validate_jwt(&t2).unwrap(), "bob");
    }

    #[test]
    fn test_validate_jwt_invalid_token() {
        let auth = test_auth_service();
        let result = auth.validate_jwt("not.a.valid.jwt");
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_jwt_wrong_secret() {
        let auth1 = test_auth_service();
        let auth2 = test_auth_service(); // Different secret

        let token = auth1.generate_jwt("user-1").unwrap();
        let result = auth2.validate_jwt(&token);
        assert!(result.is_err());
    }

    #[test]
    fn test_jwt_contains_correct_expiry() {
        let auth = test_auth_service();
        let token = auth.generate_jwt("user-1").unwrap();

        // Decode without validation to inspect claims
        let mut validation = jsonwebtoken::Validation::default();
        validation.insecure_disable_signature_validation();
        validation.validate_exp = false;
        let data = jsonwebtoken::decode::<Claims>(
            &token,
            &jsonwebtoken::DecodingKey::from_secret(&[]),
            &validation,
        )
        .unwrap();

        // Expiry should be ~7 days from now
        let diff = data.claims.exp - data.claims.iat;
        assert_eq!(diff, 7 * 24 * 3600);
    }

    // ── Bootstrap token tests ───────────────────────────────────────────

    #[tokio::test]
    async fn test_generate_bootstrap_token() {
        let auth = test_auth_service();
        let token = auth.generate_bootstrap_token().unwrap();

        assert_eq!(token.len(), 64); // hex-encoded 32 bytes

        // Token should be stored in DB
        let fetched = auth
            .db
            .with_conn(|c| db::get_bootstrap_token(c, &token))
            .unwrap()
            .unwrap();
        assert!(!fetched.used);
    }

    // ── Invite token tests ──────────────────────────────────────────────

    #[test]
    fn test_generate_invite_token() {
        let auth = test_auth_service();
        let t1 = auth.generate_invite_token();
        let t2 = auth.generate_invite_token();

        assert_eq!(t1.len(), 32); // hex-encoded 16 bytes
        assert_ne!(t1, t2);
    }

    // ── Challenge cleanup test ──────────────────────────────────────────

    #[test]
    fn test_challenge_cleanup_removes_expired() {
        let auth = test_auth_service();

        // Manually insert an expired challenge
        auth.challenges.write().unwrap().insert(
            "expired".to_string(),
            Challenge {
                nonce: vec![0u8; 32],
                created_at: Instant::now() - Duration::from_secs(400), // > 360s
            },
        );

        // Insert a fresh one
        auth.challenges.write().unwrap().insert(
            "fresh".to_string(),
            Challenge {
                nonce: vec![1u8; 32],
                created_at: Instant::now(),
            },
        );

        // Simulate cleanup logic
        {
            let mut map = auth.challenges.write().unwrap();
            map.retain(|_, c| c.created_at.elapsed() < Duration::from_secs(360));
        }

        let map = auth.challenges.read().unwrap();
        assert!(!map.contains_key("expired"));
        assert!(map.contains_key("fresh"));
    }

    // ── AuthService::new persists JWT secret ────────────────────────────

    #[tokio::test]
    async fn test_auth_service_persists_jwt_secret() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().to_str().unwrap();

        let db1 = Database::open(path, "").unwrap();
        db1.run_migrations().unwrap();
        let auth1 = AuthService::new(db1.clone());
        let token = auth1.generate_jwt("test-user").unwrap();

        // Create a new AuthService with the same DB - it should load the same secret
        let auth2 = AuthService::new(db1);
        let user_id = auth2.validate_jwt(&token).unwrap();
        assert_eq!(user_id, "test-user");
    }

    // ── AuthService db() accessor ───────────────────────────────────────

    #[test]
    fn test_auth_service_db_accessor() {
        let auth = test_auth_service();
        // Verify we can access the database through the accessor
        let has_users = auth.db().has_users().unwrap();
        assert!(!has_users);
    }
}
