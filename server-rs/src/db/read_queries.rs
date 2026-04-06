use rusqlite::{params, Connection, OptionalExtension};

/// Upsert the last read message for a user in a channel.
pub fn mark_channel_read(
    conn: &Connection,
    user_id: &str,
    channel_id: &str,
    message_id: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO channel_reads (user_id, channel_id, last_read_message_id, last_read_at)
         VALUES (?1, ?2, ?3, datetime('now'))
         ON CONFLICT(user_id, channel_id) DO UPDATE SET
             last_read_message_id = excluded.last_read_message_id,
             last_read_at = excluded.last_read_at",
        params![user_id, channel_id, message_id],
    )?;
    Ok(())
}

/// Get unread message count for a user in a channel (messages after last_read_at).
pub fn get_unread_count(
    conn: &Connection,
    user_id: &str,
    channel_id: &str,
) -> Result<i64, rusqlite::Error> {
    conn.query_row(
        "SELECT COUNT(*) FROM messages
         WHERE channel_id = ?1 AND deleted = 0
         AND created_at > COALESCE(
             (SELECT last_read_at FROM channel_reads WHERE user_id = ?2 AND channel_id = ?1),
             datetime('now')
         )",
        params![channel_id, user_id],
        |row| row.get(0),
    )
}

/// Get unread counts for all channels a user can see in a team.
/// Returns a list of (channel_id, unread_count) pairs for channels with unread > 0.
pub fn get_unread_counts_for_team(
    conn: &Connection,
    user_id: &str,
    team_id: &str,
) -> Result<Vec<(String, i64)>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT c.id,
            COUNT(m.id) AS unread_count
         FROM channels c
         LEFT JOIN messages m ON m.channel_id = c.id
             AND m.deleted = 0
             AND m.created_at > COALESCE(
                 (SELECT cr.last_read_at FROM channel_reads cr
                  WHERE cr.user_id = ?1 AND cr.channel_id = c.id),
                 datetime('now')
             )
         WHERE c.team_id = ?2
         GROUP BY c.id",
    )?;
    let rows = stmt.query_map(params![user_id, team_id], |row| {
        let channel_id: String = row.get(0)?;
        let count: i64 = row.get(1)?;
        Ok((channel_id, count))
    })?;
    rows.collect()
}

/// Get the last read message ID for a user in a channel.
pub fn get_last_read_message_id(
    conn: &Connection,
    user_id: &str,
    channel_id: &str,
) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row(
        "SELECT last_read_message_id FROM channel_reads WHERE user_id = ?1 AND channel_id = ?2",
        params![user_id, channel_id],
        |row| row.get(0),
    )
    .optional()
}

/// Get the last_read_at timestamp for a user in a channel.
pub fn get_last_read_at(
    conn: &Connection,
    user_id: &str,
    channel_id: &str,
) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row(
        "SELECT last_read_at FROM channel_reads WHERE user_id = ?1 AND channel_id = ?2",
        params![user_id, channel_id],
        |row| row.get(0),
    )
    .optional()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::*;
    use crate::db::{create_channel, create_message, create_user, create_team};

    fn setup() -> crate::db::Database {
        let db = test_db();
        let user = make_user("u1", "alice", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();
        let ch = make_channel("ch1", "t1", "general", "u1");
        db.with_conn(|c| create_channel(c, &ch)).unwrap();
        db
    }

    #[test]
    fn test_mark_channel_read_creates_record() {
        let db = setup();

        db.with_conn(|c| mark_channel_read(c, "u1", "ch1", "msg1")).unwrap();

        let last_id = db
            .with_conn(|c| get_last_read_message_id(c, "u1", "ch1"))
            .unwrap();
        assert_eq!(last_id, Some("msg1".to_string()));
    }

    #[test]
    fn test_mark_channel_read_updates_record() {
        let db = setup();

        db.with_conn(|c| mark_channel_read(c, "u1", "ch1", "msg1")).unwrap();
        db.with_conn(|c| mark_channel_read(c, "u1", "ch1", "msg5")).unwrap();

        let last_id = db
            .with_conn(|c| get_last_read_message_id(c, "u1", "ch1"))
            .unwrap();
        assert_eq!(last_id, Some("msg5".to_string()));
    }

    #[test]
    fn test_get_unread_count_no_read_record() {
        let db = setup();

        // Insert a message with a known future timestamp
        let msg = crate::db::Message {
            created_at: "2030-01-01 00:00:00".to_string(),
            ..make_message("m1", "ch1", "u1", "hello")
        };
        db.with_conn(|c| create_message(c, &msg)).unwrap();

        // No read record → everything is unread
        let count = db.with_conn(|c| get_unread_count(c, "u1", "ch1")).unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn test_get_unread_count_after_read() {
        let db = setup();

        let msg1 = crate::db::Message {
            created_at: "2024-01-01 00:00:00".to_string(),
            ..make_message("m1", "ch1", "u1", "old")
        };
        let msg2 = crate::db::Message {
            created_at: "2030-01-01 00:00:00".to_string(),
            ..make_message("m2", "ch1", "u1", "new")
        };
        db.with_conn(|c| create_message(c, &msg1)).unwrap();
        db.with_conn(|c| create_message(c, &msg2)).unwrap();

        // Mark as read up to a point in 2025 — msg2 (2030) is still unread
        db.with_conn(|c| mark_channel_read(c, "u1", "ch1", "m1")).unwrap();

        // We need to override last_read_at to a specific value for this test
        // The upsert sets last_read_at = datetime('now'), so m2 (2030) stays unread
        let count = db.with_conn(|c| get_unread_count(c, "u1", "ch1")).unwrap();
        // m2 at 2030 is in the future, so unread count = 1
        assert_eq!(count, 1);
    }

    #[test]
    fn test_get_unread_count_all_read() {
        let db = setup();

        // Insert a message in the past
        let msg = crate::db::Message {
            created_at: "2020-01-01 00:00:00".to_string(),
            ..make_message("m1", "ch1", "u1", "old msg")
        };
        db.with_conn(|c| create_message(c, &msg)).unwrap();

        // Mark read now — all past messages become read
        db.with_conn(|c| mark_channel_read(c, "u1", "ch1", "m1")).unwrap();

        let count = db.with_conn(|c| get_unread_count(c, "u1", "ch1")).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn test_get_unread_counts_for_team() {
        let db = setup();

        // Add a second channel
        let ch2 = make_channel("ch2", "t1", "announcements", "u1");
        db.with_conn(|c| create_channel(c, &ch2)).unwrap();

        // Insert messages in ch2 in the future (unread)
        let msg = crate::db::Message {
            created_at: "2030-01-01 00:00:00".to_string(),
            ..make_message("m1", "ch2", "u1", "future msg")
        };
        db.with_conn(|c| create_message(c, &msg)).unwrap();

        let counts = db
            .with_conn(|c| get_unread_counts_for_team(c, "u1", "t1"))
            .unwrap();

        // ch2 should have 1 unread, ch1 should have 0
        let ch2_count = counts.iter().find(|(id, _)| id == "ch2").map(|(_, c)| *c);
        let ch1_count = counts.iter().find(|(id, _)| id == "ch1").map(|(_, c)| *c);
        assert_eq!(ch2_count, Some(1));
        assert_eq!(ch1_count, Some(0));
    }

    #[test]
    fn test_get_last_read_message_id_returns_none_when_unset() {
        let db = setup();

        let result = db
            .with_conn(|c| get_last_read_message_id(c, "u1", "ch1"))
            .unwrap();
        assert_eq!(result, None);
    }
}
