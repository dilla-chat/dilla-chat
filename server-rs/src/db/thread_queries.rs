use super::models::*;
use super::now_str;
use rusqlite::{params, Connection, OptionalExtension};

pub fn create_thread(conn: &Connection, thread: &Thread) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO threads (id, channel_id, parent_message_id, team_id, creator_id, title, message_count, last_message_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            thread.id,
            thread.channel_id,
            thread.parent_message_id,
            thread.team_id,
            thread.creator_id,
            thread.title,
            thread.message_count,
            thread.last_message_at,
            thread.created_at,
        ],
    )?;
    Ok(())
}

pub fn get_thread(conn: &Connection, id: &str) -> Result<Option<Thread>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, channel_id, parent_message_id, team_id, creator_id, title, message_count, last_message_at, created_at
         FROM threads WHERE id = ?1",
        [id],
        row_to_thread,
    )
    .optional()
}

pub fn get_thread_by_parent_message(
    conn: &Connection,
    parent_message_id: &str,
) -> Result<Option<Thread>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, channel_id, parent_message_id, team_id, creator_id, title, message_count, last_message_at, created_at
         FROM threads WHERE parent_message_id = ?1",
        [parent_message_id],
        row_to_thread,
    )
    .optional()
}

pub fn get_channel_threads(
    conn: &Connection,
    channel_id: &str,
) -> Result<Vec<Thread>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, channel_id, parent_message_id, team_id, creator_id, title, message_count, last_message_at, created_at
         FROM threads WHERE channel_id = ?1 ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map([channel_id], row_to_thread)?;
    rows.collect()
}

pub fn update_thread(conn: &Connection, thread: &Thread) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE threads SET title = ?1, message_count = ?2, last_message_at = ?3 WHERE id = ?4",
        params![
            thread.title,
            thread.message_count,
            thread.last_message_at,
            thread.id
        ],
    )?;
    Ok(())
}

pub fn delete_thread(conn: &Connection, id: &str) -> Result<(), rusqlite::Error> {
    // Delete thread messages first.
    conn.execute(
        "DELETE FROM messages WHERE thread_id = ?1",
        [id],
    )?;
    conn.execute("DELETE FROM threads WHERE id = ?1", [id])?;
    Ok(())
}

pub fn create_thread_message(conn: &Connection, msg: &Message) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO messages (id, channel_id, author_id, content, type, thread_id, lamport_ts, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            msg.id,
            msg.channel_id,
            msg.author_id,
            msg.content,
            msg.msg_type,
            msg.thread_id,
            msg.lamport_ts,
            msg.created_at,
        ],
    )?;

    // Update thread message count and last_message_at.
    let now = now_str();
    conn.execute(
        "UPDATE threads SET message_count = message_count + 1, last_message_at = ?1 WHERE id = ?2",
        params![now, msg.thread_id],
    )?;
    Ok(())
}

pub fn get_thread_messages(
    conn: &Connection,
    thread_id: &str,
    before: &str,
    limit: i32,
) -> Result<Vec<Message>, rusqlite::Error> {
    let mut messages = if before.is_empty() {
        let mut stmt = conn.prepare(
            "SELECT id, channel_id, dm_channel_id, author_id, content, type, thread_id, edited_at, deleted, lamport_ts, created_at
             FROM messages WHERE thread_id = ?1
             ORDER BY created_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![thread_id, limit], row_to_message)?;
        rows.collect::<Result<Vec<_>, _>>()?
    } else {
        let mut stmt = conn.prepare(
            "SELECT id, channel_id, dm_channel_id, author_id, content, type, thread_id, edited_at, deleted, lamport_ts, created_at
             FROM messages WHERE thread_id = ?1 AND created_at < ?2
             ORDER BY created_at DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![thread_id, before, limit], |row| {
            row_to_message(row)
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    messages.reverse();
    Ok(messages)
}

fn row_to_thread(row: &rusqlite::Row) -> Result<Thread, rusqlite::Error> {
    Ok(Thread {
        id: row.get(0)?,
        channel_id: row.get(1)?,
        parent_message_id: row.get(2)?,
        team_id: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        creator_id: row.get(4)?,
        title: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
        message_count: row.get(6)?,
        last_message_at: row.get(7)?,
        created_at: row.get(8)?,
    })
}

fn row_to_message(row: &rusqlite::Row) -> Result<Message, rusqlite::Error> {
    Ok(Message {
        id: row.get(0)?,
        channel_id: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
        dm_channel_id: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        author_id: row.get(3)?,
        content: row.get(4)?,
        msg_type: row.get(5)?,
        thread_id: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
        edited_at: row.get(7)?,
        deleted: row.get::<_, i32>(8)? != 0,
        lamport_ts: row.get(9)?,
        created_at: row.get(10)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn test_db() -> Database {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
        db.run_migrations().unwrap();
        db
    }

    /// Sets up a user, team, channel, and parent message for thread tests.
    fn setup_for_threads(db: &Database) {
        let now = crate::db::now_str();
        let user = User {
            id: "u1".into(), username: "alice".into(), display_name: "Alice".into(),
            public_key: vec![1u8; 32], avatar_url: String::new(), status_text: String::new(),
            status_type: "online".into(), is_admin: false,
            created_at: now.clone(), updated_at: now.clone(),
        };
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();

        let team = Team {
            id: "t1".into(), name: "Team".into(), description: String::new(),
            icon_url: String::new(), created_by: "u1".into(), max_file_size: 1024,
            allow_member_invites: true, created_at: now.clone(), updated_at: now.clone(),
        };
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();

        let channel = Channel {
            id: "ch1".into(), team_id: "t1".into(), name: "general".into(),
            topic: String::new(), channel_type: "text".into(), position: 0,
            category: String::new(), created_by: "u1".into(),
            created_at: now.clone(), updated_at: now.clone(),
        };
        db.with_conn(|c| crate::db::create_channel(c, &channel)).unwrap();

        // Parent message for threads
        let msg = Message {
            id: "pm1".into(), channel_id: "ch1".into(), dm_channel_id: String::new(),
            author_id: "u1".into(), content: "parent".into(), msg_type: "text".into(),
            thread_id: String::new(), edited_at: None, deleted: false,
            lamport_ts: 0, created_at: now,
        };
        db.with_conn(|c| crate::db::create_message(c, &msg)).unwrap();
    }

    #[test]
    fn test_create_thread_and_fetch() {
        let db = test_db();
        setup_for_threads(&db);

        let thread = Thread {
            id: "thr1".into(), channel_id: "ch1".into(), parent_message_id: "pm1".into(),
            team_id: "t1".into(), creator_id: "u1".into(), title: "Discussion".into(),
            message_count: 0, last_message_at: None, created_at: crate::db::now_str(),
        };
        db.with_conn(|c| create_thread(c, &thread)).unwrap();

        let fetched = db.with_conn(|c| get_thread(c, "thr1")).unwrap().unwrap();
        assert_eq!(fetched.title, "Discussion");
        assert_eq!(fetched.channel_id, "ch1");
        assert_eq!(fetched.message_count, 0);
    }

    #[test]
    fn test_get_thread_by_parent_message() {
        let db = test_db();
        setup_for_threads(&db);

        let thread = Thread {
            id: "thr1".into(), channel_id: "ch1".into(), parent_message_id: "pm1".into(),
            team_id: "t1".into(), creator_id: "u1".into(), title: "Thread".into(),
            message_count: 0, last_message_at: None, created_at: crate::db::now_str(),
        };
        db.with_conn(|c| create_thread(c, &thread)).unwrap();

        let fetched = db.with_conn(|c| get_thread_by_parent_message(c, "pm1")).unwrap().unwrap();
        assert_eq!(fetched.id, "thr1");
    }

    #[test]
    fn test_get_channel_threads() {
        let db = test_db();
        setup_for_threads(&db);

        // Create a second parent message
        let now = crate::db::now_str();
        let msg2 = Message {
            id: "pm2".into(), channel_id: "ch1".into(), dm_channel_id: String::new(),
            author_id: "u1".into(), content: "parent2".into(), msg_type: "text".into(),
            thread_id: String::new(), edited_at: None, deleted: false,
            lamport_ts: 1, created_at: now.clone(),
        };
        db.with_conn(|c| crate::db::create_message(c, &msg2)).unwrap();

        let t1 = Thread {
            id: "thr1".into(), channel_id: "ch1".into(), parent_message_id: "pm1".into(),
            team_id: "t1".into(), creator_id: "u1".into(), title: "T1".into(),
            message_count: 0, last_message_at: None, created_at: now.clone(),
        };
        let t2 = Thread {
            id: "thr2".into(), channel_id: "ch1".into(), parent_message_id: "pm2".into(),
            team_id: "t1".into(), creator_id: "u1".into(), title: "T2".into(),
            message_count: 0, last_message_at: None, created_at: now,
        };
        db.with_conn(|c| create_thread(c, &t1)).unwrap();
        db.with_conn(|c| create_thread(c, &t2)).unwrap();

        let threads = db.with_conn(|c| get_channel_threads(c, "ch1")).unwrap();
        assert_eq!(threads.len(), 2);
    }

    #[test]
    fn test_update_thread() {
        let db = test_db();
        setup_for_threads(&db);

        let mut thread = Thread {
            id: "thr1".into(), channel_id: "ch1".into(), parent_message_id: "pm1".into(),
            team_id: "t1".into(), creator_id: "u1".into(), title: "Old".into(),
            message_count: 0, last_message_at: None, created_at: crate::db::now_str(),
        };
        db.with_conn(|c| create_thread(c, &thread)).unwrap();

        thread.title = "New Title".to_string();
        thread.message_count = 5;
        thread.last_message_at = Some(crate::db::now_str());
        db.with_conn(|c| update_thread(c, &thread)).unwrap();

        let fetched = db.with_conn(|c| get_thread(c, "thr1")).unwrap().unwrap();
        assert_eq!(fetched.title, "New Title");
        assert_eq!(fetched.message_count, 5);
        assert!(fetched.last_message_at.is_some());
    }

    #[test]
    fn test_create_thread_message_increments_count() {
        let db = test_db();
        setup_for_threads(&db);

        let thread = Thread {
            id: "thr1".into(), channel_id: "ch1".into(), parent_message_id: "pm1".into(),
            team_id: "t1".into(), creator_id: "u1".into(), title: "Thread".into(),
            message_count: 0, last_message_at: None, created_at: crate::db::now_str(),
        };
        db.with_conn(|c| create_thread(c, &thread)).unwrap();

        let reply = Message {
            id: "reply1".into(), channel_id: "ch1".into(), dm_channel_id: String::new(),
            author_id: "u1".into(), content: "reply".into(), msg_type: "text".into(),
            thread_id: "thr1".into(), edited_at: None, deleted: false,
            lamport_ts: 1, created_at: crate::db::now_str(),
        };
        db.with_conn(|c| create_thread_message(c, &reply)).unwrap();

        let fetched = db.with_conn(|c| get_thread(c, "thr1")).unwrap().unwrap();
        assert_eq!(fetched.message_count, 1);
        assert!(fetched.last_message_at.is_some());
    }

    #[test]
    fn test_get_thread_messages() {
        let db = test_db();
        setup_for_threads(&db);

        let thread = Thread {
            id: "thr1".into(), channel_id: "ch1".into(), parent_message_id: "pm1".into(),
            team_id: "t1".into(), creator_id: "u1".into(), title: "Thread".into(),
            message_count: 0, last_message_at: None, created_at: crate::db::now_str(),
        };
        db.with_conn(|c| create_thread(c, &thread)).unwrap();

        for i in 0..3 {
            let reply = Message {
                id: format!("r{}", i), channel_id: "ch1".into(), dm_channel_id: String::new(),
                author_id: "u1".into(), content: format!("reply {}", i), msg_type: "text".into(),
                thread_id: "thr1".into(), edited_at: None, deleted: false,
                lamport_ts: i as i64, created_at: format!("2024-01-01 00:00:0{}", i),
            };
            db.with_conn(|c| create_thread_message(c, &reply)).unwrap();
        }

        let messages = db.with_conn(|c| get_thread_messages(c, "thr1", "", 50)).unwrap();
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0].content, "reply 0");
        assert_eq!(messages[2].content, "reply 2");
    }

    #[test]
    fn test_delete_thread_removes_messages() {
        let db = test_db();
        setup_for_threads(&db);

        let thread = Thread {
            id: "thr1".into(), channel_id: "ch1".into(), parent_message_id: "pm1".into(),
            team_id: "t1".into(), creator_id: "u1".into(), title: "Thread".into(),
            message_count: 0, last_message_at: None, created_at: crate::db::now_str(),
        };
        db.with_conn(|c| create_thread(c, &thread)).unwrap();

        let reply = Message {
            id: "r1".into(), channel_id: "ch1".into(), dm_channel_id: String::new(),
            author_id: "u1".into(), content: "reply".into(), msg_type: "text".into(),
            thread_id: "thr1".into(), edited_at: None, deleted: false,
            lamport_ts: 1, created_at: crate::db::now_str(),
        };
        db.with_conn(|c| create_thread_message(c, &reply)).unwrap();

        db.with_conn(|c| delete_thread(c, "thr1")).unwrap();

        let thread = db.with_conn(|c| get_thread(c, "thr1")).unwrap();
        assert!(thread.is_none());

        let messages = db.with_conn(|c| get_thread_messages(c, "thr1", "", 50)).unwrap();
        assert!(messages.is_empty());
    }
}
