use super::models::*;
use super::{nullable, now_str, row_to_message};
use rusqlite::{params, Connection, OptionalExtension};

pub fn create_dm_channel(conn: &Connection, dm: &DMChannel) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO dm_channels (id, team_id, type, name, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![dm.id, nullable(&dm.team_id), dm.dm_type, dm.name, dm.created_at],
    )?;
    Ok(())
}

pub fn get_dm_channel(
    conn: &Connection,
    id: &str,
) -> Result<Option<DMChannel>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, team_id, type, name, created_at FROM dm_channels WHERE id = ?1",
        [id],
        row_to_dm_channel,
    )
    .optional()
}

pub fn get_dm_channel_by_members(
    conn: &Connection,
    team_id: &str,
    user_id_1: &str,
    user_id_2: &str,
) -> Result<Option<DMChannel>, rusqlite::Error> {
    conn.query_row(
        "SELECT dc.id, dc.team_id, dc.type, dc.name, dc.created_at
         FROM dm_channels dc
         JOIN dm_members dm1 ON dm1.channel_id = dc.id AND dm1.user_id = ?2
         JOIN dm_members dm2 ON dm2.channel_id = dc.id AND dm2.user_id = ?3
         WHERE dc.team_id = ?1 AND dc.type = 'dm'",
        params![team_id, user_id_1, user_id_2],
        row_to_dm_channel,
    )
    .optional()
}

pub fn get_user_dm_channels(
    conn: &Connection,
    team_id: &str,
    user_id: &str,
) -> Result<Vec<DMChannel>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT dc.id, dc.team_id, dc.type, dc.name, dc.created_at
         FROM dm_channels dc
         JOIN dm_members dm ON dm.channel_id = dc.id
         WHERE dc.team_id = ?1 AND dm.user_id = ?2
         ORDER BY dc.created_at DESC",
    )?;
    let rows = stmt.query_map(params![team_id, user_id], row_to_dm_channel)?;
    rows.collect()
}

pub fn add_dm_members(
    conn: &Connection,
    channel_id: &str,
    user_ids: &[String],
) -> Result<(), rusqlite::Error> {
    let now = now_str();
    for uid in user_ids {
        conn.execute(
            "INSERT OR IGNORE INTO dm_members (channel_id, user_id, joined_at) VALUES (?1, ?2, ?3)",
            params![channel_id, uid, now],
        )?;
    }
    Ok(())
}

pub fn remove_dm_member(
    conn: &Connection,
    channel_id: &str,
    user_id: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM dm_members WHERE channel_id = ?1 AND user_id = ?2",
        params![channel_id, user_id],
    )?;
    Ok(())
}

pub fn get_dm_members(
    conn: &Connection,
    channel_id: &str,
) -> Result<Vec<DMMember>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT channel_id, user_id, joined_at FROM dm_members WHERE channel_id = ?1",
    )?;
    let rows = stmt.query_map([channel_id], |row| {
        Ok(DMMember {
            channel_id: row.get(0)?,
            user_id: row.get(1)?,
            joined_at: row.get(2)?,
        })
    })?;
    rows.collect()
}

pub fn is_dm_member(
    conn: &Connection,
    channel_id: &str,
    user_id: &str,
) -> Result<bool, rusqlite::Error> {
    let count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM dm_members WHERE channel_id = ?1 AND user_id = ?2",
        params![channel_id, user_id],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

pub fn create_dm_message(conn: &Connection, msg: &Message) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO messages (id, channel_id, dm_channel_id, author_id, content, type, lamport_ts, created_at)
         VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            msg.id,
            msg.dm_channel_id,
            msg.author_id,
            msg.content,
            msg.msg_type,
            msg.lamport_ts,
            msg.created_at,
        ],
    )?;
    Ok(())
}

pub fn get_dm_messages(
    conn: &Connection,
    dm_channel_id: &str,
    before: &str,
    limit: i32,
) -> Result<Vec<Message>, rusqlite::Error> {
    let mut messages = if before.is_empty() {
        let mut stmt = conn.prepare(
            "SELECT id, channel_id, dm_channel_id, author_id, content, type, thread_id, edited_at, deleted, lamport_ts, created_at
             FROM messages WHERE dm_channel_id = ?1
             ORDER BY created_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![dm_channel_id, limit], row_to_message)?;
        rows.collect::<Result<Vec<_>, _>>()?
    } else {
        let mut stmt = conn.prepare(
            "SELECT id, channel_id, dm_channel_id, author_id, content, type, thread_id, edited_at, deleted, lamport_ts, created_at
             FROM messages WHERE dm_channel_id = ?1 AND created_at < ?2
             ORDER BY created_at DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![dm_channel_id, before, limit], |row| {
            row_to_message(row)
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    messages.reverse();
    Ok(messages)
}

pub fn get_last_dm_message(
    conn: &Connection,
    dm_channel_id: &str,
) -> Result<Option<Message>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, channel_id, dm_channel_id, author_id, content, type, thread_id, edited_at, deleted, lamport_ts, created_at
         FROM messages WHERE dm_channel_id = ?1 ORDER BY created_at DESC LIMIT 1",
        [dm_channel_id],
        row_to_message,
    )
    .optional()
}

fn row_to_dm_channel(row: &rusqlite::Row) -> Result<DMChannel, rusqlite::Error> {
    Ok(DMChannel {
        id: row.get(0)?,
        team_id: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
        dm_type: row.get(2)?,
        name: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        created_at: row.get(4)?,
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

    fn make_user(id: &str, username: &str, pk: &[u8]) -> User {
        let now = crate::db::now_str();
        User {
            id: id.into(), username: username.into(), display_name: username.into(),
            public_key: pk.to_vec(), avatar_url: String::new(), status_text: String::new(),
            status_type: "online".into(), is_admin: false,
            created_at: now.clone(), updated_at: now,
        }
    }

    fn make_dm_channel(id: &str, team_id: &str) -> DMChannel {
        DMChannel {
            id: id.into(), team_id: team_id.into(), dm_type: "dm".into(),
            name: String::new(), created_at: crate::db::now_str(),
        }
    }

    fn setup_users_and_team(db: &Database) {
        let u1 = make_user("u1", "alice", &[1u8; 32]);
        let u2 = make_user("u2", "bob", &[2u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &u1)).unwrap();
        db.with_conn(|c| crate::db::create_user(c, &u2)).unwrap();
        let now = crate::db::now_str();
        let team = Team {
            id: "t1".into(), name: "Team".into(), description: String::new(),
            icon_url: String::new(), created_by: "u1".into(), max_file_size: 1024,
            allow_member_invites: true, created_at: now.clone(), updated_at: now,
        };
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();
    }

    #[test]
    fn test_create_dm_channel_and_fetch() {
        let db = test_db();
        setup_users_and_team(&db);

        let dm = make_dm_channel("dm1", "t1");
        db.with_conn(|c| create_dm_channel(c, &dm)).unwrap();

        let fetched = db.with_conn(|c| get_dm_channel(c, "dm1")).unwrap().unwrap();
        assert_eq!(fetched.id, "dm1");
        assert_eq!(fetched.dm_type, "dm");
    }

    #[test]
    fn test_add_and_get_dm_members() {
        let db = test_db();
        setup_users_and_team(&db);

        let dm = make_dm_channel("dm1", "t1");
        db.with_conn(|c| create_dm_channel(c, &dm)).unwrap();

        let user_ids = vec!["u1".to_string(), "u2".to_string()];
        db.with_conn(|c| add_dm_members(c, "dm1", &user_ids)).unwrap();

        let members = db.with_conn(|c| get_dm_members(c, "dm1")).unwrap();
        assert_eq!(members.len(), 2);
    }

    #[test]
    fn test_is_dm_member() {
        let db = test_db();
        setup_users_and_team(&db);

        let dm = make_dm_channel("dm1", "t1");
        db.with_conn(|c| create_dm_channel(c, &dm)).unwrap();
        db.with_conn(|c| add_dm_members(c, "dm1", &["u1".to_string()])).unwrap();

        assert!(db.with_conn(|c| is_dm_member(c, "dm1", "u1")).unwrap());
        assert!(!db.with_conn(|c| is_dm_member(c, "dm1", "u2")).unwrap());
    }

    #[test]
    fn test_remove_dm_member() {
        let db = test_db();
        setup_users_and_team(&db);

        let dm = make_dm_channel("dm1", "t1");
        db.with_conn(|c| create_dm_channel(c, &dm)).unwrap();
        db.with_conn(|c| add_dm_members(c, "dm1", &["u1".to_string(), "u2".to_string()])).unwrap();

        db.with_conn(|c| remove_dm_member(c, "dm1", "u2")).unwrap();

        assert!(db.with_conn(|c| is_dm_member(c, "dm1", "u1")).unwrap());
        assert!(!db.with_conn(|c| is_dm_member(c, "dm1", "u2")).unwrap());
    }

    #[test]
    fn test_get_dm_channel_by_members() {
        let db = test_db();
        setup_users_and_team(&db);

        let dm = make_dm_channel("dm1", "t1");
        db.with_conn(|c| create_dm_channel(c, &dm)).unwrap();
        db.with_conn(|c| add_dm_members(c, "dm1", &["u1".to_string(), "u2".to_string()])).unwrap();

        let found = db.with_conn(|c| get_dm_channel_by_members(c, "t1", "u1", "u2")).unwrap().unwrap();
        assert_eq!(found.id, "dm1");

        // Reverse order should also work
        let found2 = db.with_conn(|c| get_dm_channel_by_members(c, "t1", "u2", "u1")).unwrap().unwrap();
        assert_eq!(found2.id, "dm1");
    }

    #[test]
    fn test_get_user_dm_channels() {
        let db = test_db();
        setup_users_and_team(&db);

        let dm1 = make_dm_channel("dm1", "t1");
        let dm2 = make_dm_channel("dm2", "t1");
        db.with_conn(|c| create_dm_channel(c, &dm1)).unwrap();
        db.with_conn(|c| create_dm_channel(c, &dm2)).unwrap();
        db.with_conn(|c| add_dm_members(c, "dm1", &["u1".to_string()])).unwrap();
        db.with_conn(|c| add_dm_members(c, "dm2", &["u1".to_string(), "u2".to_string()])).unwrap();

        let channels = db.with_conn(|c| get_user_dm_channels(c, "t1", "u1")).unwrap();
        assert_eq!(channels.len(), 2);

        let channels_u2 = db.with_conn(|c| get_user_dm_channels(c, "t1", "u2")).unwrap();
        assert_eq!(channels_u2.len(), 1);
    }

    #[test]
    fn test_create_and_get_dm_messages() {
        let db = test_db();
        setup_users_and_team(&db);

        let dm = make_dm_channel("dm1", "t1");
        db.with_conn(|c| create_dm_channel(c, &dm)).unwrap();

        let msg = Message {
            id: "m1".into(), channel_id: String::new(), dm_channel_id: "dm1".into(),
            author_id: "u1".into(), content: "hello dm".into(), msg_type: "text".into(),
            thread_id: String::new(), edited_at: None, deleted: false,
            lamport_ts: 1, created_at: "2024-01-01 00:00:00".into(),
        };
        db.with_conn(|c| create_dm_message(c, &msg)).unwrap();

        let messages = db.with_conn(|c| get_dm_messages(c, "dm1", "", 50)).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content, "hello dm");
    }

    #[test]
    fn test_get_last_dm_message() {
        let db = test_db();
        setup_users_and_team(&db);

        let dm = make_dm_channel("dm1", "t1");
        db.with_conn(|c| create_dm_channel(c, &dm)).unwrap();

        // No messages yet
        let last = db.with_conn(|c| get_last_dm_message(c, "dm1")).unwrap();
        assert!(last.is_none());

        for i in 0..3 {
            let msg = Message {
                id: format!("m{}", i), channel_id: String::new(), dm_channel_id: "dm1".into(),
                author_id: "u1".into(), content: format!("msg {}", i), msg_type: "text".into(),
                thread_id: String::new(), edited_at: None, deleted: false,
                lamport_ts: i as i64, created_at: format!("2024-01-01 00:00:0{}", i),
            };
            db.with_conn(|c| create_dm_message(c, &msg)).unwrap();
        }

        let last = db.with_conn(|c| get_last_dm_message(c, "dm1")).unwrap().unwrap();
        assert_eq!(last.content, "msg 2");
    }

    #[test]
    fn test_dm_messages_pagination() {
        let db = test_db();
        setup_users_and_team(&db);

        let dm = make_dm_channel("dm1", "t1");
        db.with_conn(|c| create_dm_channel(c, &dm)).unwrap();

        for i in 0..5 {
            let msg = Message {
                id: format!("m{}", i), channel_id: String::new(), dm_channel_id: "dm1".into(),
                author_id: "u1".into(), content: format!("msg {}", i), msg_type: "text".into(),
                thread_id: String::new(), edited_at: None, deleted: false,
                lamport_ts: i as i64, created_at: format!("2024-01-01 00:00:0{}", i),
            };
            db.with_conn(|c| create_dm_message(c, &msg)).unwrap();
        }

        let msgs = db.with_conn(|c| get_dm_messages(c, "dm1", "", 2)).unwrap();
        assert_eq!(msgs.len(), 2);

        let msgs = db.with_conn(|c| get_dm_messages(c, "dm1", "2024-01-01 00:00:03", 10)).unwrap();
        assert_eq!(msgs.len(), 3);
    }

    #[test]
    fn test_add_dm_members_idempotent() {
        let db = test_db();
        setup_users_and_team(&db);

        let dm = make_dm_channel("dm1", "t1");
        db.with_conn(|c| create_dm_channel(c, &dm)).unwrap();

        // Adding the same member twice should not fail (INSERT OR IGNORE)
        db.with_conn(|c| add_dm_members(c, "dm1", &["u1".to_string()])).unwrap();
        db.with_conn(|c| add_dm_members(c, "dm1", &["u1".to_string()])).unwrap();

        let members = db.with_conn(|c| get_dm_members(c, "dm1")).unwrap();
        assert_eq!(members.len(), 1);
    }
}
