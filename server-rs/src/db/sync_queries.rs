use super::models::*;
use rusqlite::{params, Connection};

// ── Federation sync update queries ──────────────────────────────────────────

pub fn update_channel_from_sync(conn: &Connection, ch: &Channel) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE channels SET name = ?1, topic = ?2, category = ?3, position = ?4, updated_at = ?5 WHERE id = ?6",
        params![ch.name, ch.topic, ch.category, ch.position, ch.updated_at, ch.id],
    )?;
    Ok(())
}

pub fn update_role_from_sync(conn: &Connection, role: &Role) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE roles SET name = ?1, color = ?2, position = ?3, permissions = ?4, updated_at = ?5 WHERE id = ?6",
        params![role.name, role.color, role.position, role.permissions, role.updated_at, role.id],
    )?;
    Ok(())
}

pub fn update_member_from_sync(conn: &Connection, member: &Member) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE members SET nickname = ?1, updated_at = ?2 WHERE id = ?3",
        params![member.nickname, member.updated_at, member.id],
    )?;
    Ok(())
}

pub fn update_message_from_sync(conn: &Connection, msg: &Message) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE messages SET content = ?1, edited_at = ?2, deleted = ?3 WHERE id = ?4",
        params![msg.content, msg.edited_at, msg.deleted as i32, msg.id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::*;
    use crate::db::Database;

    fn seed(db: &Database) {
        db.with_conn(|c| crate::db::create_user(c, &make_user("u1", "alice", &[1u8; 32]))).unwrap();
        db.with_conn(|c| crate::db::create_team(c, &make_team("t1", "Team", "u1"))).unwrap();
    }

    #[test]
    fn update_channel_from_sync_mutates_name_topic_category_position() {
        let db = test_db();
        seed(&db);
        db.with_conn(|c| crate::db::create_channel(c, &make_channel("c1", "t1", "general", "u1"))).unwrap();
        db.with_conn(|c| {
            let mut ch = crate::db::get_channel_by_id(c, "c1")?.unwrap();
            ch.name = "renamed".into();
            ch.topic = "new topic".into();
            ch.category = "ops".into();
            ch.position = 5;
            ch.updated_at = crate::db::now_str();
            update_channel_from_sync(c, &ch)?;
            let got = crate::db::get_channel_by_id(c, "c1")?.unwrap();
            assert_eq!(got.name, "renamed");
            assert_eq!(got.topic, "new topic");
            assert_eq!(got.category, "ops");
            assert_eq!(got.position, 5);
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn update_role_from_sync_mutates_name_color_position_permissions() {
        let db = test_db();
        seed(&db);
        let now = crate::db::now_str();
        let role = Role {
            id: "r1".into(),
            team_id: "t1".into(),
            name: "old".into(),
            color: "#aaa".into(),
            position: 0,
            permissions: 1,
            is_default: false,
            created_at: now.clone(),
            updated_at: now,
        };
        db.with_conn(|c| crate::db::create_role(c, &role)).unwrap();
        let mut updated = role.clone();
        updated.name = "new".into();
        updated.color = "#fff".into();
        updated.position = 3;
        updated.permissions = 7;
        updated.updated_at = crate::db::now_str();
        db.with_conn(|c| update_role_from_sync(c, &updated)).unwrap();
        let got = db.with_conn(|c| crate::db::get_roles_by_team(c, "t1")).unwrap();
        let g = got.iter().find(|r| r.id == "r1").unwrap();
        assert_eq!(g.name, "new");
        assert_eq!(g.color, "#fff");
        assert_eq!(g.position, 3);
        assert_eq!(g.permissions, 7);
    }

    #[test]
    fn update_message_from_sync_mutates_content_and_deleted() {
        let db = test_db();
        seed(&db);
        db.with_conn(|c| crate::db::create_channel(c, &make_channel("c1", "t1", "general", "u1"))).unwrap();
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO messages (id, channel_id, dm_channel_id, author_id, content, type, deleted, lamport_ts, created_at)
                 VALUES ('m1', 'c1', '', 'u1', 'original', 'text', 0, 1, datetime('now'))",
                [],
            )?;
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
        db.with_conn(|c| {
            let msg = Message {
                id: "m1".into(),
                channel_id: "c1".into(),
                dm_channel_id: String::new(),
                author_id: "u1".into(),
                content: "edited".into(),
                msg_type: "text".into(),
                thread_id: String::new(),
                reply_to_message_id: None,
                edited_at: Some(crate::db::now_str()),
                deleted: true,
                lamport_ts: 2,
                created_at: crate::db::now_str(),
            };
            update_message_from_sync(c, &msg)?;
            let got: (String, i32, Option<String>) = c.query_row(
                "SELECT content, deleted, edited_at FROM messages WHERE id = 'm1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(got.0, "edited");
            assert_eq!(got.1, 1);
            assert!(got.2.is_some());
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }
}
