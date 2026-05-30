//! VULN-002 Phase 3 step 3: signed-event wire format.
//!
//! Wraps an existing `FederationEvent` in a `SignedFederationEvent`
//! envelope carrying the originating node's id, a per-(node, team)
//! sequence number, an event id derived from the canonical bytes, and
//! an Ed25519 signature over those canonical bytes.
//!
//! Per `.security-hardening/14-federation-phase3-design.md` §4.2 the
//! wire form is:
//!
//! ```jsonc
//! {
//!   "v": 3,
//!   "event": { ...FederationEvent... },
//!   "origin_node_id": "<hex>",
//!   "seq": 42,
//!   "event_id": "<blake/sha hex>",
//!   "signature": "<base64 ed25519 64B>"
//! }
//! ```
//!
//! Canonical serialization is RFC 8259 + RFC 8785-style key ordering:
//! we walk the JSON value tree and re-emit it with every object's keys
//! sorted ascending. That gives deterministic bytes across Rust runs
//! and across JS implementations (which can do the same sort).
//!
//! This module ships the *types and helpers*; the wire-protocol cut-
//! over (transport sending/receiving these envelopes) lands in a
//! follow-up release per the Phase 3 §6 rolling-upgrade story.

use base64::Engine as _;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

use super::identity::NodeIdentity;
use super::peers;
use super::FederationEvent;

/// Current wire-protocol version. Receivers MUST reject anything that
/// claims a higher major version they don't understand.
pub const WIRE_VERSION: u32 = 3;

/// Signed envelope around a `FederationEvent`. Travels on the wire
/// once the transport flip ships.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedFederationEvent {
    pub v: u32,
    pub event: FederationEvent,
    pub origin_node_id: String,
    pub seq: u64,
    /// SHA-256 of the canonical serialization of the inner event +
    /// origin_node_id + seq. Doubles as a stable event id for audit
    /// + dedup.
    pub event_id: String,
    /// Base64-encoded Ed25519 signature over `canonical_signing_bytes`.
    pub signature: String,
}

/// Reasons a verify can fail. Caller maps to audit reason strings.
#[derive(Debug)]
pub enum WireError {
    UnsupportedVersion(u32),
    UnpinnedPeer(String),
    SignatureDecode(String),
    EventIdMismatch,
    BadSignature,
    Db(rusqlite::Error),
    Serialize(String),
}

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WireError::UnsupportedVersion(v) => write!(f, "unsupported wire version: {}", v),
            WireError::UnpinnedPeer(n) => write!(f, "origin peer not pinned: {}", n),
            WireError::SignatureDecode(e) => write!(f, "signature decode failed: {}", e),
            WireError::EventIdMismatch => write!(f, "event id mismatch — payload tampered"),
            WireError::BadSignature => write!(f, "ed25519 verification failed"),
            WireError::Db(e) => write!(f, "db error: {}", e),
            WireError::Serialize(s) => write!(f, "canonical serialization failed: {}", s),
        }
    }
}

impl std::error::Error for WireError {}

impl From<rusqlite::Error> for WireError {
    fn from(e: rusqlite::Error) -> Self {
        WireError::Db(e)
    }
}

/// Serialize a serde_json::Value with object keys recursively sorted.
/// Pure RFC 8259 output (UTF-8 JSON) with deterministic ordering —
/// the same input always produces the same bytes regardless of Rust
/// version or serde_json internal heuristics. Suitable for signing.
fn canonical_bytes(value: &serde_json::Value) -> Result<Vec<u8>, WireError> {
    let canonical = canonicalize(value);
    serde_json::to_vec(&canonical).map_err(|e| WireError::Serialize(e.to_string()))
}

fn canonicalize(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let mut sorted = BTreeMap::new();
            for (k, v) in map {
                sorted.insert(k.clone(), canonicalize(v));
            }
            // BTreeMap serializes keys in ascending order — exactly
            // what we want for canonical form.
            serde_json::to_value(sorted).unwrap_or(serde_json::Value::Null)
        }
        serde_json::Value::Array(arr) => {
            // Arrays keep their order (semantically significant) but
            // we recurse into elements.
            serde_json::Value::Array(arr.iter().map(canonicalize).collect())
        }
        // Strings, numbers, booleans, null — serde_json's default
        // output is already deterministic for these.
        other => other.clone(),
    }
}

/// Bytes that get signed. Includes the wire version + event content
/// + origin metadata so a forged envelope can't reuse a captured
/// signature against a different (origin, seq) tuple.
fn canonical_signing_bytes(
    v: u32,
    event: &FederationEvent,
    origin_node_id: &str,
    seq: u64,
) -> Result<Vec<u8>, WireError> {
    let value = serde_json::json!({
        "v": v,
        "event": event,
        "origin_node_id": origin_node_id,
        "seq": seq,
    });
    canonical_bytes(&value)
}

fn derive_event_id(signing_bytes: &[u8]) -> String {
    let digest = Sha256::digest(signing_bytes);
    let mut hex = String::with_capacity(64);
    for b in digest {
        hex.push_str(&format!("{:02x}", b));
    }
    hex
}

/// Sign a `FederationEvent` with this node's identity. Caller chooses
/// the `seq` (per-(origin, team) monotonic — usually pulled from
/// `federation_seq_watermark`).
pub fn sign(
    identity: &NodeIdentity,
    event: FederationEvent,
    seq: u64,
) -> Result<SignedFederationEvent, WireError> {
    let signing_bytes = canonical_signing_bytes(WIRE_VERSION, &event, &identity.node_id, seq)?;
    // NodeIdentity::sign keeps the secret material inside the identity
    // module — no need to reach into a private field here.
    let signature: Signature = identity.sign(&signing_bytes);
    let event_id = derive_event_id(&signing_bytes);
    Ok(SignedFederationEvent {
        v: WIRE_VERSION,
        event,
        origin_node_id: identity.node_id.clone(),
        seq,
        event_id,
        signature: base64::engine::general_purpose::STANDARD.encode(signature.to_bytes()),
    })
}

/// Verify a received envelope. Resolves the originator's public key
/// from the pinned-peers table, checks the recomputed event_id matches,
/// then verifies the Ed25519 signature. Returns Ok(()) on success;
/// caller still has to walk the seq watermark + authority checks.
pub fn verify(conn: &Connection, signed: &SignedFederationEvent) -> Result<(), WireError> {
    if signed.v != WIRE_VERSION {
        return Err(WireError::UnsupportedVersion(signed.v));
    }
    let pk = peers::active_public_key(conn, &signed.origin_node_id)?
        .ok_or_else(|| WireError::UnpinnedPeer(signed.origin_node_id.clone()))?;
    verify_with_public_key(&pk, signed)
}

/// Lower-level verifier that takes the public key directly. Useful in
/// tests + during the v3 handshake before the peer is fully pinned.
pub fn verify_with_public_key(
    public_key: &VerifyingKey,
    signed: &SignedFederationEvent,
) -> Result<(), WireError> {
    if signed.v != WIRE_VERSION {
        return Err(WireError::UnsupportedVersion(signed.v));
    }
    let signing_bytes = canonical_signing_bytes(
        signed.v,
        &signed.event,
        &signed.origin_node_id,
        signed.seq,
    )?;
    let recomputed = derive_event_id(&signing_bytes);
    if recomputed != signed.event_id {
        return Err(WireError::EventIdMismatch);
    }
    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(&signed.signature)
        .map_err(|e| WireError::SignatureDecode(e.to_string()))?;
    let sig_arr: [u8; 64] = sig_bytes
        .as_slice()
        .try_into()
        .map_err(|_| WireError::SignatureDecode("signature wrong length".into()))?;
    let signature = Signature::from_bytes(&sig_arr);
    public_key
        .verify(&signing_bytes, &signature)
        .map_err(|_| WireError::BadSignature)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::federation::identity;

    fn fresh_db() -> Database {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;"))
            .unwrap();
        db.run_migrations().unwrap();
        Box::leak(Box::new(tmp));
        db
    }

    fn sample_event() -> FederationEvent {
        FederationEvent {
            event_type: "message:new".into(),
            node_name: "node-alpha".into(),
            timestamp: 1_700_000_000,
            payload: serde_json::json!({
                "message_id": "m1",
                "channel_id": "c1",
                "author_id": "u1",
                "content": "hello world",
            }),
        }
    }

    #[test]
    fn canonical_bytes_are_deterministic_across_key_orders() {
        let a = serde_json::json!({ "x": 1, "y": 2, "z": { "b": [1, 2], "a": "ok" } });
        let b = serde_json::json!({ "y": 2, "x": 1, "z": { "a": "ok", "b": [1, 2] } });
        assert_eq!(canonical_bytes(&a).unwrap(), canonical_bytes(&b).unwrap());
    }

    #[test]
    fn canonical_bytes_preserve_array_order() {
        // Arrays are semantically ordered — canonicalize must not sort them.
        let a = serde_json::json!([3, 1, 2]);
        let bytes = canonical_bytes(&a).unwrap();
        assert_eq!(bytes, b"[3,1,2]");
    }

    #[test]
    fn sign_then_verify_roundtrip() {
        let db = fresh_db();
        let id = identity::ensure(&db).unwrap();
        let signed = sign(&id, sample_event(), 1).unwrap();
        // Verify via the pinned-peer path: pin self, then verify.
        db.with_conn(|c| {
            peers::pin(c, &id.node_id, &id.public_key, "self").unwrap();
            verify(c, &signed).unwrap();
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn verify_rejects_tampered_event_id() {
        let db = fresh_db();
        let id = identity::ensure(&db).unwrap();
        let mut signed = sign(&id, sample_event(), 1).unwrap();
        signed.event_id = "0".repeat(64);
        let err = verify_with_public_key(&id.public_key, &signed).unwrap_err();
        assert!(matches!(err, WireError::EventIdMismatch));
    }

    #[test]
    fn verify_rejects_tampered_payload() {
        let db = fresh_db();
        let id = identity::ensure(&db).unwrap();
        let mut signed = sign(&id, sample_event(), 1).unwrap();
        // Mutate the inner event — event_id will recompute differently.
        if let serde_json::Value::Object(ref mut m) = signed.event.payload {
            m.insert("content".into(), serde_json::json!("MITM"));
        }
        let err = verify_with_public_key(&id.public_key, &signed).unwrap_err();
        // The recomputed id no longer matches the stored one.
        assert!(matches!(err, WireError::EventIdMismatch));
    }

    #[test]
    fn verify_rejects_unpinned_peer() {
        let db = fresh_db();
        let id = identity::ensure(&db).unwrap();
        let signed = sign(&id, sample_event(), 1).unwrap();
        // No peer pinning → UnpinnedPeer.
        db.with_conn(|c| {
            let err = verify(c, &signed).unwrap_err();
            assert!(matches!(err, WireError::UnpinnedPeer(_)));
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn verify_rejects_revoked_peer() {
        let db = fresh_db();
        let id = identity::ensure(&db).unwrap();
        let signed = sign(&id, sample_event(), 1).unwrap();
        db.with_conn(|c| {
            peers::pin(c, &id.node_id, &id.public_key, "self").unwrap();
            peers::revoke(c, &id.node_id).unwrap();
            let err = verify(c, &signed).unwrap_err();
            assert!(matches!(err, WireError::UnpinnedPeer(_)));
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn verify_rejects_bad_signature() {
        let db = fresh_db();
        let id = identity::ensure(&db).unwrap();
        let mut signed = sign(&id, sample_event(), 1).unwrap();
        // Flip one byte of the signature post-sign.
        let mut sig_bytes = base64::engine::general_purpose::STANDARD
            .decode(&signed.signature)
            .unwrap();
        sig_bytes[0] ^= 0xff;
        signed.signature = base64::engine::general_purpose::STANDARD.encode(&sig_bytes);
        let err = verify_with_public_key(&id.public_key, &signed).unwrap_err();
        assert!(matches!(err, WireError::BadSignature));
    }

    #[test]
    fn verify_rejects_unsupported_version() {
        let db = fresh_db();
        let id = identity::ensure(&db).unwrap();
        let mut signed = sign(&id, sample_event(), 1).unwrap();
        signed.v = 99;
        let err = verify_with_public_key(&id.public_key, &signed).unwrap_err();
        assert!(matches!(err, WireError::UnsupportedVersion(99)));
    }

    #[test]
    fn wire_error_display_includes_message_for_each_variant() {
        assert!(WireError::UnsupportedVersion(99).to_string().contains("99"));
        assert!(WireError::UnpinnedPeer("node-x".into()).to_string().contains("node-x"));
        assert!(WireError::SignatureDecode("bad".into()).to_string().contains("bad"));
        assert!(WireError::EventIdMismatch.to_string().contains("event id"));
        assert!(WireError::BadSignature.to_string().contains("ed25519"));
        assert!(WireError::Serialize("oops".into()).to_string().contains("oops"));
        // Db variant requires a rusqlite::Error to construct.
        let db_err: WireError = rusqlite::Error::QueryReturnedNoRows.into();
        assert!(db_err.to_string().contains("db error"));
    }

    #[test]
    fn verify_top_level_rejects_unsupported_version_before_peer_lookup() {
        let db = fresh_db();
        let id = identity::ensure(&db).unwrap();
        let mut signed = sign(&id, sample_event(), 1).unwrap();
        signed.v = 42;
        let err = db.with_conn(|c| {
            match verify(c, &signed) {
                Err(e) => Ok(e),
                Ok(()) => panic!("expected err"),
            }
        }).unwrap();
        assert!(matches!(err, WireError::UnsupportedVersion(42)));
    }
}
