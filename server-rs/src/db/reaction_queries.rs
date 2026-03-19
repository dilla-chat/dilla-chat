use super::models::*;
use super::{new_id, now_str};
use rusqlite::{params, Connection, OptionalExtension};

pub fn add_reaction(
    conn: &Connection,
    message_id: &str,
    user_id: &str,
    emoji: &str,
) -> Result<Reaction, rusqlite::Error> {
    let id = new_id();
    let now = now_str();
    conn.execute(
        "INSERT OR IGNORE INTO reactions (id, message_id, user_id, emoji, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, message_id, user_id, emoji, now],
    )?;
    Ok(Reaction {
        id,
        message_id: message_id.to_string(),
        user_id: user_id.to_string(),
        emoji: emoji.to_string(),
        created_at: now,
    })
}

pub fn remove_reaction(
    conn: &Connection,
    message_id: &str,
    user_id: &str,
    emoji: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM reactions WHERE message_id = ?1 AND user_id = ?2 AND emoji = ?3",
        params![message_id, user_id, emoji],
    )?;
    Ok(())
}

pub fn get_message_reactions(
    conn: &Connection,
    message_id: &str,
) -> Result<Vec<ReactionGroup>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT emoji, user_id FROM reactions WHERE message_id = ?1 ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map([message_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;

    let mut groups: Vec<ReactionGroup> = Vec::new();
    for row in rows {
        let (emoji, user_id) = row?;
        if let Some(group) = groups.iter_mut().find(|g| g.emoji == emoji) {
            group.count += 1;
            group.users.push(user_id);
        } else {
            groups.push(ReactionGroup {
                emoji,
                count: 1,
                users: vec![user_id],
            });
        }
    }
    Ok(groups)
}

#[allow(dead_code)]
pub fn get_user_reaction(
    conn: &Connection,
    message_id: &str,
    user_id: &str,
    emoji: &str,
) -> Result<Option<Reaction>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, message_id, user_id, emoji, created_at FROM reactions WHERE message_id = ?1 AND user_id = ?2 AND emoji = ?3",
        params![message_id, user_id, emoji],
        |row| {
            Ok(Reaction {
                id: row.get(0)?,
                message_id: row.get(1)?,
                user_id: row.get(2)?,
                emoji: row.get(3)?,
                created_at: row.get(4)?,
            })
        },
    )
    .optional()
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

    fn setup_for_reactions(db: &Database) {
        let now = crate::db::now_str();
        let user = User {
            id: "u1".into(), username: "alice".into(), display_name: "Alice".into(),
            public_key: vec![1u8; 32], avatar_url: String::new(), status_text: String::new(),
            status_type: "online".into(), is_admin: false,
            created_at: now.clone(), updated_at: now.clone(),
        };
        let user2 = User {
            id: "u2".into(), username: "bob".into(), display_name: "Bob".into(),
            public_key: vec![2u8; 32], avatar_url: String::new(), status_text: String::new(),
            status_type: "online".into(), is_admin: false,
            created_at: now.clone(), updated_at: now.clone(),
        };
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        db.with_conn(|c| crate::db::create_user(c, &user2)).unwrap();

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

        let msg = Message {
            id: "m1".into(), channel_id: "ch1".into(), dm_channel_id: String::new(),
            author_id: "u1".into(), content: "hello".into(), msg_type: "text".into(),
            thread_id: String::new(), edited_at: None, deleted: false,
            lamport_ts: 0, created_at: now,
        };
        db.with_conn(|c| crate::db::create_message(c, &msg)).unwrap();
    }

    #[test]
    fn test_add_reaction() {
        let db = test_db();
        setup_for_reactions(&db);

        let reaction = db.with_conn(|c| add_reaction(c, "m1", "u1", "thumbsup")).unwrap();
        assert_eq!(reaction.emoji, "thumbsup");
        assert_eq!(reaction.message_id, "m1");
    }

    #[test]
    fn test_get_message_reactions_grouped() {
        let db = test_db();
        setup_for_reactions(&db);

        db.with_conn(|c| add_reaction(c, "m1", "u1", "thumbsup")).unwrap();
        db.with_conn(|c| add_reaction(c, "m1", "u2", "thumbsup")).unwrap();
        db.with_conn(|c| add_reaction(c, "m1", "u1", "heart")).unwrap();

        let groups = db.with_conn(|c| get_message_reactions(c, "m1")).unwrap();
        assert_eq!(groups.len(), 2);

        let thumbsup = groups.iter().find(|g| g.emoji == "thumbsup").unwrap();
        assert_eq!(thumbsup.count, 2);
        assert_eq!(thumbsup.users.len(), 2);

        let heart = groups.iter().find(|g| g.emoji == "heart").unwrap();
        assert_eq!(heart.count, 1);
    }

    #[test]
    fn test_remove_reaction() {
        let db = test_db();
        setup_for_reactions(&db);

        db.with_conn(|c| add_reaction(c, "m1", "u1", "thumbsup")).unwrap();
        db.with_conn(|c| remove_reaction(c, "m1", "u1", "thumbsup")).unwrap();

        let groups = db.with_conn(|c| get_message_reactions(c, "m1")).unwrap();
        assert!(groups.is_empty());
    }

    #[test]
    fn test_get_user_reaction() {
        let db = test_db();
        setup_for_reactions(&db);

        db.with_conn(|c| add_reaction(c, "m1", "u1", "thumbsup")).unwrap();

        let found = db.with_conn(|c| get_user_reaction(c, "m1", "u1", "thumbsup")).unwrap();
        assert!(found.is_some());

        let not_found = db.with_conn(|c| get_user_reaction(c, "m1", "u1", "heart")).unwrap();
        assert!(not_found.is_none());
    }

    #[test]
    fn test_add_reaction_idempotent() {
        let db = test_db();
        setup_for_reactions(&db);

        db.with_conn(|c| add_reaction(c, "m1", "u1", "thumbsup")).unwrap();
        db.with_conn(|c| add_reaction(c, "m1", "u1", "thumbsup")).unwrap();

        let groups = db.with_conn(|c| get_message_reactions(c, "m1")).unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].count, 1);
    }

    #[test]
    fn test_no_reactions_returns_empty() {
        let db = test_db();
        setup_for_reactions(&db);

        let groups = db.with_conn(|c| get_message_reactions(c, "m1")).unwrap();
        assert!(groups.is_empty());
    }
}
