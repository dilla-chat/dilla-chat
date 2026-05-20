// Channel groups: first-class entities that own a name, a position, and
// a list of role-based access gates. Channels reference a group via the
// `channels.group_id` column. Pure-inheritance access semantics live in
// channel_access_queries::get_channel_access_roles and
// user_can_access_channel — this module is just the CRUD layer.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelGroup {
    pub id: String,
    pub team_id: String,
    pub name: String,
    pub position: i32,
    pub created_at: String,
    pub updated_at: String,
}

const GROUP_COLS: &str = "id, team_id, name, position, created_at, updated_at";

fn row_to_group(row: &rusqlite::Row) -> Result<ChannelGroup, rusqlite::Error> {
    Ok(ChannelGroup {
        id: row.get(0)?,
        team_id: row.get(1)?,
        name: row.get(2)?,
        position: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

pub fn get_groups_by_team(
    conn: &Connection,
    team_id: &str,
) -> Result<Vec<ChannelGroup>, rusqlite::Error> {
    let sql = format!(
        "SELECT {} FROM channel_groups WHERE team_id = ?1 ORDER BY position ASC, created_at ASC",
        GROUP_COLS,
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([team_id], row_to_group)?;
    rows.collect()
}

pub fn get_group_by_id(
    conn: &Connection,
    id: &str,
) -> Result<Option<ChannelGroup>, rusqlite::Error> {
    let sql = format!("SELECT {} FROM channel_groups WHERE id = ?1", GROUP_COLS);
    conn.query_row(&sql, [id], row_to_group).optional()
}

pub fn create_group(conn: &Connection, g: &ChannelGroup) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO channel_groups (id, team_id, name, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![g.id, g.team_id, g.name, g.position, g.created_at, g.updated_at],
    )?;
    Ok(())
}

pub fn update_group(conn: &Connection, g: &ChannelGroup) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE channel_groups SET name = ?1, position = ?2, updated_at = ?3 WHERE id = ?4",
        params![g.name, g.position, g.updated_at, g.id],
    )?;
    Ok(())
}

pub fn delete_group(conn: &Connection, id: &str) -> Result<(), rusqlite::Error> {
    // ON DELETE SET NULL on channels.group_id ensures channels survive.
    conn.execute("DELETE FROM channel_groups WHERE id = ?1", [id])?;
    Ok(())
}

/// True if another group in the same team already uses this name
/// (case-insensitive, trimmed). Matches the partial unique index from
/// migration 020 so handler-side checks line up with the DB constraint.
pub fn group_name_exists(
    conn: &Connection,
    team_id: &str,
    name: &str,
    ignore_id: Option<&str>,
) -> Result<bool, rusqlite::Error> {
    let normalized = name.trim().to_lowercase();
    let mut stmt = conn.prepare(
        "SELECT 1 FROM channel_groups \
         WHERE team_id = ?1 AND lower(trim(name)) = ?2 \
           AND (?3 IS NULL OR id != ?3) \
         LIMIT 1",
    )?;
    let exists = stmt
        .query_row(
            params![team_id, normalized, ignore_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    Ok(exists)
}
