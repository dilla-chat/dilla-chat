use super::member_queries::get_member_by_user_and_team;
use super::models::*;
use super::role_queries::row_to_role;
use rusqlite::{params, Connection};

// ── Member Role queries ─────────────────────────────────────────────────────

pub fn assign_role_to_member(
    conn: &Connection,
    member_id: &str,
    role_id: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT OR IGNORE INTO member_roles (member_id, role_id) VALUES (?1, ?2)",
        params![member_id, role_id],
    )?;
    Ok(())
}

#[allow(dead_code)]
pub fn remove_role_from_member(
    conn: &Connection,
    member_id: &str,
    role_id: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM member_roles WHERE member_id = ?1 AND role_id = ?2",
        params![member_id, role_id],
    )?;
    Ok(())
}

pub fn clear_member_roles(conn: &Connection, member_id: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM member_roles WHERE member_id = ?1",
        [member_id],
    )?;
    Ok(())
}

pub fn get_member_roles(
    conn: &Connection,
    member_id: &str,
) -> Result<Vec<Role>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT r.id, r.team_id, r.name, r.color, r.position, r.permissions, r.is_default, r.created_at, r.updated_at
         FROM roles r
         JOIN member_roles mr ON mr.role_id = r.id
         WHERE mr.member_id = ?1
         ORDER BY r.position ASC",
    )?;
    let rows = stmt.query_map([member_id], row_to_role)?;
    rows.collect()
}

// ── Permission check ────────────────────────────────────────────────────────

pub fn user_has_permission(
    conn: &Connection,
    user_id: &str,
    team_id: &str,
    perm: i64,
) -> Result<bool, rusqlite::Error> {
    // Check if user is admin (admins have all permissions).
    let is_admin: bool = conn
        .query_row(
            "SELECT is_admin FROM users WHERE id = ?1",
            [user_id],
            |row| row.get::<_, i32>(0).map(|v| v != 0),
        )
        .unwrap_or(false);
    if is_admin {
        return Ok(true);
    }

    // Check if user is team owner.
    let is_owner: bool = conn
        .query_row(
            "SELECT created_by FROM teams WHERE id = ?1",
            [team_id],
            |row| row.get::<_, String>(0),
        )
        .map(|owner| owner == user_id)
        .unwrap_or(false);
    if is_owner {
        return Ok(true);
    }

    // Check member roles.
    let member = get_member_by_user_and_team(conn, user_id, team_id)?;
    if let Some(member) = member {
        let roles = get_member_roles(conn, &member.id)?;
        for role in roles {
            if role.permissions & PERM_ADMIN != 0 || role.permissions & perm != 0 {
                return Ok(true);
            }
        }
    }

    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::*;

    // ── Member role assignment tests ────────────────────────────────────

    #[test]
    fn test_assign_and_get_member_roles() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();
        let member = make_member("m1", "t1", "u1");
        db.with_conn(|c| crate::db::create_member(c, &member)).unwrap();

        let now = crate::db::now_str();
        let r1 = Role {
            id: "r1".into(), team_id: "t1".into(), name: "Mod".into(),
            color: "#000".into(), position: 0, permissions: PERM_MANAGE_MESSAGES,
            is_default: false, created_at: now.clone(), updated_at: String::new(),
        };
        let r2 = Role {
            id: "r2".into(), team_id: "t1".into(), name: "Admin".into(),
            color: "#000".into(), position: 1, permissions: PERM_ADMIN,
            is_default: false, created_at: now, updated_at: String::new(),
        };
        db.with_conn(|c| crate::db::create_role(c, &r1)).unwrap();
        db.with_conn(|c| crate::db::create_role(c, &r2)).unwrap();

        db.with_conn(|c| assign_role_to_member(c, "m1", "r1")).unwrap();
        db.with_conn(|c| assign_role_to_member(c, "m1", "r2")).unwrap();

        let roles = db.with_conn(|c| get_member_roles(c, "m1")).unwrap();
        assert_eq!(roles.len(), 2);
    }

    #[test]
    fn test_assign_role_idempotent() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();
        let member = make_member("m1", "t1", "u1");
        db.with_conn(|c| crate::db::create_member(c, &member)).unwrap();

        let role = Role {
            id: "r1".into(), team_id: "t1".into(), name: "Mod".into(),
            color: "#000".into(), position: 0, permissions: 0,
            is_default: false, created_at: crate::db::now_str(), updated_at: String::new(),
        };
        db.with_conn(|c| crate::db::create_role(c, &role)).unwrap();

        db.with_conn(|c| assign_role_to_member(c, "m1", "r1")).unwrap();
        db.with_conn(|c| assign_role_to_member(c, "m1", "r1")).unwrap();

        let roles = db.with_conn(|c| get_member_roles(c, "m1")).unwrap();
        assert_eq!(roles.len(), 1);
    }

    #[test]
    fn test_remove_role_from_member() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();
        let member = make_member("m1", "t1", "u1");
        db.with_conn(|c| crate::db::create_member(c, &member)).unwrap();

        let role = Role {
            id: "r1".into(), team_id: "t1".into(), name: "Mod".into(),
            color: "#000".into(), position: 0, permissions: 0,
            is_default: false, created_at: crate::db::now_str(), updated_at: String::new(),
        };
        db.with_conn(|c| crate::db::create_role(c, &role)).unwrap();

        db.with_conn(|c| assign_role_to_member(c, "m1", "r1")).unwrap();
        db.with_conn(|c| remove_role_from_member(c, "m1", "r1")).unwrap();

        let roles = db.with_conn(|c| get_member_roles(c, "m1")).unwrap();
        assert!(roles.is_empty());
    }

    #[test]
    fn test_clear_member_roles() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();
        let member = make_member("m1", "t1", "u1");
        db.with_conn(|c| crate::db::create_member(c, &member)).unwrap();

        let now = crate::db::now_str();
        for i in 0..3 {
            let role = Role {
                id: format!("r{}", i), team_id: "t1".into(), name: format!("Role{}", i),
                color: "#000".into(), position: i, permissions: 0,
                is_default: false, created_at: now.clone(), updated_at: String::new(),
            };
            db.with_conn(|c| crate::db::create_role(c, &role)).unwrap();
            db.with_conn(|c| assign_role_to_member(c, "m1", &format!("r{}", i))).unwrap();
        }

        db.with_conn(|c| clear_member_roles(c, "m1")).unwrap();
        let roles = db.with_conn(|c| get_member_roles(c, "m1")).unwrap();
        assert!(roles.is_empty());
    }

    // ── Permission tests ────────────────────────────────────────────────

    #[test]
    fn test_user_has_permission_admin_user() {
        let db = test_db();
        let mut user = make_user("u1", "admin", &[1u8; 32]);
        user.is_admin = true;
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();

        let user2 = make_user("u2", "creator", &[2u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user2)).unwrap();
        let team = make_team("t1", "Team", "u2");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();

        let has = db.with_conn(|c| user_has_permission(c, "u1", "t1", PERM_MANAGE_CHANNELS)).unwrap();
        assert!(has);
    }

    #[test]
    fn test_user_has_permission_team_owner() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();

        let has = db.with_conn(|c| user_has_permission(c, "u1", "t1", PERM_MANAGE_ROLES)).unwrap();
        assert!(has);
    }

    #[test]
    fn test_user_has_permission_via_role() {
        let db = test_db();
        let owner = make_user("u1", "owner", &[1u8; 32]);
        let user = make_user("u2", "member", &[2u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &owner)).unwrap();
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();

        let member = make_member("m2", "t1", "u2");
        db.with_conn(|c| crate::db::create_member(c, &member)).unwrap();

        let role = Role {
            id: "r1".into(), team_id: "t1".into(), name: "Mod".into(),
            color: "#000".into(), position: 0, permissions: PERM_MANAGE_MESSAGES,
            is_default: false, created_at: crate::db::now_str(), updated_at: String::new(),
        };
        db.with_conn(|c| crate::db::create_role(c, &role)).unwrap();
        db.with_conn(|c| assign_role_to_member(c, "m2", "r1")).unwrap();

        let has = db.with_conn(|c| user_has_permission(c, "u2", "t1", PERM_MANAGE_MESSAGES)).unwrap();
        assert!(has);

        let no = db.with_conn(|c| user_has_permission(c, "u2", "t1", PERM_MANAGE_CHANNELS)).unwrap();
        assert!(!no);
    }

    #[test]
    fn test_user_has_permission_role_with_admin_perm() {
        let db = test_db();
        let owner = make_user("u1", "owner", &[1u8; 32]);
        let user = make_user("u2", "member", &[2u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &owner)).unwrap();
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();

        let member = make_member("m2", "t1", "u2");
        db.with_conn(|c| crate::db::create_member(c, &member)).unwrap();

        let role = Role {
            id: "r1".into(), team_id: "t1".into(), name: "Admin Role".into(),
            color: "#000".into(), position: 0, permissions: PERM_ADMIN,
            is_default: false, created_at: crate::db::now_str(), updated_at: String::new(),
        };
        db.with_conn(|c| crate::db::create_role(c, &role)).unwrap();
        db.with_conn(|c| assign_role_to_member(c, "m2", "r1")).unwrap();

        let has = db.with_conn(|c| user_has_permission(c, "u2", "t1", PERM_MANAGE_TEAM)).unwrap();
        assert!(has);
    }

    #[test]
    fn test_user_has_no_permission_without_role() {
        let db = test_db();
        let owner = make_user("u1", "owner", &[1u8; 32]);
        let user = make_user("u2", "member", &[2u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &owner)).unwrap();
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();

        let member = make_member("m2", "t1", "u2");
        db.with_conn(|c| crate::db::create_member(c, &member)).unwrap();

        let has = db.with_conn(|c| user_has_permission(c, "u2", "t1", PERM_SEND_MESSAGES)).unwrap();
        assert!(!has);
    }
}
