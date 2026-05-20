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
