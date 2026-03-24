use super::models::*;
use super::now_str;
use rusqlite::{params, Connection, OptionalExtension};

pub fn create_role(conn: &Connection, role: &Role) -> Result<(), rusqlite::Error> {
    let updated = if role.updated_at.is_empty() {
        now_str()
    } else {
        role.updated_at.clone()
    };
    conn.execute(
        "INSERT INTO roles (id, team_id, name, color, position, permissions, is_default, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            role.id,
            role.team_id,
            role.name,
            role.color,
            role.position,
            role.permissions,
            role.is_default as i32,
            role.created_at,
            updated,
        ],
    )?;
    Ok(())
}

pub fn get_roles_by_team(
    conn: &Connection,
    team_id: &str,
) -> Result<Vec<Role>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, team_id, name, color, position, permissions, is_default, created_at, updated_at
         FROM roles WHERE team_id = ?1 ORDER BY position ASC",
    )?;
    let rows = stmt.query_map([team_id], |row| row_to_role(row))?;
    rows.collect()
}

pub fn get_role_by_id(conn: &Connection, id: &str) -> Result<Option<Role>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, team_id, name, color, position, permissions, is_default, created_at, updated_at FROM roles WHERE id = ?1",
        [id],
        |row| row_to_role(row),
    )
    .optional()
}

pub fn update_role(conn: &Connection, role: &Role) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE roles SET name = ?1, color = ?2, position = ?3, permissions = ?4, updated_at = ?5 WHERE id = ?6",
        params![role.name, role.color, role.position, role.permissions, now_str(), role.id],
    )?;
    Ok(())
}

pub fn delete_role(conn: &Connection, id: &str) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM member_roles WHERE role_id = ?1", [id])?;
    conn.execute("DELETE FROM roles WHERE id = ?1", [id])?;
    Ok(())
}

pub fn get_default_role_for_team(
    conn: &Connection,
    team_id: &str,
) -> Result<Option<Role>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, team_id, name, color, position, permissions, is_default, created_at, updated_at FROM roles WHERE team_id = ?1 AND is_default = 1",
        [team_id],
        |row| row_to_role(row),
    )
    .optional()
}

pub(crate) fn row_to_role(row: &rusqlite::Row) -> Result<Role, rusqlite::Error> {
    Ok(Role {
        id: row.get(0)?,
        team_id: row.get(1)?,
        name: row.get(2)?,
        color: row.get::<_, Option<String>>(3)?.unwrap_or("#99AAB5".into()),
        position: row.get(4)?,
        permissions: row.get(5)?,
        is_default: row.get::<_, i32>(6)? != 0,
        created_at: row.get(7)?,
        updated_at: row.get::<_, Option<String>>(8)?.unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::*;

    #[test]
    fn test_create_role_and_fetch() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();

        let role = Role {
            id: "r1".to_string(),
            team_id: "t1".to_string(),
            name: "Moderator".to_string(),
            color: "#FF0000".to_string(),
            position: 1,
            permissions: PERM_MANAGE_MESSAGES | PERM_MANAGE_MEMBERS,
            is_default: false,
            created_at: crate::db::now_str(),
            updated_at: String::new(),
        };
        db.with_conn(|c| create_role(c, &role)).unwrap();

        let fetched = db.with_conn(|c| get_role_by_id(c, "r1")).unwrap().unwrap();
        assert_eq!(fetched.name, "Moderator");
        assert_eq!(fetched.color, "#FF0000");
        assert_eq!(fetched.permissions, PERM_MANAGE_MESSAGES | PERM_MANAGE_MEMBERS);
    }

    #[test]
    fn test_get_roles_by_team_ordered_by_position() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();

        let now = crate::db::now_str();
        let r1 = Role {
            id: "r1".into(), team_id: "t1".into(), name: "Admin".into(),
            color: "#FF0000".into(), position: 2, permissions: PERM_ADMIN,
            is_default: false, created_at: now.clone(), updated_at: String::new(),
        };
        let r2 = Role {
            id: "r2".into(), team_id: "t1".into(), name: "Member".into(),
            color: "#00FF00".into(), position: 0, permissions: PERM_SEND_MESSAGES,
            is_default: true, created_at: now, updated_at: String::new(),
        };
        db.with_conn(|c| create_role(c, &r1)).unwrap();
        db.with_conn(|c| create_role(c, &r2)).unwrap();

        let roles = db.with_conn(|c| get_roles_by_team(c, "t1")).unwrap();
        assert_eq!(roles.len(), 2);
        assert_eq!(roles[0].name, "Member");
        assert_eq!(roles[1].name, "Admin");
    }

    #[test]
    fn test_update_role() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();

        let mut role = Role {
            id: "r1".into(), team_id: "t1".into(), name: "Mod".into(),
            color: "#000".into(), position: 0, permissions: 0,
            is_default: false, created_at: crate::db::now_str(), updated_at: String::new(),
        };
        db.with_conn(|c| create_role(c, &role)).unwrap();

        role.name = "Super Mod".to_string();
        role.permissions = PERM_ADMIN;
        db.with_conn(|c| update_role(c, &role)).unwrap();

        let fetched = db.with_conn(|c| get_role_by_id(c, "r1")).unwrap().unwrap();
        assert_eq!(fetched.name, "Super Mod");
        assert_eq!(fetched.permissions, PERM_ADMIN);
    }

    #[test]
    fn test_delete_role() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();

        let role = Role {
            id: "r1".into(), team_id: "t1".into(), name: "Temp".into(),
            color: "#000".into(), position: 0, permissions: 0,
            is_default: false, created_at: crate::db::now_str(), updated_at: String::new(),
        };
        db.with_conn(|c| create_role(c, &role)).unwrap();
        db.with_conn(|c| delete_role(c, "r1")).unwrap();

        let fetched = db.with_conn(|c| get_role_by_id(c, "r1")).unwrap();
        assert!(fetched.is_none());
    }

    #[test]
    fn test_get_default_role_for_team() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();

        let role = Role {
            id: "r1".into(), team_id: "t1".into(), name: "everyone".into(),
            color: "#000".into(), position: 0, permissions: PERM_SEND_MESSAGES,
            is_default: true, created_at: crate::db::now_str(), updated_at: String::new(),
        };
        db.with_conn(|c| create_role(c, &role)).unwrap();

        let def = db.with_conn(|c| get_default_role_for_team(c, "t1")).unwrap().unwrap();
        assert_eq!(def.name, "everyone");
        assert!(def.is_default);
    }
}
