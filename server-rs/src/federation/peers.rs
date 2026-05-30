//! VULN-002 Phase 3 step 2: pinned federation peers.
//!
//! Operators explicitly enroll remote peers — there is no TOFU on
//! the federation surface. Once the signed-wire-format ships (see
//! `.security-hardening/14-federation-phase3-design.md` §4.2),
//! inbound `SignedFederationEvent`s are verified against the public
//! key pinned here for the originating `node_id`. An unpinned peer's
//! events are dropped + audit-logged.
//!
//! Today: this module exposes pure CRUD + lookup. The operator-facing
//! CLI subcommand (`dilla-server federation peer add/list/revoke`) is
//! tracked as a follow-up; for now operators can populate the table
//! directly via SQL or via a future admin API.

use ed25519_dalek::VerifyingKey;
use rusqlite::{params, Connection, OptionalExtension};

/// Pinned remote-peer identity.
#[derive(Clone, Debug)]
pub struct PinnedPeer {
    pub node_id: String,
    pub public_key: VerifyingKey,
    pub hostname: String,
    pub pinned_at: String,
    pub revoked_at: Option<String>,
}

impl PinnedPeer {
    pub fn is_active(&self) -> bool {
        self.revoked_at.is_none()
    }
}

/// Add (or refresh) a pinned peer. Idempotent on `node_id`: if a row
/// already exists with the same node_id, its public_key, hostname, and
/// pinned_at are updated. `revoked_at` is cleared by re-pinning so
/// the operator can re-enable a peer after a temporary block. Returns
/// the resulting row.
pub fn pin(
    conn: &Connection,
    node_id: &str,
    public_key: &VerifyingKey,
    hostname: &str,
) -> Result<PinnedPeer, rusqlite::Error> {
    let now = crate::db::now_str();
    conn.execute(
        "INSERT INTO federation_peers (node_id, public_key, hostname, pinned_at, revoked_at) \
         VALUES (?1, ?2, ?3, ?4, NULL) \
         ON CONFLICT(node_id) DO UPDATE SET \
            public_key = excluded.public_key, \
            hostname = excluded.hostname, \
            pinned_at = excluded.pinned_at, \
            revoked_at = NULL",
        params![node_id, public_key.to_bytes().to_vec(), hostname, now],
    )?;
    get(conn, node_id)?.ok_or_else(|| {
        rusqlite::Error::InvalidParameterName("peer disappeared after pin".into())
    })
}

/// Mark a peer revoked. Future inbound events from this `node_id` are
/// dropped at the verify step. The row stays for forensics — drop it
/// only via the operator CLI.
pub fn revoke(conn: &Connection, node_id: &str) -> Result<(), rusqlite::Error> {
    let now = crate::db::now_str();
    let affected = conn.execute(
        "UPDATE federation_peers SET revoked_at = ?1 \
         WHERE node_id = ?2 AND revoked_at IS NULL",
        params![now, node_id],
    )?;
    if affected == 0 {
        return Err(rusqlite::Error::InvalidParameterName(
            "peer not found or already revoked".into(),
        ));
    }
    Ok(())
}

/// Fetch one peer by node_id. Returns None when the peer was never
/// pinned. Revoked peers are returned with their `revoked_at` set —
/// callers gate on `is_active()`.
pub fn get(conn: &Connection, node_id: &str) -> Result<Option<PinnedPeer>, rusqlite::Error> {
    conn.query_row(
        "SELECT node_id, public_key, hostname, pinned_at, revoked_at \
         FROM federation_peers WHERE node_id = ?1",
        params![node_id],
        row_to_peer,
    )
    .optional()
}

/// List every pinned peer (active or revoked). Operator-facing.
pub fn list_all(conn: &Connection) -> Result<Vec<PinnedPeer>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT node_id, public_key, hostname, pinned_at, revoked_at \
         FROM federation_peers ORDER BY hostname ASC",
    )?;
    let rows = stmt.query_map([], row_to_peer)?;
    rows.collect()
}

/// Fast hot-path lookup: is this `node_id` currently authorized to
/// federate with us? Returns the pinned public key when active, None
/// otherwise. Used by the signed-event verifier.
pub fn active_public_key(
    conn: &Connection,
    node_id: &str,
) -> Result<Option<VerifyingKey>, rusqlite::Error> {
    let peer = match get(conn, node_id)? {
        Some(p) => p,
        None => return Ok(None),
    };
    if !peer.is_active() {
        return Ok(None);
    }
    Ok(Some(peer.public_key))
}

fn row_to_peer(row: &rusqlite::Row<'_>) -> Result<PinnedPeer, rusqlite::Error> {
    let node_id: String = row.get(0)?;
    let pk_bytes: Vec<u8> = row.get(1)?;
    let hostname: String = row.get(2)?;
    let pinned_at: String = row.get(3)?;
    let revoked_at: Option<String> = row.get(4)?;
    let pk_arr: [u8; 32] = pk_bytes
        .as_slice()
        .try_into()
        .map_err(|_| rusqlite::Error::InvalidParameterName("peer public_key wrong length".into()))?;
    let public_key = VerifyingKey::from_bytes(&pk_arr).map_err(|e| {
        rusqlite::Error::InvalidParameterName(format!("peer public_key invalid: {e}"))
    })?;
    Ok(PinnedPeer {
        node_id,
        public_key,
        hostname,
        pinned_at,
        revoked_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use ed25519_dalek::SigningKey;
    use rand::rngs::OsRng;
    use rand::TryRngCore;

    fn fresh_db() -> Database {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;"))
            .unwrap();
        db.run_migrations().unwrap();
        Box::leak(Box::new(tmp));
        db
    }

    fn random_keypair() -> VerifyingKey {
        let mut seed = [0u8; 32];
        OsRng.try_fill_bytes(&mut seed).unwrap();
        SigningKey::from_bytes(&seed).verifying_key()
    }

    #[test]
    fn pin_then_get_roundtrip() {
        let db = fresh_db();
        let vk = random_keypair();
        db.with_conn(|c| {
            let p = pin(c, "node-alpha", &vk, "alpha.example.com").unwrap();
            assert!(p.is_active());
            assert_eq!(p.node_id, "node-alpha");
            assert_eq!(p.hostname, "alpha.example.com");
            assert_eq!(p.public_key.to_bytes(), vk.to_bytes());
            let again = get(c, "node-alpha").unwrap().unwrap();
            assert_eq!(again.node_id, p.node_id);
            assert_eq!(again.public_key.to_bytes(), vk.to_bytes());
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn pin_is_idempotent_and_updates_hostname() {
        let db = fresh_db();
        let vk1 = random_keypair();
        let vk2 = random_keypair();
        db.with_conn(|c| {
            pin(c, "node-x", &vk1, "old.example.com").unwrap();
            // Re-pin with a different hostname + key — both must update,
            // and revoked_at must clear (if we'd revoked it first).
            revoke(c, "node-x").unwrap();
            let p = pin(c, "node-x", &vk2, "new.example.com").unwrap();
            assert_eq!(p.hostname, "new.example.com");
            assert!(p.is_active());
            assert_eq!(p.public_key.to_bytes(), vk2.to_bytes());
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn active_public_key_returns_none_for_revoked() {
        let db = fresh_db();
        let vk = random_keypair();
        db.with_conn(|c| {
            pin(c, "node-y", &vk, "y.example.com").unwrap();
            assert!(active_public_key(c, "node-y").unwrap().is_some());
            revoke(c, "node-y").unwrap();
            assert!(active_public_key(c, "node-y").unwrap().is_none());
            // get() still returns it (with revoked_at set) for forensics.
            assert!(get(c, "node-y").unwrap().unwrap().revoked_at.is_some());
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn active_public_key_returns_none_for_unknown() {
        let db = fresh_db();
        db.with_conn(|c| {
            assert!(active_public_key(c, "never-pinned").unwrap().is_none());
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn revoke_unknown_node_id_errors() {
        let db = fresh_db();
        db.with_conn(|c| {
            assert!(revoke(c, "ghost").is_err());
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn list_all_returns_revoked_and_active_sorted() {
        let db = fresh_db();
        let vk = random_keypair();
        db.with_conn(|c| {
            pin(c, "n-1", &vk, "zzz.example.com").unwrap();
            pin(c, "n-2", &vk, "aaa.example.com").unwrap();
            revoke(c, "n-1").unwrap();
            let all = list_all(c).unwrap();
            assert_eq!(all.len(), 2);
            // ORDER BY hostname → aaa first.
            assert_eq!(all[0].hostname, "aaa.example.com");
            assert!(all[0].is_active());
            assert_eq!(all[1].hostname, "zzz.example.com");
            assert!(!all[1].is_active());
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    }
}
