//! Passkey-recoverable identity escrow (design:
//! .security-hardening/15-passkey-recoverable-identity-escrow.md).
//!
//! One row per (user_id, credential_id). The on-device `identity.key`
//! blob, encrypted with the WebAuthn-PRF-derived wrap key, lives in
//! `encrypted_blob`. The server never sees the PRF output so it
//! cannot decrypt. `prf_salt` is opaque to the server but required
//! by the client to re-derive the wrap key during recovery.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IdentityRecoverySlot {
    pub id: i64,
    pub user_id: String,
    pub credential_id: String,
    pub rp_id: String,
    pub prf_salt: Vec<u8>,
    pub encrypted_blob: Vec<u8>,
    pub created_at: String,
    pub updated_at: String,
}

/// Descriptor returned by the unauthenticated lookup endpoint. Only the
/// non-sensitive bits — never the encrypted blob.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IdentityRecoveryDescriptor {
    pub credential_id: String,
    pub prf_salt: Vec<u8>,
}

/// Upsert an escrow slot. Idempotent on (user_id, credential_id) —
/// re-uploading with a different blob refreshes `encrypted_blob` and
/// `updated_at` without touching the row's PK.
pub fn upsert_recovery_slot(
    conn: &Connection,
    user_id: &str,
    credential_id: &str,
    rp_id: &str,
    prf_salt: &[u8],
    encrypted_blob: &[u8],
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO identity_recovery_slots
            (user_id, credential_id, rp_id, prf_salt, encrypted_blob, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'), datetime('now'))
         ON CONFLICT(user_id, credential_id) DO UPDATE SET
            prf_salt = excluded.prf_salt,
            encrypted_blob = excluded.encrypted_blob,
            rp_id = excluded.rp_id,
            updated_at = datetime('now')",
        params![user_id, credential_id, rp_id, prf_salt, encrypted_blob],
    )?;
    Ok(())
}

/// Fetch a slot by `(user_id, credential_id)`. Used by the verify
/// endpoint after a successful passkey assertion.
pub fn get_recovery_slot(
    conn: &Connection,
    user_id: &str,
    credential_id: &str,
) -> Result<Option<IdentityRecoverySlot>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, user_id, credential_id, rp_id, prf_salt, encrypted_blob, created_at, updated_at
         FROM identity_recovery_slots WHERE user_id = ?1 AND credential_id = ?2",
        params![user_id, credential_id],
        row_to_slot,
    )
    .optional()
}

/// Fetch a slot by credential_id alone. Used during recovery when the
/// client only has the credentialId from the WebAuthn assertion.
pub fn get_recovery_slot_by_credential(
    conn: &Connection,
    credential_id: &str,
) -> Result<Option<IdentityRecoverySlot>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, user_id, credential_id, rp_id, prf_salt, encrypted_blob, created_at, updated_at
         FROM identity_recovery_slots WHERE credential_id = ?1",
        params![credential_id],
        row_to_slot,
    )
    .optional()
}

/// All descriptors for a user, used by the lookup endpoint. Returns
/// only `(credential_id, prf_salt)` — never the encrypted blob.
pub fn list_recovery_descriptors_for_user(
    conn: &Connection,
    user_id: &str,
) -> Result<Vec<IdentityRecoveryDescriptor>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT credential_id, prf_salt
         FROM identity_recovery_slots
         WHERE user_id = ?1
         ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map(params![user_id], |r| {
        Ok(IdentityRecoveryDescriptor {
            credential_id: r.get(0)?,
            prf_salt: r.get(1)?,
        })
    })?;
    rows.collect()
}

/// Delete a slot when the user revokes a passkey. Returns true if a
/// row was actually removed.
pub fn delete_recovery_slot(
    conn: &Connection,
    user_id: &str,
    credential_id: &str,
) -> Result<bool, rusqlite::Error> {
    let n = conn.execute(
        "DELETE FROM identity_recovery_slots WHERE user_id = ?1 AND credential_id = ?2",
        params![user_id, credential_id],
    )?;
    Ok(n > 0)
}

fn row_to_slot(r: &rusqlite::Row<'_>) -> Result<IdentityRecoverySlot, rusqlite::Error> {
    Ok(IdentityRecoverySlot {
        id: r.get(0)?,
        user_id: r.get(1)?,
        credential_id: r.get(2)?,
        rp_id: r.get(3)?,
        prf_salt: r.get(4)?,
        encrypted_blob: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn fresh_db() -> Database {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
        db.run_migrations().unwrap();
        Box::leak(Box::new(tmp));
        db
    }

    #[test]
    fn upsert_then_get_roundtrips_fields() {
        let db = fresh_db();
        let prf_salt = vec![7u8; 32];
        let blob = vec![0xAB, 0xCD, 0xEF];
        db.with_conn(|c| {
            upsert_recovery_slot(c, "u1", "cred-a", "example.test", &prf_salt, &blob)?;
            let got = get_recovery_slot(c, "u1", "cred-a")?.expect("row");
            assert_eq!(got.user_id, "u1");
            assert_eq!(got.credential_id, "cred-a");
            assert_eq!(got.rp_id, "example.test");
            assert_eq!(got.prf_salt, prf_salt);
            assert_eq!(got.encrypted_blob, blob);
            Ok::<_, rusqlite::Error>(())
        }).unwrap();
    }

    #[test]
    fn upsert_is_idempotent_and_refreshes_blob() {
        let db = fresh_db();
        db.with_conn(|c| {
            upsert_recovery_slot(c, "u1", "cred-a", "example.test", &[1; 32], b"v1")?;
            upsert_recovery_slot(c, "u1", "cred-a", "example.test", &[1; 32], b"v2")?;
            let got = get_recovery_slot(c, "u1", "cred-a")?.expect("row");
            assert_eq!(got.encrypted_blob, b"v2");
            // Still exactly one row for the same pair.
            let n: i64 = c.query_row(
                "SELECT COUNT(*) FROM identity_recovery_slots WHERE user_id='u1' AND credential_id='cred-a'",
                [], |r| r.get(0))?;
            assert_eq!(n, 1);
            Ok::<_, rusqlite::Error>(())
        }).unwrap();
    }

    #[test]
    fn get_by_credential_finds_row_without_user_id() {
        let db = fresh_db();
        db.with_conn(|c| {
            upsert_recovery_slot(c, "u1", "cred-x", "example.test", &[1; 32], b"data")?;
            let got = get_recovery_slot_by_credential(c, "cred-x")?.expect("row");
            assert_eq!(got.user_id, "u1");
            Ok::<_, rusqlite::Error>(())
        }).unwrap();
    }

    #[test]
    fn list_descriptors_returns_minimal_fields_in_insert_order() {
        let db = fresh_db();
        db.with_conn(|c| {
            upsert_recovery_slot(c, "u1", "cred-a", "example.test", &[1; 32], b"x")?;
            std::thread::sleep(std::time::Duration::from_millis(1100));
            upsert_recovery_slot(c, "u1", "cred-b", "example.test", &[2; 32], b"y")?;
            let descs = list_recovery_descriptors_for_user(c, "u1")?;
            assert_eq!(descs.len(), 2);
            assert_eq!(descs[0].credential_id, "cred-a");
            assert_eq!(descs[1].credential_id, "cred-b");
            // Critically: no encrypted_blob in the response struct at all.
            Ok::<_, rusqlite::Error>(())
        }).unwrap();
    }

    #[test]
    fn list_descriptors_empty_for_unknown_user() {
        let db = fresh_db();
        db.with_conn(|c| {
            assert!(list_recovery_descriptors_for_user(c, "ghost")?.is_empty());
            Ok::<_, rusqlite::Error>(())
        }).unwrap();
    }

    #[test]
    fn delete_removes_specific_pair_and_returns_true() {
        let db = fresh_db();
        db.with_conn(|c| {
            upsert_recovery_slot(c, "u1", "cred-a", "example.test", &[1; 32], b"x")?;
            upsert_recovery_slot(c, "u1", "cred-b", "example.test", &[2; 32], b"y")?;
            let removed = delete_recovery_slot(c, "u1", "cred-a")?;
            assert!(removed);
            assert!(get_recovery_slot(c, "u1", "cred-a")?.is_none());
            assert!(get_recovery_slot(c, "u1", "cred-b")?.is_some());
            Ok::<_, rusqlite::Error>(())
        }).unwrap();
    }

    #[test]
    fn delete_returns_false_for_unknown_row() {
        let db = fresh_db();
        db.with_conn(|c| {
            assert!(!delete_recovery_slot(c, "u1", "ghost")?);
            Ok::<_, rusqlite::Error>(())
        }).unwrap();
    }

    #[test]
    fn unique_constraint_scopes_to_user() {
        // Same credential_id under two different users is permitted —
        // technically pathological for WebAuthn (credentialIds are
        // globally unique by spec) but the constraint is a safety net,
        // not a security check. The unique key is the pair.
        let db = fresh_db();
        db.with_conn(|c| {
            upsert_recovery_slot(c, "u1", "shared-cred", "example.test", &[1; 32], b"a")?;
            upsert_recovery_slot(c, "u2", "shared-cred", "example.test", &[2; 32], b"b")?;
            let got1 = get_recovery_slot(c, "u1", "shared-cred")?.expect("u1 row");
            let got2 = get_recovery_slot(c, "u2", "shared-cred")?.expect("u2 row");
            assert_eq!(got1.encrypted_blob, b"a");
            assert_eq!(got2.encrypted_blob, b"b");
            Ok::<_, rusqlite::Error>(())
        }).unwrap();
    }
}
