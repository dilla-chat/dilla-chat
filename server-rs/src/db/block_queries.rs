// user_blocks CRUD + a hot-path predicate for "would this recipient see
// this author's traffic?". Both directions are checked: A blocks B is
// equivalent to "A doesn't see B's messages". B is never told.

use rusqlite::{params, Connection};

pub fn block_user(
    conn: &Connection,
    blocker_id: &str,
    blocked_id: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT OR IGNORE INTO user_blocks (blocker_id, blocked_id) VALUES (?1, ?2)",
        params![blocker_id, blocked_id],
    )?;
    Ok(())
}

pub fn unblock_user(
    conn: &Connection,
    blocker_id: &str,
    blocked_id: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM user_blocks WHERE blocker_id = ?1 AND blocked_id = ?2",
        params![blocker_id, blocked_id],
    )?;
    Ok(())
}

/// Everyone `blocker_id` has blocked. Used to seed the client store and
/// to filter outbound WS traffic.
pub fn list_blocked(
    conn: &Connection,
    blocker_id: &str,
) -> Result<Vec<String>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT blocked_id FROM user_blocks WHERE blocker_id = ?1 ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map([blocker_id], |row| row.get::<_, String>(0))?;
    rows.collect()
}

/// True iff `blocker_id` has blocked `blocked_id`. Cheap PK lookup —
/// the hub uses this to gate every message:new broadcast.
pub fn is_blocked(
    conn: &Connection,
    blocker_id: &str,
    blocked_id: &str,
) -> Result<bool, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT 1 FROM user_blocks WHERE blocker_id = ?1 AND blocked_id = ?2 LIMIT 1",
    )?;
    stmt.exists(params![blocker_id, blocked_id])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::*;

    #[test]
    fn block_unblock_roundtrip() {
        let db = test_db();
        db.with_conn(|c| crate::db::create_user(c, &make_user("u1", "alice", &[1u8; 32]))).unwrap();
        db.with_conn(|c| crate::db::create_user(c, &make_user("u2", "bob", &[2u8; 32]))).unwrap();

        db.with_conn(|c| {
            block_user(c, "u1", "u2")?;
            assert!(is_blocked(c, "u1", "u2")?);
            unblock_user(c, "u1", "u2")?;
            assert!(!is_blocked(c, "u1", "u2")?);
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn block_is_directional() {
        let db = test_db();
        db.with_conn(|c| crate::db::create_user(c, &make_user("u1", "alice", &[1u8; 32]))).unwrap();
        db.with_conn(|c| crate::db::create_user(c, &make_user("u2", "bob", &[2u8; 32]))).unwrap();

        db.with_conn(|c| {
            block_user(c, "u1", "u2")?;
            // u1 blocked u2; the reverse direction is NOT implied.
            assert!(is_blocked(c, "u1", "u2")?);
            assert!(!is_blocked(c, "u2", "u1")?);
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn block_user_is_idempotent_via_or_ignore() {
        let db = test_db();
        db.with_conn(|c| crate::db::create_user(c, &make_user("u1", "alice", &[1u8; 32]))).unwrap();
        db.with_conn(|c| crate::db::create_user(c, &make_user("u2", "bob", &[2u8; 32]))).unwrap();

        db.with_conn(|c| {
            block_user(c, "u1", "u2")?;
            block_user(c, "u1", "u2")?;
            block_user(c, "u1", "u2")?;
            let list = list_blocked(c, "u1")?;
            assert_eq!(list.len(), 1);
            assert_eq!(list[0], "u2");
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn unblock_unknown_pair_is_a_noop() {
        let db = test_db();
        db.with_conn(|c| {
            assert!(unblock_user(c, "nobody", "nope").is_ok());
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn list_blocked_returns_empty_for_user_with_no_blocks() {
        let db = test_db();
        db.with_conn(|c| crate::db::create_user(c, &make_user("u1", "alice", &[1u8; 32]))).unwrap();
        db.with_conn(|c| {
            let list = list_blocked(c, "u1")?;
            assert!(list.is_empty());
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }
}
