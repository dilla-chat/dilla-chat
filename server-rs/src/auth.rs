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

/// Refresh token expiry: 24 hours. H2 / VULN-012: reduced from 7 days
/// so a stolen refresh token has at most a one-day blast radius before
/// the natural exp kicks in.
const REFRESH_TOKEN_EXPIRY_SECS: i64 = 24 * 3600;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Claims {
    sub: String,
    iat: i64,
    exp: i64,
    /// JWT id — random 128-bit UUID. H2 / VULN-012: lets the
    /// revocation list reject a token before its natural expiry.
    #[serde(default)]
    jti: String,
    /// Audience — pinned to this node's `node_name` so a token minted
    /// for one node won't validate when replayed at another (assuming
    /// node names diverge). H2 / VULN-012.
    #[serde(default)]
    aud: String,
    /// Issuer — same value as `aud` so it survives a re-handshake of
    /// node identity without invalidating in-flight sessions.
    #[serde(default)]
    iss: String,
    /// A1 / AUTH-MULTIDEV-1: device_id of the enrolled device that
    /// presented this credential. Empty for legacy tokens minted
    /// before multi-device rolled out.
    #[serde(default)]
    did: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RefreshClaims {
    sub: String,
    iat: i64,
    exp: i64,
    token_type: String, // "refresh"
    #[serde(default)]
    jti: String,
    #[serde(default)]
    aud: String,
    #[serde(default)]
    iss: String,
    /// A1: same device_id binding as the access token.
    #[serde(default)]
    did: String,
}

struct Challenge {
    nonce: Vec<u8>,
    created_at: Instant,
}

/// A short-lived, single-use WebSocket ticket.
/// Used instead of passing JWT tokens in WebSocket URLs.
struct WsTicket {
    user_id: String,
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
    ws_tickets: Arc<RwLock<HashMap<String, WsTicket>>>,
    /// Node name — pinned into `aud` + `iss` so tokens minted by this
    /// node only validate at this node. H2 / VULN-012.
    node_name: String,
}

impl AuthService {
    pub fn new(database: Database, db_passphrase: &str) -> Self {
        Self::with_node_name(database, db_passphrase, String::new())
    }

    pub fn with_node_name(database: Database, db_passphrase: &str, node_name: String) -> Self {
        let jwt_secret = derive_jwt_secret(db_passphrase);

        let svc = AuthService {
            db: database,
            jwt_secret,
            challenges: Arc::new(RwLock::new(HashMap::new())),
            ws_tickets: Arc::new(RwLock::new(HashMap::new())),
            node_name,
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
        self.generate_jwt_for_device(user_id, "")
    }

    /// A1: generate an access token bound to a specific device_id. The
    /// device_id is empty for the legacy verify path (pre-multi-device
    /// rollout) — those tokens still validate.
    pub fn generate_jwt_for_device(
        &self,
        user_id: &str,
        device_id: &str,
    ) -> Result<String, AppError> {
        let now = chrono::Utc::now().timestamp();
        let claims = Claims {
            sub: user_id.to_string(),
            iat: now,
            exp: now + ACCESS_TOKEN_EXPIRY_SECS,
            jti: uuid::Uuid::new_v4().to_string(),
            aud: self.node_name.clone(),
            iss: self.node_name.clone(),
            did: device_id.to_string(),
        };
        encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(&self.jwt_secret),
        )
        .map_err(|e| AppError::Internal(format!("jwt encode: {}", e)))
    }

    pub fn validate_jwt(&self, token: &str) -> Result<String, AppError> {
        let (sub, _jti, _exp, _did) = self.validate_jwt_full(token)?;
        Ok(sub)
    }

    /// A1: validate and return (user_id, device_id). Device_id is empty
    /// for legacy tokens that predate multi-device.
    #[allow(dead_code)]
    pub fn validate_jwt_with_device(&self, token: &str) -> Result<(String, String), AppError> {
        let (sub, _jti, _exp, did) = self.validate_jwt_full(token)?;
        Ok((sub, did))
    }

    /// Build the JWT validation config used by validate_jwt_full,
    /// honoring the per-node aud/iss pinning when node_name is set.
    fn access_token_validation(&self) -> Validation {
        let mut validation = Validation::default();
        validation.algorithms = vec![jsonwebtoken::Algorithm::HS256];
        if !self.node_name.is_empty() {
            validation.set_audience(&[&self.node_name]);
            validation.set_issuer(&[&self.node_name]);
        } else {
            validation.validate_aud = false;
        }
        validation
    }

    /// Reject the token if it's actually a refresh token presented as an
    /// access token (peek at `token_type` via the RefreshClaims shape).
    fn reject_if_refresh_token(&self, token: &str) -> Result<(), AppError> {
        let mut no_exp_validation = Validation::default();
        no_exp_validation.algorithms = vec![jsonwebtoken::Algorithm::HS256];
        no_exp_validation.validate_exp = false;
        no_exp_validation.validate_aud = false;
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
        Ok(())
    }

    /// Check the revocation list for the given jti. Empty jti (legacy
    /// pre-H2 tokens without a jti claim) passes; newly minted tokens
    /// always carry one.
    fn assert_jti_not_revoked(&self, jti: &str) -> Result<(), AppError> {
        if jti.is_empty() {
            return Ok(());
        }
        let jti_q = jti.to_string();
        let revoked = self
            .db
            .with_read(|conn| db::is_revoked(conn, &jti_q))
            .map_err(|e| AppError::Internal(format!("revocation lookup: {}", e)))?;
        if revoked {
            return Err(AppError::Unauthorized("token revoked".into()));
        }
        Ok(())
    }

    /// A4: per-device force-logout — reject the token when the device
    /// row says it's inactive or was invalidated after the token was
    /// issued. Empty `did` (legacy) skips the check.
    fn assert_device_not_invalidated(&self, did: &str, iat: i64) -> Result<(), AppError> {
        if did.is_empty() {
            return Ok(());
        }
        let did_q = did.to_string();
        let device = self
            .db
            .with_read(|conn| db::get_device_by_id(conn, &did_q))
            .map_err(|e| AppError::Internal(format!("device lookup: {}", e)))?;
        if let Some(d) = device {
            if !d.is_active() {
                return Err(AppError::Unauthorized("device revoked".into()));
            }
            if iat < d.tokens_invalidated_after {
                return Err(AppError::Unauthorized(
                    "token superseded — re-authenticate".into(),
                ));
            }
        }
        Ok(())
    }

    /// Validate a JWT and return (sub, jti, exp, device_id). Used by
    /// the logout handler so it can revoke the *exact* token presented
    /// and by handlers that need device context.
    pub fn validate_jwt_full(&self, token: &str) -> Result<(String, String, i64, String), AppError> {
        let validation = self.access_token_validation();
        let data = decode::<Claims>(
            token,
            &DecodingKey::from_secret(&self.jwt_secret),
            &validation,
        )
        .map_err(|e| AppError::Unauthorized(format!("invalid token: {}", e)))?;

        self.reject_if_refresh_token(token)?;

        let jti = data.claims.jti.clone();
        self.assert_jti_not_revoked(&jti)?;
        self.assert_device_not_invalidated(&data.claims.did, data.claims.iat)?;

        Ok((data.claims.sub, jti, data.claims.exp, data.claims.did))
    }

    /// Revoke the supplied JWT by inserting its `jti` into the
    /// revocation list. Returns ok even if the token was already
    /// revoked so the logout endpoint is idempotent.
    pub fn revoke_token(&self, token: &str) -> Result<(), AppError> {
        // We need to be able to revoke the token even if it has just
        // been rotated server-side (e.g. immediately after issue), so
        // decode without enforcing aud/iss strictly — but still require
        // signature validity to prevent a denial-of-service via writing
        // garbage jtis to the revocation table.
        let mut validation = Validation::default();
        validation.algorithms = vec![jsonwebtoken::Algorithm::HS256];
        validation.validate_aud = false;
        validation.validate_exp = false;

        let data = decode::<Claims>(
            token,
            &DecodingKey::from_secret(&self.jwt_secret),
            &validation,
        )
        .map_err(|e| AppError::Unauthorized(format!("invalid token: {}", e)))?;

        let jti = data.claims.jti;
        let exp = data.claims.exp;
        if jti.is_empty() {
            // Legacy / pre-H2 token without a jti — nothing to record.
            // Returning Ok matches the idempotent semantics of logout.
            return Ok(());
        }
        self.db
            .with_conn(|conn| db::revoke_jti(conn, &jti, exp))
            .map_err(|e| AppError::Internal(format!("revoke: {}", e)))?;
        Ok(())
    }

    /// Generate a refresh token for the given user.
    pub fn generate_refresh_token(&self, user_id: &str) -> Result<String, AppError> {
        self.generate_refresh_token_for_device(user_id, "")
    }

    /// A1: refresh-token variant bound to a device_id. The device_id is
    /// preserved across sliding renewals so a stolen-then-rotated
    /// refresh token can be tied back to the originating device.
    pub fn generate_refresh_token_for_device(
        &self,
        user_id: &str,
        device_id: &str,
    ) -> Result<String, AppError> {
        let now = chrono::Utc::now().timestamp();
        let claims = RefreshClaims {
            sub: user_id.to_string(),
            iat: now,
            exp: now + REFRESH_TOKEN_EXPIRY_SECS,
            token_type: "refresh".to_string(),
            jti: uuid::Uuid::new_v4().to_string(),
            aud: self.node_name.clone(),
            iss: self.node_name.clone(),
            did: device_id.to_string(),
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
        let (sub, _iat, _exp, _jti, _did) = self.validate_refresh_token_full(token)?;
        Ok(sub)
    }

    /// A4: full refresh-token introspection. Returns
    /// (user_id, iat, exp, jti, device_id) so the caller can decide
    /// whether to rotate (sliding renewal) and which device to bind
    /// the new tokens to.
    pub fn validate_refresh_token_full(
        &self,
        token: &str,
    ) -> Result<(String, i64, i64, String, String), AppError> {
        let mut validation = Validation::default();
        validation.algorithms = vec![jsonwebtoken::Algorithm::HS256];
        if !self.node_name.is_empty() {
            validation.set_audience(&[&self.node_name]);
            validation.set_issuer(&[&self.node_name]);
        } else {
            validation.validate_aud = false;
        }

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

        // Revocation check (refresh tokens are also revocable).
        if !data.claims.jti.is_empty() {
            let jti = data.claims.jti.clone();
            let revoked = self
                .db
                .with_read(|conn| db::is_revoked(conn, &jti))
                .map_err(|e| AppError::Internal(format!("revocation lookup: {}", e)))?;
            if revoked {
                return Err(AppError::Unauthorized("refresh token revoked".into()));
            }
        }

        Ok((
            data.claims.sub,
            data.claims.iat,
            data.claims.exp,
            data.claims.jti,
            data.claims.did,
        ))
    }

    /// Validate a refresh token and issue a new access token.
    #[allow(dead_code)] // Public API for future use (token refresh endpoint)
    pub fn refresh_access_token(&self, refresh_token: &str) -> Result<String, AppError> {
        let user_id = self.validate_refresh_token(refresh_token)?;
        self.generate_jwt(&user_id)
    }

    /// A4 — Sliding refresh. Validate `refresh_token` and:
    /// - Always mint a fresh access token (1h life).
    /// - If the refresh token is within the **last 12 hours** of its 24h
    ///   life, rotate it: revoke the old jti and mint a new 24h refresh
    ///   token. Otherwise, return the old refresh token unchanged.
    ///
    /// Returns `(access_token, refresh_token, rotated)`. The `rotated`
    /// flag lets callers (and tests) tell whether a fresh refresh
    /// token was issued. The new tokens carry the same `device_id` as
    /// the old refresh token, so a per-device session view stays
    /// consistent.
    pub fn refresh_with_sliding(
        &self,
        refresh_token: &str,
    ) -> Result<(String, String, bool), AppError> {
        let (user_id, _iat, exp, old_jti, device_id) =
            self.validate_refresh_token_full(refresh_token)?;

        let access = self.generate_jwt_for_device(&user_id, &device_id)?;

        let now = chrono::Utc::now().timestamp();
        let remaining = exp - now;
        // Rotate when at least half the lifetime has elapsed (≤ 12h
        // left out of a 24h window). This bounds the blast radius of a
        // stolen refresh token to one half-life.
        let rotate = remaining <= REFRESH_TOKEN_EXPIRY_SECS / 2;

        if rotate {
            // Mint the new refresh token *before* revoking the old one
            // so a transient DB error doesn't leave the user with no
            // refresh credential.
            let new_refresh =
                self.generate_refresh_token_for_device(&user_id, &device_id)?;
            // Best-effort revoke — if it fails, the rotation succeeded
            // but the old jti will simply live to its natural exp.
            if !old_jti.is_empty() {
                let _ = self
                    .db
                    .with_conn(|conn| db::revoke_jti(conn, &old_jti, exp));
            }
            Ok((access, new_refresh, true))
        } else {
            Ok((access, refresh_token.to_string(), false))
        }
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

    /// Generate a single-use WebSocket ticket for the given user.
    /// Ticket expires in 30 seconds and is consumed on first use.
    pub fn generate_ws_ticket(&self, user_id: &str) -> String {
        let mut bytes = vec![0u8; 32];
        rand::rng().fill_bytes(&mut bytes);
        let ticket = hex::encode(&bytes);
        self.ws_tickets.write().unwrap().insert(
            ticket.clone(),
            WsTicket {
                user_id: user_id.to_string(),
                created_at: Instant::now(),
            },
        );
        ticket
    }

    /// Validate and consume a WebSocket ticket. Returns the user_id if valid.
    /// Tickets are single-use (consumed on validation) and expire after 30 seconds.
    pub fn validate_ws_ticket(&self, ticket: &str) -> Result<String, AppError> {
        let ws_ticket = self
            .ws_tickets
            .write()
            .unwrap()
            .remove(ticket)
            .ok_or_else(|| AppError::Unauthorized("invalid or expired ws ticket".into()))?;

        if ws_ticket.created_at.elapsed() > Duration::from_secs(30) {
            return Err(AppError::Unauthorized("ws ticket expired".into()));
        }

        Ok(ws_ticket.user_id)
    }

    /// Clean up expired WebSocket tickets (older than 30 seconds).
    /// Call periodically from a background task.
    pub fn cleanup_expired_ws_tickets(&self) -> usize {
        let mut tickets = self.ws_tickets.write().unwrap();
        let before = tickets.len();
        tickets.retain(|_, t| t.created_at.elapsed() < Duration::from_secs(30));
        before - tickets.len()
    }

    /// Get the number of pending WebSocket tickets.
    pub fn ws_ticket_count(&self) -> usize {
        self.ws_tickets.read().unwrap().len()
    }

    /// Check if a WS ticket is valid without consuming it (for diagnostics).
    pub fn is_ws_ticket_valid(&self, ticket: &str) -> bool {
        self.ws_tickets
            .read()
            .unwrap()
            .get(ticket)
            .is_some_and(|t| t.created_at.elapsed() < Duration::from_secs(30))
    }

    /// Generate a WS ticket and return it along with metadata for logging.
    pub fn generate_ws_ticket_with_expiry(&self, user_id: &str) -> (String, u64) {
        let ticket = self.generate_ws_ticket(user_id);
        (ticket, 30) // 30 second expiry
    }

    /// Get the remaining validity of a WS ticket in seconds (0 if expired/missing).
    pub fn ws_ticket_ttl(&self, ticket: &str) -> u64 {
        self.ws_tickets
            .read()
            .unwrap()
            .get(ticket)
            .map(|t| {
                let elapsed = t.created_at.elapsed().as_secs();
                30_u64.saturating_sub(elapsed)
            })
            .unwrap_or(0)
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

/// Axum middleware that validates JWT from the `Authorization: Bearer`
/// header. H-13a: when the header is absent, also accept the
/// `__dilla_jwt` httpOnly cookie issued by `verify` / `refresh`. The
/// header path wins when both are present (lets clients explicitly
/// pin a non-cookie token, e.g. for cross-origin requests where the
/// cookie wouldn't travel anyway).
pub async fn auth_middleware(
    auth: axum::extract::Extension<Arc<AuthService>>,
    mut req: Request,
    next: Next,
) -> Result<Response, AppError> {
    let token = if let Some(hv) = req.headers().get(http::header::AUTHORIZATION) {
        let raw = hv
            .to_str()
            .map_err(|_| AppError::Unauthorized("invalid authorization format".into()))?;
        raw.strip_prefix("Bearer ")
            .ok_or_else(|| AppError::Unauthorized("invalid authorization format".into()))?
            .to_string()
    } else if let Some(tok) = extract_auth_cookie(req.headers()) {
        tok
    } else {
        return Err(AppError::Unauthorized(
            "missing authorization header".into(),
        ));
    };

    let user_id = auth.validate_jwt(&token)?;

    req.extensions_mut().insert(UserId(user_id));
    Ok(next.run(req).await)
}

/// H-13a: extract the `__dilla_jwt` token from the request's Cookie
/// header, if any. Returns None when the cookie is missing or the
/// header is malformed. Tolerant of multiple cookies and arbitrary
/// whitespace per RFC 6265 §5.4.
fn extract_auth_cookie(headers: &http::HeaderMap) -> Option<String> {
    const COOKIE_NAME: &str = "__dilla_jwt";
    let raw = headers.get(http::header::COOKIE)?.to_str().ok()?;
    for pair in raw.split(';') {
        let pair = pair.trim();
        if let Some(rest) = pair.strip_prefix(COOKIE_NAME) {
            if let Some(value) = rest.strip_prefix('=') {
                if value.is_empty() {
                    return None;
                }
                return Some(value.to_string());
            }
        }
    }
    None
}

#[derive(Debug, Clone)]
pub struct UserId(pub String);

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use std::sync::Mutex;

    /// Global mutex to prevent env var test races (env vars are process-global).
    static ENV_LOCK: Mutex<()> = Mutex::new(());

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
            ws_tickets: Arc::new(RwLock::new(HashMap::new())),
            node_name: String::new(),
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
            ws_tickets: Arc::new(RwLock::new(HashMap::new())),
            node_name: String::new(),
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
    fn test_refresh_token_has_24h_expiry() {
        // H2 / VULN-012: refresh expiry reduced from 7 days to 24h to
        // bound the blast radius of a stolen refresh token.
        let auth = test_auth_service();
        let refresh = auth.generate_refresh_token("user-1").unwrap();

        let data = jsonwebtoken::dangerous::insecure_decode::<RefreshClaims>(&refresh).unwrap();

        let diff = data.claims.exp - data.claims.iat;
        assert_eq!(diff, 24 * 3600);
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
        let _guard = ENV_LOCK.lock().unwrap();
        let s1 = derive_jwt_secret("my-secret-passphrase");
        let s2 = derive_jwt_secret("my-secret-passphrase");
        assert_eq!(s1, s2);
        assert_eq!(s1.len(), 32);
    }

    #[test]
    fn test_derive_jwt_secret_different_passphrases_differ() {
        let _guard = ENV_LOCK.lock().unwrap();
        let s1 = derive_jwt_secret("passphrase-a");
        let s2 = derive_jwt_secret("passphrase-b");
        assert_ne!(s1, s2);
    }

    #[test]
    fn test_derive_jwt_secret_empty_passphrase_is_random() {
        let _guard = ENV_LOCK.lock().unwrap();
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

    // ── H2 / VULN-012 tests ─────────────────────────────────────────────

    #[test]
    fn test_jwt_contains_jti_aud_iss() {
        let auth = AuthService {
            db: test_db(),
            jwt_secret: vec![1u8; 32],
            challenges: Arc::new(RwLock::new(HashMap::new())),
            ws_tickets: Arc::new(RwLock::new(HashMap::new())),
            node_name: "node-test".into(),
        };
        let token = auth.generate_jwt("user-1").unwrap();
        let data = jsonwebtoken::dangerous::insecure_decode::<Claims>(&token).unwrap();
        assert!(!data.claims.jti.is_empty());
        assert_eq!(data.claims.aud, "node-test");
        assert_eq!(data.claims.iss, "node-test");
    }

    #[test]
    fn test_jwt_validates_with_matching_node_name() {
        let auth = AuthService {
            db: test_db(),
            jwt_secret: vec![1u8; 32],
            challenges: Arc::new(RwLock::new(HashMap::new())),
            ws_tickets: Arc::new(RwLock::new(HashMap::new())),
            node_name: "alpha".into(),
        };
        let token = auth.generate_jwt("u").unwrap();
        assert_eq!(auth.validate_jwt(&token).unwrap(), "u");
    }

    #[test]
    fn test_jwt_rejected_when_aud_mismatches() {
        let db = test_db();
        let auth_alpha = AuthService {
            db: db.clone(),
            jwt_secret: vec![1u8; 32],
            challenges: Arc::new(RwLock::new(HashMap::new())),
            ws_tickets: Arc::new(RwLock::new(HashMap::new())),
            node_name: "alpha".into(),
        };
        let auth_beta = AuthService {
            db,
            jwt_secret: vec![1u8; 32],
            challenges: Arc::new(RwLock::new(HashMap::new())),
            ws_tickets: Arc::new(RwLock::new(HashMap::new())),
            node_name: "beta".into(),
        };
        let token = auth_alpha.generate_jwt("u").unwrap();
        // Same signing secret but different node names — beta must
        // reject a token minted with aud="alpha".
        assert!(auth_beta.validate_jwt(&token).is_err());
    }

    #[test]
    fn test_revoke_token_blocks_validation() {
        let auth = AuthService {
            db: test_db(),
            jwt_secret: vec![1u8; 32],
            challenges: Arc::new(RwLock::new(HashMap::new())),
            ws_tickets: Arc::new(RwLock::new(HashMap::new())),
            node_name: "node-test".into(),
        };
        let token = auth.generate_jwt("u").unwrap();
        assert!(auth.validate_jwt(&token).is_ok());

        auth.revoke_token(&token).unwrap();
        let err = auth.validate_jwt(&token).unwrap_err();
        let msg = format!("{:?}", err);
        assert!(msg.contains("revoked"), "expected revoked error, got: {msg}");
    }

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

    // ── WebSocket ticket tests ──────────────────────────────────────────

    #[test]
    fn test_generate_ws_ticket() {
        let auth = test_auth_service();
        let ticket = auth.generate_ws_ticket("user-42");
        assert_eq!(ticket.len(), 64); // 32 bytes hex
        assert!(auth.ws_tickets.read().unwrap().contains_key(&ticket));
    }

    #[test]
    fn test_validate_ws_ticket_success() {
        let auth = test_auth_service();
        let ticket = auth.generate_ws_ticket("user-42");
        let user_id = auth.validate_ws_ticket(&ticket).unwrap();
        assert_eq!(user_id, "user-42");
        // Ticket is consumed — second use should fail
        assert!(auth.validate_ws_ticket(&ticket).is_err());
    }

    #[test]
    fn test_validate_ws_ticket_invalid() {
        let auth = test_auth_service();
        assert!(auth.validate_ws_ticket("nonexistent-ticket").is_err());
    }

    #[test]
    fn test_validate_ws_ticket_expired() {
        let auth = test_auth_service();
        // Insert a ticket that's already expired
        auth.ws_tickets.write().unwrap().insert(
            "expired-ticket".to_string(),
            WsTicket {
                user_id: "user-1".to_string(),
                created_at: Instant::now() - Duration::from_secs(60),
            },
        );
        assert!(auth.validate_ws_ticket("expired-ticket").is_err());
    }

    #[test]
    fn test_ws_ticket_count() {
        let auth = test_auth_service();
        assert_eq!(auth.ws_ticket_count(), 0);
        auth.generate_ws_ticket("u1");
        assert_eq!(auth.ws_ticket_count(), 1);
        auth.generate_ws_ticket("u2");
        assert_eq!(auth.ws_ticket_count(), 2);
    }

    #[test]
    fn test_cleanup_expired_ws_tickets() {
        let auth = test_auth_service();

        // Insert a fresh ticket
        auth.generate_ws_ticket("fresh-user");

        // Insert an expired ticket manually
        auth.ws_tickets.write().unwrap().insert(
            "expired-1".to_string(),
            WsTicket {
                user_id: "expired-user".to_string(),
                created_at: Instant::now() - Duration::from_secs(60),
            },
        );

        assert_eq!(auth.ws_ticket_count(), 2);
        let removed = auth.cleanup_expired_ws_tickets();
        assert_eq!(removed, 1);
        assert_eq!(auth.ws_ticket_count(), 1);
    }

    #[test]
    fn test_cleanup_no_expired_tickets() {
        let auth = test_auth_service();
        auth.generate_ws_ticket("u1");
        auth.generate_ws_ticket("u2");
        let removed = auth.cleanup_expired_ws_tickets();
        assert_eq!(removed, 0);
        assert_eq!(auth.ws_ticket_count(), 2);
    }

    #[test]
    fn test_is_ws_ticket_valid() {
        let auth = test_auth_service();
        let ticket = auth.generate_ws_ticket("u1");
        assert!(auth.is_ws_ticket_valid(&ticket));
        assert!(!auth.is_ws_ticket_valid("nonexistent"));
    }

    #[test]
    fn test_ws_ticket_ttl_fresh() {
        let auth = test_auth_service();
        let ticket = auth.generate_ws_ticket("u1");
        let ttl = auth.ws_ticket_ttl(&ticket);
        assert!(ttl > 0 && ttl <= 30);
    }

    #[test]
    fn test_ws_ticket_ttl_missing() {
        let auth = test_auth_service();
        assert_eq!(auth.ws_ticket_ttl("nonexistent"), 0);
    }

    #[test]
    fn test_ws_ticket_ttl_expired() {
        let auth = test_auth_service();
        auth.ws_tickets.write().unwrap().insert(
            "old".to_string(),
            WsTicket {
                user_id: "u1".to_string(),
                created_at: Instant::now() - Duration::from_secs(60),
            },
        );
        assert_eq!(auth.ws_ticket_ttl("old"), 0);
    }

    #[test]
    fn test_generate_ws_ticket_with_expiry() {
        let auth = test_auth_service();
        let (ticket, expiry) = auth.generate_ws_ticket_with_expiry("u1");
        assert_eq!(ticket.len(), 64);
        assert_eq!(expiry, 30);
        // Ticket should be valid
        assert!(auth.is_ws_ticket_valid(&ticket));
    }

    #[test]
    fn test_is_ws_ticket_valid_expired() {
        let auth = test_auth_service();
        auth.ws_tickets.write().unwrap().insert(
            "old-ticket".to_string(),
            WsTicket {
                user_id: "u1".to_string(),
                created_at: Instant::now() - Duration::from_secs(60),
            },
        );
        assert!(!auth.is_ws_ticket_valid("old-ticket"));
    }

    #[test]
    fn test_ws_ticket_unique() {
        let auth = test_auth_service();
        let t1 = auth.generate_ws_ticket("u1");
        let t2 = auth.generate_ws_ticket("u1");
        assert_ne!(t1, t2);
    }

    // ── DILLA_JWT_SECRET env var override tests ─────────────────────────

    #[test]
    fn test_derive_jwt_secret_with_env_var_override() {
        let _guard = ENV_LOCK.lock().unwrap();
        // Set the env var, derive secret, then clean up.
        std::env::set_var("DILLA_JWT_SECRET", "my-explicit-jwt-secret");
        let s1 = derive_jwt_secret("some-passphrase");
        let s2 = derive_jwt_secret("different-passphrase");
        std::env::remove_var("DILLA_JWT_SECRET");

        // Both should be equal because env var takes precedence over passphrase
        assert_eq!(s1, s2);
        assert_eq!(s1.len(), 32);
    }

    #[test]
    fn test_derive_jwt_secret_env_var_is_deterministic() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("DILLA_JWT_SECRET", "stable-secret-value");
        let s1 = derive_jwt_secret("");
        let s2 = derive_jwt_secret("");
        std::env::remove_var("DILLA_JWT_SECRET");

        // With env var set, even empty passphrase should yield deterministic results
        assert_eq!(s1, s2);
        assert_eq!(s1.len(), 32);
    }

    #[test]
    fn test_derive_jwt_secret_env_var_empty_string_ignored() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("DILLA_JWT_SECRET", "");
        let s1 = derive_jwt_secret("my-passphrase");
        std::env::remove_var("DILLA_JWT_SECRET");

        // Empty env var should be ignored, so it should derive from passphrase
        let s2 = derive_jwt_secret("my-passphrase");
        assert_eq!(s1, s2);
    }

    #[test]
    fn test_derive_jwt_secret_env_var_differs_from_passphrase() {
        let _guard = ENV_LOCK.lock().unwrap();
        // Without env var: derive from passphrase
        let from_passphrase = derive_jwt_secret("some-passphrase");

        // With env var: derive from env var
        std::env::set_var("DILLA_JWT_SECRET", "explicit-secret");
        let from_env = derive_jwt_secret("some-passphrase");
        std::env::remove_var("DILLA_JWT_SECRET");

        assert_ne!(from_passphrase, from_env);
    }

    #[test]
    fn test_derive_jwt_secret_env_var_produces_valid_tokens() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("DILLA_JWT_SECRET", "test-jwt-secret-for-tokens");
        let auth = test_auth_service_with_passphrase("ignored-passphrase");
        std::env::remove_var("DILLA_JWT_SECRET");

        let token = auth.generate_jwt("user-env").unwrap();
        let user_id = auth.validate_jwt(&token).unwrap();
        assert_eq!(user_id, "user-env");
    }

    #[test]
    fn test_derive_jwt_secret_env_var_cross_instance_validation() {
        let _guard = ENV_LOCK.lock().unwrap();
        // Both instances must be created while the env var is set so they
        // derive the same JWT secret from the env var.
        std::env::set_var("DILLA_JWT_SECRET", "shared-env-secret");
        let secret_a = derive_jwt_secret("pass-a");
        let secret_b = derive_jwt_secret("pass-b");
        std::env::remove_var("DILLA_JWT_SECRET");

        // Both secrets should be identical because env var overrides passphrase
        assert_eq!(secret_a, secret_b);

        // Verify tokens produced by one can be validated by the other
        let db = test_db();
        let auth1 = AuthService {
            db: db.clone(),
            jwt_secret: secret_a,
            challenges: Arc::new(RwLock::new(HashMap::new())),
            ws_tickets: Arc::new(RwLock::new(HashMap::new())),
            node_name: String::new(),
        };
        let auth2 = AuthService {
            db,
            jwt_secret: secret_b,
            challenges: Arc::new(RwLock::new(HashMap::new())),
            ws_tickets: Arc::new(RwLock::new(HashMap::new())),
            node_name: String::new(),
        };
        let token = auth1.generate_jwt("cross-user").unwrap();
        let user_id = auth2.validate_jwt(&token).unwrap();
        assert_eq!(user_id, "cross-user");
    }

    // ── extract_auth_cookie ──────────────────────────────────────────

    fn headers_with_cookie(cookie: &str) -> http::HeaderMap {
        let mut h = http::HeaderMap::new();
        h.insert(http::header::COOKIE, cookie.parse().unwrap());
        h
    }

    #[test]
    fn extract_auth_cookie_finds_token_when_cookie_present() {
        let h = headers_with_cookie("__dilla_jwt=abc.def.ghi");
        assert_eq!(extract_auth_cookie(&h), Some("abc.def.ghi".to_string()));
    }

    #[test]
    fn extract_auth_cookie_finds_token_among_other_cookies() {
        let h = headers_with_cookie("foo=bar; __dilla_jwt=token123; baz=qux");
        assert_eq!(extract_auth_cookie(&h), Some("token123".to_string()));
    }

    #[test]
    fn extract_auth_cookie_returns_none_when_cookie_header_missing() {
        let h = http::HeaderMap::new();
        assert!(extract_auth_cookie(&h).is_none());
    }

    #[test]
    fn extract_auth_cookie_returns_none_when_jwt_cookie_absent() {
        let h = headers_with_cookie("session=abc; theme=dark");
        assert!(extract_auth_cookie(&h).is_none());
    }

    #[test]
    fn extract_auth_cookie_returns_none_for_empty_value() {
        let h = headers_with_cookie("__dilla_jwt=");
        // Empty cookie value is treated as absent — clear_auth_cookie
        // emits exactly this form to log the user out.
        assert!(extract_auth_cookie(&h).is_none());
    }

    #[test]
    fn extract_auth_cookie_handles_leading_whitespace() {
        let h = headers_with_cookie("foo=1;   __dilla_jwt=tok2");
        assert_eq!(extract_auth_cookie(&h), Some("tok2".to_string()));
    }

    // ── refresh_with_sliding tests ──────────────────────────────────

    #[test]
    fn refresh_with_sliding_does_not_rotate_a_fresh_token() {
        let auth = test_auth_service();
        let token = auth.generate_refresh_token("u1").unwrap();
        // The token is freshly minted → > half lifetime remaining → no rotate.
        let (_access, returned, rotated) = auth.refresh_with_sliding(&token).unwrap();
        assert!(!rotated);
        assert_eq!(returned, token);
    }

    #[test]
    fn refresh_with_sliding_rejects_invalid_token() {
        let auth = test_auth_service();
        let res = auth.refresh_with_sliding("garbage-not-a-jwt");
        assert!(res.is_err());
    }
}
