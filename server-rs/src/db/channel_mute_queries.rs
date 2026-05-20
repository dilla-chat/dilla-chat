use rusqlite::{params, Connection};

/// Return the channel IDs the given user has currently muted. A row with
/// `muted_until` in the past is treated as not muted and excluded.
pub fn get_muted_channels(
    conn: &Connection,
    user_id: &str,
) -> Result<Vec<(String, Option<String>)>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT channel_id, muted_until FROM channel_mutes
         WHERE user_id = ?1
           AND (muted_until IS NULL OR muted_until > datetime('now'))",
    )?;
    let rows = stmt.query_map(params![user_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
    })?;
    rows.collect()
}

pub fn upsert_channel_mute(
    conn: &Connection,
    user_id: &str,
    channel_id: &str,
    muted_until: Option<&str>,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO channel_mutes (user_id, channel_id, muted_until, created_at)
         VALUES (?1, ?2, ?3, datetime('now'))
         ON CONFLICT(user_id, channel_id) DO UPDATE SET muted_until = excluded.muted_until",
        params![user_id, channel_id, muted_until],
    )?;
    Ok(())
}

pub fn delete_channel_mute(
    conn: &Connection,
    user_id: &str,
    channel_id: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM channel_mutes WHERE user_id = ?1 AND channel_id = ?2",
        params![user_id, channel_id],
    )?;
    Ok(())
}

/// Quick boolean check used by notification dispatch paths.
pub fn is_channel_muted_for(
    conn: &Connection,
    user_id: &str,
    channel_id: &str,
) -> Result<bool, rusqlite::Error> {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM channel_mutes
             WHERE user_id = ?1 AND channel_id = ?2
               AND (muted_until IS NULL OR muted_until > datetime('now'))",
            params![user_id, channel_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    Ok(n > 0)
}
