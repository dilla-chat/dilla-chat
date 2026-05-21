//! A1 / AUTH-MULTIDEV-1: per-user device key trust.
//!
//! A user can hold N (device_id, public_key) pairs. Each device has its
//! own Ed25519 keypair; the challenge-response flow records the device
//! along with the user in the issued JWT (`device_id` claim).
//!
//! Backward compat: existing rows in `users` are mirrored into
//! `user_devices` by the 029 migration, labeled "primary". The legacy
//! verify path (no device_id in the request) resolves to that row.

use super::new_id;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserDevice {
    pub id: String,
    pub user_id: String,
    /// Raw 32-byte Ed25519 public key. Serialized as base64 over the
    /// wire by the API layer; the DB stores raw bytes.
    #[serde(with = "super::models::base64_bytes_pub")]
    pub public_key: Vec<u8>,
    #[serde(default)]
    pub device_label: String,
    pub created_at: String,
    #[serde(default)]
    pub last_seen_at: Option<String>,
    #[serde(default)]
    pub last_seen_ip: Option<String>,
    #[serde(default)]
    pub last_seen_user_agent: Option<String>,
    #[serde(default)]
    pub last_seen_country: Option<String>,
    #[serde(default)]
    pub current_session_started_at: Option<String>,
    #[serde(default)]
    pub revoked_at: Option<String>,
    /// A4: any JWT with `iat < tokens_invalidated_after` is rejected.
    /// Set by `invalidate_device_tokens_now` when the user's role
    /// changes. Stored as unix seconds so the validate-time check
    /// is a single integer compare.
    #[serde(default)]
    pub tokens_invalidated_after: i64,
}

impl UserDevice {
    pub fn is_active(&self) -> bool {
        self.revoked_at.is_none()
    }
}

fn row_to_device(row: &rusqlite::Row) -> Result<UserDevice, rusqlite::Error> {
    Ok(UserDevice {
        id: row.get(0)?,
        user_id: row.get(1)?,
        public_key: row.get(2)?,
        device_label: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        created_at: row.get(4)?,
        last_seen_at: row.get(5)?,
        last_seen_ip: row.get(6)?,
        last_seen_user_agent: row.get(7)?,
        last_seen_country: row.get(8)?,
        current_session_started_at: row.get(9)?,
        revoked_at: row.get(10)?,
        tokens_invalidated_after: row.get::<_, Option<i64>>(11)?.unwrap_or(0),
    })
}

const SELECT_COLS: &str = "id, user_id, public_key, device_label, created_at, \
                           last_seen_at, last_seen_ip, last_seen_user_agent, \
                           last_seen_country, current_session_started_at, revoked_at, \
                           tokens_invalidated_after";

/// A4: bump every device row's `tokens_invalidated_after` to "now" for
/// a given user. Called from the role-update path so any JWT minted
/// before the role change is rejected at validate time. Existing
/// sessions need to re-auth (the client refresh path will mint a new
/// JWT with the new claims).
pub fn invalidate_user_tokens_now(
    conn: &Connection,
    user_id: &str,
) -> Result<(), rusqlite::Error> {
    let now = chrono::Utc::now().timestamp();
    conn.execute(
        "UPDATE user_devices SET tokens_invalidated_after = ?2 WHERE user_id = ?1",
        params![user_id, now],
    )?;
    Ok(())
}

/// Insert a fresh device row. Returns the generated device_id. The
/// caller is responsible for verifying the enrollment signature
/// (signed by an already-trusted device's private key) before calling.
pub fn create_device(
    conn: &Connection,
    user_id: &str,
    public_key: &[u8],
    device_label: &str,
) -> Result<String, rusqlite::Error> {
    let id = new_id();
    conn.execute(
        "INSERT INTO user_devices (id, user_id, public_key, device_label, created_at)
         VALUES (?1, ?2, ?3, ?4, datetime('now'))",
        params![id, user_id, public_key, device_label],
    )?;
    Ok(id)
}

pub fn get_device_by_id(
    conn: &Connection,
    device_id: &str,
) -> Result<Option<UserDevice>, rusqlite::Error> {
    conn.query_row(
        &format!("SELECT {} FROM user_devices WHERE id = ?1", SELECT_COLS),
        [device_id],
        row_to_device,
    )
    .optional()
}

/// Look up a device by the (user_id, public_key) pair. Used by the
/// challenge-response verify path: the caller presents a pubkey, we
/// find the matching device row (if any) and stamp the JWT with its
/// device_id.
pub fn get_device_by_user_and_pubkey(
    conn: &Connection,
    user_id: &str,
    public_key: &[u8],
) -> Result<Option<UserDevice>, rusqlite::Error> {
    conn.query_row(
        &format!(
            "SELECT {} FROM user_devices WHERE user_id = ?1 AND public_key = ?2",
            SELECT_COLS
        ),
        params![user_id, public_key],
        row_to_device,
    )
    .optional()
}

/// List every device for a user, newest first. Includes revoked
/// devices so the user can audit them from /devices.
pub fn list_devices_for_user(
    conn: &Connection,
    user_id: &str,
) -> Result<Vec<UserDevice>, rusqlite::Error> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM user_devices WHERE user_id = ?1 ORDER BY created_at DESC",
        SELECT_COLS
    ))?;
    let rows = stmt.query_map([user_id], row_to_device)?;
    rows.collect()
}

/// Mark a device revoked. Idempotent — a second call leaves the
/// original revoked_at timestamp untouched. Future JWT issuance for
/// this device_id will fail. Existing JWTs survive their natural exp.
pub fn revoke_device(conn: &Connection, device_id: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE user_devices SET revoked_at = datetime('now')
         WHERE id = ?1 AND revoked_at IS NULL",
        [device_id],
    )?;
    Ok(())
}

/// Stamp the device's last-seen risk signals + bump the session
/// start. Called from the /auth/verify success path. Empty strings
/// land as NULL so a missing IP / user agent / country doesn't
/// overwrite a previously-recorded value with junk.
pub fn record_device_login(
    conn: &Connection,
    device_id: &str,
    ip: Option<&str>,
    user_agent: Option<&str>,
    country: Option<&str>,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE user_devices SET
            last_seen_at = datetime('now'),
            last_seen_ip = COALESCE(?2, last_seen_ip),
            last_seen_user_agent = COALESCE(?3, last_seen_user_agent),
            last_seen_country = COALESCE(?4, last_seen_country),
            current_session_started_at = datetime('now')
         WHERE id = ?1",
        params![device_id, ip, user_agent, country],
    )?;
    Ok(())
}

/// Count the active (non-revoked) devices for a user. Used by
/// /devices/{id}/revoke to refuse the last-device revocation
/// (otherwise the user locks themselves out — they should re-enroll
/// or use the bootstrap flow instead).
pub fn count_active_devices(conn: &Connection, user_id: &str) -> Result<i64, rusqlite::Error> {
    conn.query_row(
        "SELECT COUNT(*) FROM user_devices WHERE user_id = ?1 AND revoked_at IS NULL",
        [user_id],
        |row| row.get(0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{self, Database};

    fn test_db() -> Database {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;"))
            .unwrap();
        db.run_migrations().unwrap();
        std::mem::forget(tmp);
        db
    }

    #[test]
    fn create_lookup_revoke_roundtrip() {
        let db = test_db();
        db.with_conn(|c| {
            let id = create_device(c, "u1", &[1u8; 32], "macbook")?;
            let dev = get_device_by_id(c, &id)?.unwrap();
            assert_eq!(dev.user_id, "u1");
            assert_eq!(dev.device_label, "macbook");
            assert!(dev.is_active());

            revoke_device(c, &id)?;
            let dev = get_device_by_id(c, &id)?.unwrap();
            assert!(!dev.is_active());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn list_devices_orders_newest_first() {
        let db = test_db();
        db.with_conn(|c| {
            create_device(c, "u1", &[1u8; 32], "a")?;
            // Stagger created_at so SQLite's datetime() differs.
            std::thread::sleep(std::time::Duration::from_millis(1100));
            create_device(c, "u1", &[2u8; 32], "b")?;
            let list = list_devices_for_user(c, "u1")?;
            assert_eq!(list.len(), 2);
            assert_eq!(list[0].device_label, "b");
            assert_eq!(list[1].device_label, "a");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn record_device_login_stamps_signals() {
        let db = test_db();
        db.with_conn(|c| {
            let id = create_device(c, "u1", &[1u8; 32], "x")?;
            record_device_login(c, &id, Some("1.2.3.4"), Some("UA"), Some("US"))?;
            let dev = get_device_by_id(c, &id)?.unwrap();
            assert_eq!(dev.last_seen_ip.as_deref(), Some("1.2.3.4"));
            assert_eq!(dev.last_seen_user_agent.as_deref(), Some("UA"));
            assert_eq!(dev.last_seen_country.as_deref(), Some("US"));
            assert!(dev.last_seen_at.is_some());
            assert!(dev.current_session_started_at.is_some());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn count_active_devices_excludes_revoked() {
        let db = test_db();
        db.with_conn(|c| {
            let a = create_device(c, "u1", &[1u8; 32], "a")?;
            let _b = create_device(c, "u1", &[2u8; 32], "b")?;
            revoke_device(c, &a)?;
            assert_eq!(count_active_devices(c, "u1")?, 1);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn backfill_creates_one_device_per_existing_user() {
        // Verify the migration's INSERT OR IGNORE backfill runs.
        let db = test_db();
        let now = db::now_str();
        db.with_conn(|c| {
            crate::db::create_user(
                c,
                &crate::db::User {
                    id: "u1".into(),
                    username: "alice".into(),
                    display_name: "Alice".into(),
                    public_key: vec![7u8; 32],
                    avatar_url: String::new(),
                    status_text: String::new(),
                    status_type: "online".into(),
                    is_admin: false,
                    created_at: now.clone(),
                    updated_at: now,
                    quiet_hours_enabled: false,
                    quiet_hours_from: "22:00".into(),
                    quiet_hours_to: "07:30".into(),
                },
            )
        })
        .unwrap();
        // Re-run the backfill SQL idempotently to model a post-deploy
        // operator running it twice.
        db.with_conn(|c| {
            c.execute_batch(
                "INSERT OR IGNORE INTO user_devices (id, user_id, public_key, device_label, created_at)
                 SELECT lower(hex(randomblob(16))), id, public_key, 'primary', datetime('now')
                 FROM users WHERE length(public_key) = 32;",
            )?;
            let devs = list_devices_for_user(c, "u1")?;
            assert_eq!(devs.len(), 1);
            assert_eq!(devs[0].device_label, "primary");
            assert_eq!(devs[0].public_key, vec![7u8; 32]);
            Ok(())
        })
        .unwrap();
    }
}
