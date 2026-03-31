use super::models::*;
use super::nullable;
use rusqlite::{params, Connection, OptionalExtension};

pub fn create_attachment(conn: &Connection, att: &Attachment) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO attachments (id, message_id, filename_encrypted, content_type_encrypted, size, storage_path, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            att.id,
            nullable(&att.message_id),
            att.filename_encrypted,
            att.content_type_encrypted,
            att.size,
            att.storage_path,
            att.created_at,
        ],
    )?;
    Ok(())
}

pub fn get_attachment(
    conn: &Connection,
    id: &str,
) -> Result<Option<Attachment>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, message_id, filename_encrypted, content_type_encrypted, size, storage_path, created_at
         FROM attachments WHERE id = ?1",
        [id],
        row_to_attachment,
    )
    .optional()
}

#[allow(dead_code)]
pub fn get_message_attachments(
    conn: &Connection,
    message_id: &str,
) -> Result<Vec<Attachment>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, message_id, filename_encrypted, content_type_encrypted, size, storage_path, created_at
         FROM attachments WHERE message_id = ?1",
    )?;
    let rows = stmt.query_map([message_id], row_to_attachment)?;
    rows.collect()
}

pub fn delete_attachment(conn: &Connection, id: &str) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM attachments WHERE id = ?1", [id])?;
    Ok(())
}

fn row_to_attachment(row: &rusqlite::Row) -> Result<Attachment, rusqlite::Error> {
    Ok(Attachment {
        id: row.get(0)?,
        message_id: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
        filename_encrypted: row.get(2)?,
        content_type_encrypted: row.get::<_, Option<Vec<u8>>>(3)?.unwrap_or_default(),
        size: row.get(4)?,
        storage_path: row.get(5)?,
        created_at: row.get(6)?,
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

    fn setup_for_attachments(db: &Database) {
        let now = crate::db::now_str();
        let user = crate::db::User {
            id: "u1".into(), username: "alice".into(), display_name: "Alice".into(),
            public_key: vec![1u8; 32], avatar_url: String::new(), status_text: String::new(),
            status_type: "online".into(), is_admin: false,
            created_at: now.clone(), updated_at: now.clone(),
        };
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();

        let team = crate::db::Team {
            id: "t1".into(), name: "Team".into(), description: String::new(),
            icon_url: String::new(), created_by: "u1".into(), max_file_size: 1024,
            allow_member_invites: true, created_at: now.clone(), updated_at: now.clone(),
        };
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();

        let channel = crate::db::Channel {
            id: "ch1".into(), team_id: "t1".into(), name: "general".into(),
            topic: String::new(), channel_type: "text".into(), position: 0,
            category: String::new(), created_by: "u1".into(),
            created_at: now.clone(), updated_at: now.clone(),
        };
        db.with_conn(|c| crate::db::create_channel(c, &channel)).unwrap();

        let msg = crate::db::Message {
            id: "m1".into(), channel_id: "ch1".into(), dm_channel_id: String::new(),
            author_id: "u1".into(), content: "hello".into(), msg_type: "text".into(),
            thread_id: String::new(), edited_at: None, deleted: false,
            lamport_ts: 0, created_at: now,
        };
        db.with_conn(|c| crate::db::create_message(c, &msg)).unwrap();
    }

    #[test]
    fn test_create_attachment_and_fetch() {
        let db = test_db();
        setup_for_attachments(&db);

        let att = Attachment {
            id: "a1".into(), message_id: "m1".into(),
            filename_encrypted: vec![1, 2, 3],
            content_type_encrypted: vec![4, 5, 6],
            size: 1024, storage_path: "/data/files/a1".into(),
            created_at: crate::db::now_str(),
        };
        db.with_conn(|c| create_attachment(c, &att)).unwrap();

        let fetched = db.with_conn(|c| get_attachment(c, "a1")).unwrap().unwrap();
        assert_eq!(fetched.filename_encrypted, vec![1, 2, 3]);
        assert_eq!(fetched.size, 1024);
        assert_eq!(fetched.storage_path, "/data/files/a1");
    }

    #[test]
    fn test_get_message_attachments() {
        let db = test_db();
        setup_for_attachments(&db);

        let a1 = Attachment {
            id: "a1".into(), message_id: "m1".into(),
            filename_encrypted: vec![1], content_type_encrypted: vec![],
            size: 100, storage_path: "/a1".into(),
            created_at: crate::db::now_str(),
        };
        let a2 = Attachment {
            id: "a2".into(), message_id: "m1".into(),
            filename_encrypted: vec![2], content_type_encrypted: vec![],
            size: 200, storage_path: "/a2".into(),
            created_at: crate::db::now_str(),
        };
        db.with_conn(|c| create_attachment(c, &a1)).unwrap();
        db.with_conn(|c| create_attachment(c, &a2)).unwrap();

        let atts = db.with_conn(|c| get_message_attachments(c, "m1")).unwrap();
        assert_eq!(atts.len(), 2);
    }

    #[test]
    fn test_delete_attachment() {
        let db = test_db();
        setup_for_attachments(&db);

        let att = Attachment {
            id: "a1".into(), message_id: "m1".into(),
            filename_encrypted: vec![1], content_type_encrypted: vec![],
            size: 100, storage_path: "/a1".into(),
            created_at: crate::db::now_str(),
        };
        db.with_conn(|c| create_attachment(c, &att)).unwrap();
        db.with_conn(|c| delete_attachment(c, "a1")).unwrap();

        let result = db.with_conn(|c| get_attachment(c, "a1")).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_get_nonexistent_attachment() {
        let db = test_db();
        let result = db.with_conn(|c| get_attachment(c, "nope")).unwrap();
        assert!(result.is_none());
    }
}
