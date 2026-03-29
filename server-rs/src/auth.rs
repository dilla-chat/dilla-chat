use crate::db::{self, Database};
use crate::error::AppError;
use axum::{
    extract::Request,
    http::{self},
    middleware::Next,
    response::Response,
};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use hkdf::Hkdf;
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

/// Access token expiry: 1 hour.
const ACCESS_TOKEN_EXPIRY_SECS: i64 = 3600;

/// Refresh token expiry: 7 days.
const REFRESH_TOKEN_EXPIRY_SECS: i64 = 7 * 24 * 3600;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Claims {
    sub: String,
    iat: i64,
    exp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RefreshClaims {
    sub: String,
    iat: i64,
    exp: i64,
    token_type: String, // "refresh"
}

struct Challenge {
    nonce: Vec<u8>,
    created_at: Instant,
}

/// Derive the JWT signing secret from the DB passphrase using HKDF-SHA256.
/// If no passphrase is set (insecure mode), generate a random ephemeral secret
/// that is NOT persisted (lost on restart).
fn derive_jwt_secret(db_passphrase: &str) -> Vec<u8> {
    // Check for explicit JWT secret override (useful when DB is unencrypted
    // but you still want stable tokens across restarts).
    if let Ok(jwt_secret) = std::env::var("DILLA_JWT_SECRET") {
        if !jwt_secret.is_empty() {
            let hk = Hkdf::<Sha256>::new(None, jwt_secret.as_bytes());
            let mut secret = vec![0u8; 32];
            hk.expand(b"dilla-jwt-signing-key-v1", &mut secret)
                .expect("HKDF-SHA256 expand for 32 bytes should never fail");
            return secret;
        }
    }

    if db_passphrase.is_empty() {
        // Insecure mode: ephemeral random secret (lost on restart)
        let mut raw = vec![0u8; 32];
        rand::rng().fill_bytes(&mut raw);
        return raw;
    }
    // Derive from passphrase using HKDF-SHA256
    let hk = Hkdf::<Sha256>::new(None, db_passphrase.as_bytes());
    let mut secret = vec![0u8; 32];
    hk.expand(b"dilla-jwt-signing-key-v1", &mut secret)
        .expect("HKDF-SHA256 expand for 32 bytes should never fail");
    secret
}

#[derive(Clone)]
pub struct AuthService {
    db: Database,
    jwt_secret: Vec<u8>,
    challenges: Arc<RwLock<HashMap<String, Challenge>>>,
}

impl AuthService {
    pub fn new(database: Database, db_passphrase: &str) -> Self {
        let jwt_secret = derive_jwt_secret(db_passphrase);

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
        rand::rng().fill_bytes(&mut nonce);

        let mut id_bytes = vec![0u8; 16];
        rand::rng().fill_bytes(&mut id_bytes);
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
            exp: now + ACCESS_TOKEN_EXPIRY_SECS,
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

        // First try to decode and check it's not a refresh token.
        // We decode without requiring specific fields first to peek at token_type.
        let data = decode::<Claims>(
            token,
            &DecodingKey::from_secret(&self.jwt_secret),
            &validation,
        )
        .map_err(|e| AppError::Unauthorized(format!("invalid token: {}", e)))?;

        // Reject refresh tokens used as access tokens by trying to decode as RefreshClaims.
        let mut no_exp_validation = Validation::default();
        no_exp_validation.algorithms = vec![jsonwebtoken::Algorithm::HS256];
        no_exp_validation.validate_exp = false;
        if let Ok(refresh_data) = decode::<RefreshClaims>(
            token,
            &DecodingKey::from_secret(&self.jwt_secret),
            &no_exp_validation,
        ) {
            if refresh_data.claims.token_type == "refresh" {
                return Err(AppError::Unauthorized(
                    "refresh token cannot be used as access token".into(),
                ));
            }
        }

        Ok(data.claims.sub)
    }

    /// Generate a refresh token for the given user.
    pub fn generate_refresh_token(&self, user_id: &str) -> Result<String, AppError> {
        let now = chrono::Utc::now().timestamp();
        let claims = RefreshClaims {
            sub: user_id.to_string(),
            iat: now,
            exp: now + REFRESH_TOKEN_EXPIRY_SECS,
            token_type: "refresh".to_string(),
        };
        encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(&self.jwt_secret),
        )
        .map_err(|e| AppError::Internal(format!("jwt encode refresh: {}", e)))
    }

    /// Validate a refresh token and return the user_id.
    /// Rejects access tokens (those without token_type == "refresh").
    #[allow(dead_code)] // Public API for future use (token refresh endpoint)
    pub fn validate_refresh_token(&self, token: &str) -> Result<String, AppError> {
        let mut validation = Validation::default();
        validation.algorithms = vec![jsonwebtoken::Algorithm::HS256];

        let data = decode::<RefreshClaims>(
            token,
            &DecodingKey::from_secret(&self.jwt_secret),
            &validation,
        )
        .map_err(|e| AppError::Unauthorized(format!("invalid refresh token: {}", e)))?;

        if data.claims.token_type != "refresh" {
            return Err(AppError::Unauthorized(
                "token is not a refresh token".into(),
            ));
        }

        Ok(data.claims.sub)
    }

    /// Validate a refresh token and issue a new access token.
    #[allow(dead_code)] // Public API for future use (token refresh endpoint)
    pub fn refresh_access_token(&self, refresh_token: &str) -> Result<String, AppError> {
        let user_id = self.validate_refresh_token(refresh_token)?;
        self.generate_jwt(&user_id)
    }

    pub fn generate_bootstrap_token(&self) -> Result<String, AppError> {
        let mut bytes = vec![0u8; 32];
        rand::rng().fill_bytes(&mut bytes);
        let token = hex::encode(&bytes);
        self.db
            .with_conn(|conn| db::create_bootstrap_token(conn, &token))
            .map_err(|e| AppError::Internal(format!("store bootstrap token: {}", e)))?;
        Ok(token)
    }

    pub fn generate_invite_token(&self) -> String {
        let mut bytes = vec![0u8; 16];
        rand::rng().fill_bytes(&mut bytes);
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
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;"))
            .unwrap();
        db.run_migrations().unwrap();
        db
    }

    /// Create an AuthService without spawning the background cleanup task.
    /// We manually construct it to avoid requiring a tokio runtime for most tests.
    fn test_auth_service() -> AuthService {
        let db = test_db();
        let mut raw = vec![0u8; 32];
        rand::rng().fill_bytes(&mut raw);
        AuthService {
            db,
            jwt_secret: raw,
            challenges: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Create an AuthService using derive_jwt_secret with a passphrase.
    fn test_auth_service_with_passphrase(passphrase: &str) -> AuthService {
        let db = test_db();
        let jwt_secret = derive_jwt_secret(passphrase);
        AuthService {
            db,
            jwt_secret,
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
        let signing_key = {
                let mut key_bytes = [0u8; 32];
                rand::rng().fill_bytes(&mut key_bytes);
                SigningKey::from_bytes(&key_bytes)
            };
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

        let signing_key = {
                let mut key_bytes = [0u8; 32];
                rand::rng().fill_bytes(&mut key_bytes);
                SigningKey::from_bytes(&key_bytes)
            };
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

        let signing_key = {
                let mut key_bytes = [0u8; 32];
                rand::rng().fill_bytes(&mut key_bytes);
                SigningKey::from_bytes(&key_bytes)
            };
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

        let signing_key = {
                let mut key_bytes = [0u8; 32];
                rand::rng().fill_bytes(&mut key_bytes);
                SigningKey::from_bytes(&key_bytes)
            };
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
    fn test_jwt_contains_1_hour_expiry() {
        let auth = test_auth_service();
        let token = auth.generate_jwt("user-1").unwrap();

        // Decode without validation to inspect claims
        let data = jsonwebtoken::dangerous::insecure_decode::<Claims>(&token).unwrap();

        // Expiry should be 1 hour from iat
        let diff = data.claims.exp - data.claims.iat;
        assert_eq!(diff, 3600);
    }

    // ── Refresh token tests ─────────────────────────────────────────────

    #[test]
    fn test_generate_and_validate_refresh_token() {
        let auth = test_auth_service();
        let refresh = auth.generate_refresh_token("user-456").unwrap();

        let user_id = auth.validate_refresh_token(&refresh).unwrap();
        assert_eq!(user_id, "user-456");
    }

    #[test]
    fn test_refresh_token_has_7_day_expiry() {
        let auth = test_auth_service();
        let refresh = auth.generate_refresh_token("user-1").unwrap();

        let data = jsonwebtoken::dangerous::insecure_decode::<RefreshClaims>(&refresh).unwrap();

        let diff = data.claims.exp - data.claims.iat;
        assert_eq!(diff, 7 * 24 * 3600);
        assert_eq!(data.claims.token_type, "refresh");
    }

    #[test]
    fn test_refresh_token_cannot_be_used_as_access_token() {
        let auth = test_auth_service();
        let refresh = auth.generate_refresh_token("user-1").unwrap();

        let result = auth.validate_jwt(&refresh);
        assert!(result.is_err());
        assert!(
            format!("{:?}", result.unwrap_err()).contains("refresh token cannot be used as access")
        );
    }

    #[test]
    fn test_access_token_cannot_be_used_as_refresh_token() {
        let auth = test_auth_service();
        let access = auth.generate_jwt("user-1").unwrap();

        let result = auth.validate_refresh_token(&access);
        assert!(result.is_err());
    }

    #[test]
    fn test_refresh_access_token() {
        let auth = test_auth_service();
        let refresh = auth.generate_refresh_token("user-789").unwrap();

        let new_access = auth.refresh_access_token(&refresh).unwrap();
        let user_id = auth.validate_jwt(&new_access).unwrap();
        assert_eq!(user_id, "user-789");
    }

    #[test]
    fn test_refresh_access_token_rejects_access_token() {
        let auth = test_auth_service();
        let access = auth.generate_jwt("user-1").unwrap();

        let result = auth.refresh_access_token(&access);
        assert!(result.is_err());
    }

    // ── HKDF secret derivation tests ────────────────────────────────────

    #[test]
    fn test_derive_jwt_secret_with_passphrase_is_deterministic() {
        let s1 = derive_jwt_secret("my-secret-passphrase");
        let s2 = derive_jwt_secret("my-secret-passphrase");
        assert_eq!(s1, s2);
        assert_eq!(s1.len(), 32);
    }

    #[test]
    fn test_derive_jwt_secret_different_passphrases_differ() {
        let s1 = derive_jwt_secret("passphrase-a");
        let s2 = derive_jwt_secret("passphrase-b");
        assert_ne!(s1, s2);
    }

    #[test]
    fn test_derive_jwt_secret_empty_passphrase_is_random() {
        let s1 = derive_jwt_secret("");
        let s2 = derive_jwt_secret("");
        // Ephemeral random secrets should differ (with overwhelming probability)
        assert_ne!(s1, s2);
        assert_eq!(s1.len(), 32);
    }

    #[test]
    fn test_passphrase_derived_secret_produces_valid_tokens() {
        let auth = test_auth_service_with_passphrase("test-passphrase");
        let token = auth.generate_jwt("user-1").unwrap();
        let user_id = auth.validate_jwt(&token).unwrap();
        assert_eq!(user_id, "user-1");
    }

    #[test]
    fn test_same_passphrase_validates_across_instances() {
        let auth1 = test_auth_service_with_passphrase("shared-secret");
        let auth2 = test_auth_service_with_passphrase("shared-secret");

        let token = auth1.generate_jwt("user-1").unwrap();
        let user_id = auth2.validate_jwt(&token).unwrap();
        assert_eq!(user_id, "user-1");
    }

    // ── AuthService::new derives JWT secret from passphrase ─────────────

    #[tokio::test]
    async fn test_auth_service_new_with_passphrase_is_deterministic() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().to_str().unwrap();

        let db1 = Database::open(path, "test-pass").unwrap();
        db1.run_migrations().unwrap();
        let auth1 = AuthService::new(db1.clone(), "test-pass");
        let token = auth1.generate_jwt("test-user").unwrap();

        // Create a new AuthService with the same passphrase - should derive same secret
        let auth2 = AuthService::new(db1, "test-pass");
        let user_id = auth2.validate_jwt(&token).unwrap();
        assert_eq!(user_id, "test-user");
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

    // ── AuthService db() accessor ───────────────────────────────────────

    #[test]
    fn test_auth_service_db_accessor() {
        let auth = test_auth_service();
        // Verify we can access the database through the accessor
        let has_users = auth.db().has_users().unwrap();
        assert!(!has_users);
    }
}
