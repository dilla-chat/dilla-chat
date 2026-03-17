use super::models::*;
use rusqlite::{params, Connection, OptionalExtension};

pub fn create_attachment(conn: &Connection, att: &Attachment) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO attachments (id, message_id, filename_encrypted, content_type_encrypted, size, storage_path, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            att.id,
            att.message_id,
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
        |row| row_to_attachment(row),
    )
    .optional()
}

pub fn get_message_attachments(
    conn: &Connection,
    message_id: &str,
) -> Result<Vec<Attachment>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, message_id, filename_encrypted, content_type_encrypted, size, storage_path, created_at
         FROM attachments WHERE message_id = ?1",
    )?;
    let rows = stmt.query_map([message_id], |row| row_to_attachment(row))?;
    rows.collect()
}

pub fn delete_attachment(conn: &Connection, id: &str) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM attachments WHERE id = ?1", [id])?;
    Ok(())
}

fn row_to_attachment(row: &rusqlite::Row) -> Result<Attachment, rusqlite::Error> {
    Ok(Attachment {
        id: row.get(0)?,
        message_id: row.get(1)?,
        filename_encrypted: row.get(2)?,
        content_type_encrypted: row.get::<_, Option<Vec<u8>>>(3)?.unwrap_or_default(),
        size: row.get(4)?,
        storage_path: row.get(5)?,
        created_at: row.get(6)?,
    })
}
