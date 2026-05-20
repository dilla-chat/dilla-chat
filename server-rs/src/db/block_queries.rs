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
