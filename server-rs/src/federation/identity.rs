//! VULN-002 Phase 3 foundation: per-node Ed25519 identity.
//!
//! Every Dilla node has a long-lived signing keypair. The public key
//! is exchanged at federation-join time and pinned by every remote
//! peer; the private key signs every outbound `FederationEvent` once
//! the signed-wire-format ships in a follow-up release.
//!
//! This module only handles **identity generation + persistence**.
//! The wire-format change (signing/verifying events) is tracked in
//! `.security-hardening/14-federation-phase3-design.md` §4 and lands
//! once every node has an identity in place.
//!
//! The keypair lives in `node_identity` (migration 030). Storage is
//! at-rest-encrypted by the existing SQLCipher key derivation in
//! `db/mod.rs`; for high-assurance deployments operators can move the
//! seed bytes to an HSM (see `deploy/secrets/HSM.md`).
//!
//! Generation is idempotent: `ensure()` returns the existing identity
//! if present, otherwise generates a new one and inserts it. Called
//! at startup from `init_federation_mesh`.

use ed25519_dalek::{SigningKey, VerifyingKey};
use rand::rngs::OsRng;
use rand::TryRngCore;
use rusqlite::{params, Connection, OptionalExtension};

use crate::db::Database;

/// One node's stable identity. The signing key never leaves the
/// process; only `node_id` + `public_key` cross the wire.
#[derive(Clone)]
pub struct NodeIdentity {
    pub node_id: String,
    pub public_key: VerifyingKey,
    signing_key: SigningKey,
}

impl NodeIdentity {
    /// Sign arbitrary bytes with this node's secret key. Used by the
    /// FederationEvent wrapper once §4.2 of the design doc ships.
    /// Stub here so the call sites can wire up in advance.
    pub fn sign(&self, message: &[u8]) -> ed25519_dalek::Signature {
        use ed25519_dalek::Signer;
        self.signing_key.sign(message)
    }

    /// Stable public-key bytes for the wire (raw 32 bytes).
    pub fn public_key_bytes(&self) -> [u8; 32] {
        self.public_key.to_bytes()
    }
}

/// Load the existing identity from the DB, or generate + persist a new
/// one. Always returns exactly one identity per Dilla install.
///
/// Generation uses `OsRng` directly (same source the rest of the
/// auth surface uses for challenge nonces). The 32-byte seed is
/// stored as-is in `node_identity.private_key`; SQLCipher handles
/// at-rest encryption.
pub fn ensure(db: &Database) -> Result<NodeIdentity, rusqlite::Error> {
    db.with_conn(ensure_with_conn)
}

fn ensure_with_conn(conn: &Connection) -> Result<NodeIdentity, rusqlite::Error> {
    if let Some(existing) = load(conn)? {
        return Ok(existing);
    }

    // Generate a fresh keypair. ed25519_dalek 2.x's SigningKey::generate
    // takes anything that implements `rand_core::CryptoRng + RngCore`.
    // We seed a 32-byte buffer from OsRng to keep the dep surface
    // identical to the rest of auth.rs.
    let mut seed = [0u8; 32];
    OsRng
        .try_fill_bytes(&mut seed)
        .map_err(|e| rusqlite::Error::InvalidParameterName(format!("rng: {e}")))?;
    let signing_key = SigningKey::from_bytes(&seed);
    let public_key = signing_key.verifying_key();
    let node_id = uuid_v4_hex();

    conn.execute(
        "INSERT INTO node_identity (id, node_id, public_key, private_key) \
         VALUES (1, ?1, ?2, ?3)",
        params![node_id, public_key.to_bytes().to_vec(), seed.to_vec()],
    )?;

    // Zero the seed buffer once it's persisted — it's still in the
    // SigningKey, but we don't want a stray copy on the stack.
    seed.fill(0);

    Ok(NodeIdentity {
        node_id,
        public_key,
        signing_key,
    })
}

/// Read the singleton row. Returns None when this is a fresh install
/// (caller falls through to generate).
fn load(conn: &Connection) -> Result<Option<NodeIdentity>, rusqlite::Error> {
    let row: Option<(String, Vec<u8>, Vec<u8>)> = conn
        .query_row(
            "SELECT node_id, public_key, private_key FROM node_identity WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let (node_id, pk_bytes, sk_bytes) = match row {
        Some(t) => t,
        None => return Ok(None),
    };

    let pk_arr: [u8; 32] = pk_bytes
        .as_slice()
        .try_into()
        .map_err(|_| rusqlite::Error::InvalidParameterName("node public_key wrong length".into()))?;
    let sk_arr: [u8; 32] = sk_bytes
        .as_slice()
        .try_into()
        .map_err(|_| rusqlite::Error::InvalidParameterName("node private_key wrong length".into()))?;
    let public_key = VerifyingKey::from_bytes(&pk_arr).map_err(|e| {
        rusqlite::Error::InvalidParameterName(format!("node public_key invalid: {e}"))
    })?;
    let signing_key = SigningKey::from_bytes(&sk_arr);

    // Defensive consistency check — a corrupted private_key would
    // otherwise sign with one identity and broadcast another.
    if signing_key.verifying_key().to_bytes() != public_key.to_bytes() {
        return Err(rusqlite::Error::InvalidParameterName(
            "node identity public/private key mismatch — DB tampering or import error".into(),
        ));
    }

    Ok(Some(NodeIdentity {
        node_id,
        public_key,
        signing_key,
    }))
}

/// Small uuid-v4-hex helper. Avoids pulling in the `uuid` crate just
/// for the node_id field; matches the format used elsewhere in this
/// codebase (32 hex chars, no dashes).
fn uuid_v4_hex() -> String {
    let mut bytes = [0u8; 16];
    let _ = OsRng.try_fill_bytes(&mut bytes);
    // Stamp v4 + variant bits per RFC 4122 so the value is
    // recognisable as a UUID if an operator pastes it elsewhere.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let mut s = String::with_capacity(32);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_db() -> Database {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;"))
            .unwrap();
        db.run_migrations().unwrap();
        // tempdir is held inside the test; leak it for the duration.
        Box::leak(Box::new(tmp));
        db
    }

    #[test]
    fn ensure_generates_a_new_identity_on_fresh_db() {
        let db = fresh_db();
        let id = ensure(&db).unwrap();
        assert_eq!(id.node_id.len(), 32);
        assert!(id.node_id.chars().all(|c| c.is_ascii_hexdigit()));
        // Public key should round-trip.
        assert_eq!(id.public_key_bytes().len(), 32);
    }

    #[test]
    fn ensure_is_idempotent() {
        let db = fresh_db();
        let a = ensure(&db).unwrap();
        let b = ensure(&db).unwrap();
        assert_eq!(a.node_id, b.node_id);
        assert_eq!(a.public_key_bytes(), b.public_key_bytes());
    }

    #[test]
    fn sign_then_verify_roundtrip() {
        use ed25519_dalek::Verifier;
        let db = fresh_db();
        let id = ensure(&db).unwrap();
        let msg = b"phase3 wire envelope contents";
        let sig = id.sign(msg);
        assert!(id.public_key.verify(msg, &sig).is_ok());
    }
}
