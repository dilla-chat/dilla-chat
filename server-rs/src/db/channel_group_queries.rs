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
    #[serde(default)]
    pub hidden_if_restricted: bool,
}

const GROUP_COLS: &str = "id, team_id, name, position, created_at, updated_at, hidden_if_restricted";

fn row_to_group(row: &rusqlite::Row) -> Result<ChannelGroup, rusqlite::Error> {
    Ok(ChannelGroup {
        id: row.get(0)?,
        team_id: row.get(1)?,
        name: row.get(2)?,
        position: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        hidden_if_restricted: row.get::<_, i32>(6).unwrap_or(0) != 0,
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
        "INSERT INTO channel_groups (id, team_id, name, position, created_at, updated_at, hidden_if_restricted)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![g.id, g.team_id, g.name, g.position, g.created_at, g.updated_at, g.hidden_if_restricted as i32],
    )?;
    Ok(())
}

pub fn update_group(conn: &Connection, g: &ChannelGroup) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE channel_groups SET name = ?1, position = ?2, hidden_if_restricted = ?3, updated_at = ?4 WHERE id = ?5",
        params![g.name, g.position, g.hidden_if_restricted as i32, g.updated_at, g.id],
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::*;

    fn seed(db: &crate::db::Database) {
        db.with_conn(|c| crate::db::create_user(c, &make_user("u1", "alice", &[1u8; 32]))).unwrap();
        db.with_conn(|c| crate::db::create_team(c, &make_team("t1", "Team", "u1"))).unwrap();
    }

    fn group(id: &str, team_id: &str, name: &str) -> ChannelGroup {
        let now = crate::db::now_str();
        ChannelGroup {
            id: id.into(),
            team_id: team_id.into(),
            name: name.into(),
            position: 0,
            created_at: now.clone(),
            updated_at: now,
            hidden_if_restricted: false,
        }
    }

    #[test]
    fn create_then_get_by_id_roundtrips() {
        let db = test_db();
        seed(&db);
        db.with_conn(|c| {
            create_group(c, &group("g1", "t1", "engineering"))?;
            let got = get_group_by_id(c, "g1")?.unwrap();
            assert_eq!(got.id, "g1");
            assert_eq!(got.name, "engineering");
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn get_groups_by_team_returns_in_position_order() {
        let db = test_db();
        seed(&db);
        db.with_conn(|c| {
            let mut g_a = group("g-a", "t1", "alpha");
            g_a.position = 2;
            let mut g_b = group("g-b", "t1", "bravo");
            g_b.position = 0;
            let mut g_c = group("g-c", "t1", "charlie");
            g_c.position = 1;
            create_group(c, &g_a)?;
            create_group(c, &g_b)?;
            create_group(c, &g_c)?;
            let groups = get_groups_by_team(c, "t1")?;
            let names: Vec<&str> = groups.iter().map(|g| g.name.as_str()).collect();
            assert_eq!(names, vec!["bravo", "charlie", "alpha"]);
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn update_group_changes_name_and_position() {
        let db = test_db();
        seed(&db);
        db.with_conn(|c| {
            create_group(c, &group("g1", "t1", "old"))?;
            let mut g = get_group_by_id(c, "g1")?.unwrap();
            g.name = "new".into();
            g.position = 7;
            g.hidden_if_restricted = true;
            update_group(c, &g)?;
            let got = get_group_by_id(c, "g1")?.unwrap();
            assert_eq!(got.name, "new");
            assert_eq!(got.position, 7);
            assert!(got.hidden_if_restricted);
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn delete_group_removes_the_row() {
        let db = test_db();
        seed(&db);
        db.with_conn(|c| {
            create_group(c, &group("g1", "t1", "doomed"))?;
            delete_group(c, "g1")?;
            assert!(get_group_by_id(c, "g1")?.is_none());
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn group_name_exists_is_case_insensitive_and_trim_aware() {
        let db = test_db();
        seed(&db);
        db.with_conn(|c| {
            create_group(c, &group("g1", "t1", "Engineering"))?;
            assert!(group_name_exists(c, "t1", "engineering", None)?);
            assert!(group_name_exists(c, "t1", "  ENGINEERING  ", None)?);
            assert!(!group_name_exists(c, "t1", "design", None)?);
            // ignore_id excludes the matching row — useful for rename
            // pre-flight checks.
            assert!(!group_name_exists(c, "t1", "engineering", Some("g1"))?);
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn group_name_exists_is_team_scoped() {
        let db = test_db();
        seed(&db);
        // Second team also called Team
        db.with_conn(|c| crate::db::create_team(c, &make_team("t2", "Team Two", "u1"))).unwrap();
        db.with_conn(|c| {
            create_group(c, &group("g1", "t1", "Engineering"))?;
            assert!(group_name_exists(c, "t1", "Engineering", None)?);
            assert!(!group_name_exists(c, "t2", "Engineering", None)?);
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }
}
