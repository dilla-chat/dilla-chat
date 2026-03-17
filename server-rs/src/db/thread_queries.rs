use super::models::*;
use super::{new_id, now_str};
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
        |row| row_to_thread(row),
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
        |row| row_to_thread(row),
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
    let rows = stmt.query_map([channel_id], |row| row_to_thread(row))?;
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
        let rows = stmt.query_map(params![thread_id, limit], |row| row_to_message(row))?;
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
