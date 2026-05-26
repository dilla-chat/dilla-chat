use super::models::*;
use super::now_str;
use rusqlite::{params, Connection, OptionalExtension};

pub fn create_team(conn: &Connection, team: &Team) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO teams (id, name, description, icon_url, created_by, max_file_size, allow_member_invites, federated, force_turn_relay, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            team.id,
            team.name,
            team.description,
            team.icon_url,
            team.created_by,
            team.max_file_size,
            team.allow_member_invites as i32,
            team.federated as i32,
            team.force_turn_relay as i32,
            team.created_at,
            team.updated_at,
        ],
    )?;
    Ok(())
}

pub fn get_team(conn: &Connection, id: &str) -> Result<Option<Team>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, name, description, icon_url, created_by, max_file_size, allow_member_invites, federated, force_turn_relay, created_at, updated_at FROM teams WHERE id = ?1",
        [id],
        row_to_team,
    )
    .optional()
}

pub fn get_first_team(conn: &Connection) -> Result<Option<Team>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, name, description, icon_url, created_by, max_file_size, allow_member_invites, federated, force_turn_relay, created_at, updated_at FROM teams ORDER BY created_at ASC LIMIT 1",
        [],
        row_to_team,
    )
    .optional()
}

pub fn get_teams_by_user(
    conn: &Connection,
    user_id: &str,
) -> Result<Vec<Team>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, t.description, t.icon_url, t.created_by, t.max_file_size, t.allow_member_invites, t.federated, t.force_turn_relay, t.created_at, t.updated_at
         FROM teams t
         JOIN members m ON m.team_id = t.id
         WHERE m.user_id = ?1",
    )?;
    let rows = stmt.query_map([user_id], row_to_team)?;
    rows.collect()
}

pub fn update_team(conn: &Connection, team: &Team) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE teams SET name = ?1, description = ?2, icon_url = ?3, max_file_size = ?4, allow_member_invites = ?5, federated = ?6, force_turn_relay = ?7, updated_at = ?8 WHERE id = ?9",
        params![
            team.name,
            team.description,
            team.icon_url,
            team.max_file_size,
            team.allow_member_invites as i32,
            team.federated as i32,
            team.force_turn_relay as i32,
            now_str(),
            team.id,
        ],
    )?;
    Ok(())
}

/// Return the team's current upload-usage tally in bytes. H12 / UPL-DOS-1.
pub fn get_team_upload_bytes_used(
    conn: &Connection,
    team_id: &str,
) -> Result<i64, rusqlite::Error> {
    let row: Option<i64> = conn
        .query_row(
            "SELECT upload_bytes_used FROM teams WHERE id = ?1",
            rusqlite::params![team_id],
            |row| row.get(0),
        )
        .ok();
    Ok(row.unwrap_or(0))
}

/// Bump (or decrement, when delta is negative) the team's upload-usage
/// tally. Caller orders this relative to the actual fs / row write.
/// MAX(0, ...) avoids a negative balance after a stale or duplicate
/// decrement. H12 / UPL-DOS-1.
pub fn add_team_upload_bytes(
    conn: &Connection,
    team_id: &str,
    delta: i64,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE teams SET upload_bytes_used = MAX(0, upload_bytes_used + ?1) WHERE id = ?2",
        rusqlite::params![delta, team_id],
    )?;
    Ok(())
}

fn row_to_team(row: &rusqlite::Row) -> Result<Team, rusqlite::Error> {
    Ok(Team {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        icon_url: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        created_by: row.get(4)?,
        max_file_size: row.get(5)?,
        allow_member_invites: row.get::<_, i32>(6)? != 0,
        federated: row.get::<_, i32>(7)? != 0,
        force_turn_relay: row.get::<_, i32>(8)? != 0,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::*;

    #[test]
    fn test_create_team_and_fetch() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();

        let team = make_team("t1", "Test Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

        let fetched = db.with_conn(|c| get_team(c, "t1")).unwrap().unwrap();
        assert_eq!(fetched.name, "Test Team");
        assert_eq!(fetched.created_by, "u1");
    }

    #[test]
    fn test_get_nonexistent_team_returns_none() {
        let db = test_db();
        let result = db.with_conn(|c| get_team(c, "nope")).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_update_team() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();

        let mut team = make_team("t1", "Original", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

        team.name = "Updated Name".to_string();
        team.description = "A description".to_string();
        team.allow_member_invites = false;
        db.with_conn(|c| update_team(c, &team)).unwrap();

        let fetched = db.with_conn(|c| get_team(c, "t1")).unwrap().unwrap();
        assert_eq!(fetched.name, "Updated Name");
        assert_eq!(fetched.description, "A description");
        assert!(!fetched.allow_member_invites);
    }

    #[test]
    fn test_get_first_team() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();

        let result = db.with_conn(|c| get_first_team(c)).unwrap();
        assert!(result.is_none());

        let team = make_team("t1", "First", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

        let fetched = db.with_conn(|c| get_first_team(c)).unwrap().unwrap();
        assert_eq!(fetched.id, "t1");
    }

    #[test]
    fn test_team_upload_bytes_default_zero() {
        let db = test_db();
        let user = make_user("u1", "u", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "T", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

        let used = db.with_conn(|c| get_team_upload_bytes_used(c, "t1")).unwrap();
        assert_eq!(used, 0);
    }

    #[test]
    fn test_team_upload_bytes_unknown_team_returns_zero() {
        let db = test_db();
        let used = db.with_conn(|c| get_team_upload_bytes_used(c, "missing")).unwrap();
        assert_eq!(used, 0);
    }

    #[test]
    fn test_add_team_upload_bytes_adds_and_clamps_to_zero() {
        let db = test_db();
        let user = make_user("u1", "u", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "T", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

        db.with_conn(|c| add_team_upload_bytes(c, "t1", 1234)).unwrap();
        let used = db.with_conn(|c| get_team_upload_bytes_used(c, "t1")).unwrap();
        assert_eq!(used, 1234);

        // Negative delta below zero clamps via MAX(0, ...).
        db.with_conn(|c| add_team_upload_bytes(c, "t1", -10_000)).unwrap();
        let used = db.with_conn(|c| get_team_upload_bytes_used(c, "t1")).unwrap();
        assert_eq!(used, 0);
    }

    #[test]
    fn test_get_teams_by_user() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();

        let team = make_team("t1", "Team One", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

        let member = make_member("m1", "t1", "u1");
        db.with_conn(|c| crate::db::create_member(c, &member)).unwrap();

        let teams = db.with_conn(|c| get_teams_by_user(c, "u1")).unwrap();
        assert_eq!(teams.len(), 1);
        assert_eq!(teams[0].name, "Team One");

        let user2 = make_user("u2", "loner", &[2u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user2)).unwrap();
        let teams2 = db.with_conn(|c| get_teams_by_user(c, "u2")).unwrap();
        assert!(teams2.is_empty());
    }
}
