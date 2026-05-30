// Pinned messages live in their own table (migration 022). The
// uniqueness contract is one row per message_id — pinning twice is a
// noop, unpinning a non-pinned message is also a noop, so handlers
// don't have to pre-check.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PinnedMessage {
    pub message_id: String,
    pub channel_id: String,
    pub team_id: String,
    pub pinned_by: Option<String>,
    pub pinned_at: String,
}

pub fn pin_message(
    conn: &Connection,
    message_id: &str,
    channel_id: &str,
    team_id: &str,
    pinned_by: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT OR IGNORE INTO pinned_messages (message_id, channel_id, team_id, pinned_by) \
         VALUES (?1, ?2, ?3, ?4)",
        params![message_id, channel_id, team_id, pinned_by],
    )?;
    Ok(())
}

pub fn unpin_message(conn: &Connection, message_id: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM pinned_messages WHERE message_id = ?1",
        params![message_id],
    )?;
    Ok(())
}

pub fn is_pinned(conn: &Connection, message_id: &str) -> Result<bool, rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT 1 FROM pinned_messages WHERE message_id = ?1 LIMIT 1")?;
    stmt.exists(params![message_id])
}

/// All pinned message ids for a channel, newest pin first. Returns the
/// ids only — the caller joins against messages for the body when needed.
pub fn get_pinned_ids_by_channel(
    conn: &Connection,
    channel_id: &str,
) -> Result<Vec<String>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT message_id FROM pinned_messages \
         WHERE channel_id = ?1 ORDER BY pinned_at DESC",
    )?;
    let rows = stmt.query_map([channel_id], |row| row.get::<_, String>(0))?;
    rows.collect()
}

/// All pinned message ids for an entire team, grouped client-side by
/// channel_id. Used to seed the client store in sync:init without
/// running N per-channel queries.
pub fn get_pins_by_team(
    conn: &Connection,
    team_id: &str,
) -> Result<Vec<PinnedMessage>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT message_id, channel_id, team_id, pinned_by, pinned_at \
         FROM pinned_messages WHERE team_id = ?1 ORDER BY pinned_at DESC",
    )?;
    let rows = stmt.query_map([team_id], |row| {
        Ok(PinnedMessage {
            message_id: row.get(0)?,
            channel_id: row.get(1)?,
            team_id: row.get(2)?,
            pinned_by: row.get(3)?,
            pinned_at: row.get(4)?,
        })
    })?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::*;

    fn seed(db: &crate::db::Database) {
        db.with_conn(|c| crate::db::create_user(c, &make_user("u1", "alice", &[1u8; 32]))).unwrap();
        db.with_conn(|c| crate::db::create_team(c, &make_team("t1", "Team", "u1"))).unwrap();
        db.with_conn(|c| crate::db::create_channel(c, &make_channel("c1", "t1", "general", "u1"))).unwrap();
    }

    fn seed_message(db: &crate::db::Database, id: &str) {
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO messages (id, channel_id, dm_channel_id, author_id, content, type, deleted, lamport_ts, created_at)
                 VALUES (?1, 'c1', '', 'u1', 'hi', 'text', 0, 1, datetime('now'))",
                [id],
            )?;
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn pin_then_is_pinned_then_unpin_roundtrip() {
        let db = test_db();
        seed(&db);
        seed_message(&db, "m1");
        db.with_conn(|c| {
            assert!(!is_pinned(c, "m1")?);
            pin_message(c, "m1", "c1", "t1", "u1")?;
            assert!(is_pinned(c, "m1")?);
            unpin_message(c, "m1")?;
            assert!(!is_pinned(c, "m1")?);
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn pin_is_idempotent_via_or_ignore() {
        let db = test_db();
        seed(&db);
        seed_message(&db, "m1");
        db.with_conn(|c| {
            pin_message(c, "m1", "c1", "t1", "u1")?;
            pin_message(c, "m1", "c1", "t1", "u1")?;
            let ids = get_pinned_ids_by_channel(c, "c1")?;
            assert_eq!(ids.len(), 1);
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn unpin_unknown_message_is_a_noop() {
        let db = test_db();
        seed(&db);
        db.with_conn(|c| {
            assert!(unpin_message(c, "no-such-message").is_ok());
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn get_pinned_ids_by_channel_returns_only_that_channel() {
        let db = test_db();
        seed(&db);
        // Second channel + message in the same team.
        db.with_conn(|c| crate::db::create_channel(c, &make_channel("c2", "t1", "ops", "u1"))).unwrap();
        seed_message(&db, "m1");
        // m2 belongs to c2.
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO messages (id, channel_id, dm_channel_id, author_id, content, type, deleted, lamport_ts, created_at)
                 VALUES ('m2', 'c2', '', 'u1', 'hi', 'text', 0, 2, datetime('now'))",
                [],
            )?;
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
        db.with_conn(|c| {
            pin_message(c, "m1", "c1", "t1", "u1")?;
            pin_message(c, "m2", "c2", "t1", "u1")?;
            let c1_pins = get_pinned_ids_by_channel(c, "c1")?;
            let c2_pins = get_pinned_ids_by_channel(c, "c2")?;
            assert_eq!(c1_pins, vec!["m1"]);
            assert_eq!(c2_pins, vec!["m2"]);
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn get_pins_by_team_includes_every_channel() {
        let db = test_db();
        seed(&db);
        db.with_conn(|c| crate::db::create_channel(c, &make_channel("c2", "t1", "ops", "u1"))).unwrap();
        seed_message(&db, "m1");
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO messages (id, channel_id, dm_channel_id, author_id, content, type, deleted, lamport_ts, created_at)
                 VALUES ('m2', 'c2', '', 'u1', 'hi', 'text', 0, 2, datetime('now'))",
                [],
            )?;
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
        db.with_conn(|c| {
            pin_message(c, "m1", "c1", "t1", "u1")?;
            pin_message(c, "m2", "c2", "t1", "u1")?;
            let team_pins = get_pins_by_team(c, "t1")?;
            assert_eq!(team_pins.len(), 2);
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }
}
