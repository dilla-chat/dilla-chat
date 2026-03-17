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
