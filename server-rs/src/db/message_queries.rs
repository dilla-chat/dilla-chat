use super::models::*;
use super::{nullable, now_str, row_to_message};
use rusqlite::{params, Connection, OptionalExtension};

pub fn create_message(conn: &Connection, msg: &Message) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO messages (id, channel_id, dm_channel_id, author_id, content, type, thread_id, lamport_ts, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            msg.id,
            nullable(&msg.channel_id),
            nullable(&msg.dm_channel_id),
            msg.author_id,
            msg.content,
            msg.msg_type,
            nullable(&msg.thread_id),
            msg.lamport_ts,
            msg.created_at,
        ],
    )?;
    Ok(())
}

pub fn get_message_by_id(
    conn: &Connection,
    id: &str,
) -> Result<Option<Message>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, channel_id, dm_channel_id, author_id, content, type, thread_id, edited_at, deleted, lamport_ts, created_at
         FROM messages WHERE id = ?1",
        [id],
        row_to_message,
    )
    .optional()
}

pub fn get_messages_by_channel(
    conn: &Connection,
    channel_id: &str,
    before: &str,
    limit: i32,
) -> Result<Vec<Message>, rusqlite::Error> {
    let mut messages = if before.is_empty() {
        let mut stmt = conn.prepare(
            "SELECT id, channel_id, dm_channel_id, author_id, content, type, thread_id, edited_at, deleted, lamport_ts, created_at
             FROM messages WHERE channel_id = ?1 AND thread_id IS NULL
             ORDER BY created_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![channel_id, limit], row_to_message)?;
        rows.collect::<Result<Vec<_>, _>>()?
    } else {
        let mut stmt = conn.prepare(
            "SELECT id, channel_id, dm_channel_id, author_id, content, type, thread_id, edited_at, deleted, lamport_ts, created_at
             FROM messages WHERE channel_id = ?1 AND thread_id IS NULL AND created_at < ?2
             ORDER BY created_at DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![channel_id, before, limit], |row| {
            row_to_message(row)
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    messages.reverse();
    Ok(messages)
}

pub fn update_message_content(
    conn: &Connection,
    id: &str,
    content: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE messages SET content = ?1, edited_at = ?2 WHERE id = ?3",
        params![content, now_str(), id],
    )?;
    Ok(())
}

pub fn soft_delete_message(conn: &Connection, id: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE messages SET deleted = 1, content = '' WHERE id = ?1",
        [id],
    )?;
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::*;

    #[test]
    fn test_create_message_and_fetch_by_id() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();
        let ch = make_channel("ch1", "t1", "general", "u1");
        db.with_conn(|c| crate::db::create_channel(c, &ch)).unwrap();

        let msg = make_message("m1", "ch1", "u1", "Hello world");
        db.with_conn(|c| create_message(c, &msg)).unwrap();

        let fetched = db.with_conn(|c| get_message_by_id(c, "m1")).unwrap().unwrap();
        assert_eq!(fetched.content, "Hello world");
        assert_eq!(fetched.author_id, "u1");
        assert!(!fetched.deleted);
    }

    #[test]
    fn test_get_messages_by_channel_ordering() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();
        let ch = make_channel("ch1", "t1", "general", "u1");
        db.with_conn(|c| crate::db::create_channel(c, &ch)).unwrap();

        for i in 0..5 {
            let msg = Message {
                created_at: format!("2024-01-01 00:00:0{}", i),
                ..make_message(&format!("m{}", i), "ch1", "u1", &format!("msg {}", i))
            };
            db.with_conn(|c| create_message(c, &msg)).unwrap();
        }

        let messages = db.with_conn(|c| get_messages_by_channel(c, "ch1", "", 50)).unwrap();
        assert_eq!(messages.len(), 5);
        assert_eq!(messages[0].content, "msg 0");
        assert_eq!(messages[4].content, "msg 4");
    }

    #[test]
    fn test_get_messages_by_channel_pagination() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();
        let ch = make_channel("ch1", "t1", "general", "u1");
        db.with_conn(|c| crate::db::create_channel(c, &ch)).unwrap();

        for i in 0..5 {
            let msg = Message {
                created_at: format!("2024-01-01 00:00:0{}", i),
                ..make_message(&format!("m{}", i), "ch1", "u1", &format!("msg {}", i))
            };
            db.with_conn(|c| create_message(c, &msg)).unwrap();
        }

        let messages = db.with_conn(|c| get_messages_by_channel(c, "ch1", "", 2)).unwrap();
        assert_eq!(messages.len(), 2);

        let messages = db.with_conn(|c| get_messages_by_channel(c, "ch1", "2024-01-01 00:00:03", 10)).unwrap();
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[2].content, "msg 2");
    }

    #[test]
    fn test_update_message_content() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();
        let ch = make_channel("ch1", "t1", "general", "u1");
        db.with_conn(|c| crate::db::create_channel(c, &ch)).unwrap();

        let msg = make_message("m1", "ch1", "u1", "original");
        db.with_conn(|c| create_message(c, &msg)).unwrap();

        db.with_conn(|c| update_message_content(c, "m1", "edited")).unwrap();

        let fetched = db.with_conn(|c| get_message_by_id(c, "m1")).unwrap().unwrap();
        assert_eq!(fetched.content, "edited");
        assert!(fetched.edited_at.is_some());
    }

    #[test]
    fn test_soft_delete_message() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();
        let ch = make_channel("ch1", "t1", "general", "u1");
        db.with_conn(|c| crate::db::create_channel(c, &ch)).unwrap();

        let msg = make_message("m1", "ch1", "u1", "secret");
        db.with_conn(|c| create_message(c, &msg)).unwrap();

        db.with_conn(|c| soft_delete_message(c, "m1")).unwrap();

        let fetched = db.with_conn(|c| get_message_by_id(c, "m1")).unwrap().unwrap();
        assert!(fetched.deleted);
        assert_eq!(fetched.content, "");
    }
}
