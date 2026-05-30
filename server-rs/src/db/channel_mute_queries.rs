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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::*;

    fn seed(db: &crate::db::Database) {
        db.with_conn(|c| crate::db::create_user(c, &make_user("u1", "alice", &[1u8; 32]))).unwrap();
        db.with_conn(|c| crate::db::create_team(c, &make_team("t1", "Team", "u1"))).unwrap();
        db.with_conn(|c| crate::db::create_channel(c, &make_channel("c1", "t1", "general", "u1"))).unwrap();
    }

    #[test]
    fn upsert_mute_then_is_muted_then_delete_roundtrip() {
        let db = test_db();
        seed(&db);
        db.with_conn(|c| {
            assert!(!is_channel_muted_for(c, "u1", "c1")?);
            upsert_channel_mute(c, "u1", "c1", None)?;
            assert!(is_channel_muted_for(c, "u1", "c1")?);
            delete_channel_mute(c, "u1", "c1")?;
            assert!(!is_channel_muted_for(c, "u1", "c1")?);
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn upsert_replaces_the_muted_until_on_conflict() {
        let db = test_db();
        seed(&db);
        db.with_conn(|c| {
            upsert_channel_mute(c, "u1", "c1", None)?;
            // Re-upsert with a future expiry — second value wins.
            upsert_channel_mute(c, "u1", "c1", Some("2099-12-31 00:00:00"))?;
            let muted = get_muted_channels(c, "u1")?;
            assert_eq!(muted.len(), 1);
            assert_eq!(muted[0].1.as_deref(), Some("2099-12-31 00:00:00"));
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn expired_mute_is_not_returned_as_muted() {
        let db = test_db();
        seed(&db);
        db.with_conn(|c| {
            upsert_channel_mute(c, "u1", "c1", Some("2000-01-01 00:00:00"))?;
            assert!(!is_channel_muted_for(c, "u1", "c1")?);
            let muted = get_muted_channels(c, "u1")?;
            assert!(muted.is_empty());
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn null_muted_until_means_indefinite() {
        let db = test_db();
        seed(&db);
        db.with_conn(|c| {
            upsert_channel_mute(c, "u1", "c1", None)?;
            assert!(is_channel_muted_for(c, "u1", "c1")?);
            let muted = get_muted_channels(c, "u1")?;
            assert_eq!(muted.len(), 1);
            assert!(muted[0].1.is_none());
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn get_muted_channels_returns_empty_for_user_without_mutes() {
        let db = test_db();
        seed(&db);
        db.with_conn(|c| {
            assert!(get_muted_channels(c, "u1")?.is_empty());
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn delete_channel_mute_unknown_pair_is_noop() {
        let db = test_db();
        seed(&db);
        db.with_conn(|c| {
            assert!(delete_channel_mute(c, "u1", "no-such-channel").is_ok());
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }
}
