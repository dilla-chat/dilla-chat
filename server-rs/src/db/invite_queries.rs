use super::models::*;
use super::{new_id, now_str};
use rusqlite::{params, Connection, OptionalExtension};

// ── Invite queries ──────────────────────────────────────────────────────────

pub fn create_invite(conn: &Connection, invite: &Invite) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO invites (id, team_id, created_by, token, max_uses, uses, expires_at, revoked, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            invite.id,
            invite.team_id,
            invite.created_by,
            invite.token,
            invite.max_uses,
            invite.uses,
            invite.expires_at,
            invite.revoked as i32,
            invite.created_at,
        ],
    )?;
    Ok(())
}

pub fn get_invite_by_token(
    conn: &Connection,
    token: &str,
) -> Result<Option<Invite>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, team_id, created_by, token, max_uses, uses, expires_at, revoked, created_at FROM invites WHERE token = ?1",
        [token],
        row_to_invite,
    )
    .optional()
}

pub fn get_invite_by_id(
    conn: &Connection,
    id: &str,
) -> Result<Option<Invite>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, team_id, created_by, token, max_uses, uses, expires_at, revoked, created_at FROM invites WHERE id = ?1",
        [id],
        row_to_invite,
    )
    .optional()
}

pub fn increment_invite_uses(conn: &Connection, id: &str) -> Result<(), rusqlite::Error> {
    conn.execute("UPDATE invites SET uses = uses + 1 WHERE id = ?1", [id])?;
    Ok(())
}

pub fn revoke_invite(conn: &Connection, id: &str) -> Result<(), rusqlite::Error> {
    conn.execute("UPDATE invites SET revoked = 1 WHERE id = ?1", [id])?;
    Ok(())
}

pub fn get_active_invites_by_team(
    conn: &Connection,
    team_id: &str,
) -> Result<Vec<Invite>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, team_id, created_by, token, max_uses, uses, expires_at, revoked, created_at
         FROM invites WHERE team_id = ?1 AND revoked = 0
         ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map([team_id], row_to_invite)?;
    rows.collect()
}

pub fn log_invite_use(
    conn: &Connection,
    invite_id: &str,
    user_id: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO invite_uses (id, invite_id, user_id, used_at) VALUES (?1, ?2, ?3, ?4)",
        params![new_id(), invite_id, user_id, now_str()],
    )?;
    Ok(())
}

fn row_to_invite(row: &rusqlite::Row) -> Result<Invite, rusqlite::Error> {
    Ok(Invite {
        id: row.get(0)?,
        team_id: row.get(1)?,
        created_by: row.get(2)?,
        token: row.get(3)?,
        max_uses: row.get(4)?,
        uses: row.get(5)?,
        expires_at: row.get(6)?,
        revoked: row.get::<_, i32>(7)? != 0,
        created_at: row.get(8)?,
    })
}

// ── Bootstrap token queries ─────────────────────────────────────────────────

pub fn create_bootstrap_token(conn: &Connection, token: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO bootstrap_tokens (token, used, created_at) VALUES (?1, 0, ?2)",
        params![token, now_str()],
    )?;
    Ok(())
}

pub fn get_bootstrap_token(
    conn: &Connection,
    token: &str,
) -> Result<Option<BootstrapToken>, rusqlite::Error> {
    conn.query_row(
        "SELECT token, used, created_at FROM bootstrap_tokens WHERE token = ?1",
        [token],
        |row| {
            Ok(BootstrapToken {
                token: row.get(0)?,
                used: row.get::<_, i32>(1)? != 0,
                created_at: row.get(2)?,
            })
        },
    )
    .optional()
}

pub fn use_bootstrap_token(conn: &Connection, token: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE bootstrap_tokens SET used = 1 WHERE token = ?1",
        [token],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::*;

    // ── Invite tests ────────────────────────────────────────────────────

    #[test]
    fn test_create_invite_and_fetch_by_token() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();

        let invite = Invite {
            id: "inv1".into(), team_id: "t1".into(), created_by: "u1".into(),
            token: "abc123".into(), max_uses: Some(10), uses: 0,
            expires_at: None, revoked: false, created_at: crate::db::now_str(),
        };
        db.with_conn(|c| create_invite(c, &invite)).unwrap();

        let fetched = db.with_conn(|c| get_invite_by_token(c, "abc123")).unwrap().unwrap();
        assert_eq!(fetched.id, "inv1");
        assert_eq!(fetched.max_uses, Some(10));
    }

    #[test]
    fn test_invite_increment_uses() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();

        let invite = Invite {
            id: "inv1".into(), team_id: "t1".into(), created_by: "u1".into(),
            token: "tok1".into(), max_uses: None, uses: 0,
            expires_at: None, revoked: false, created_at: crate::db::now_str(),
        };
        db.with_conn(|c| create_invite(c, &invite)).unwrap();

        db.with_conn(|c| increment_invite_uses(c, "inv1")).unwrap();
        db.with_conn(|c| increment_invite_uses(c, "inv1")).unwrap();

        let fetched = db.with_conn(|c| get_invite_by_id(c, "inv1")).unwrap().unwrap();
        assert_eq!(fetched.uses, 2);
    }

    #[test]
    fn test_revoke_invite() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();

        let invite = Invite {
            id: "inv1".into(), team_id: "t1".into(), created_by: "u1".into(),
            token: "tok1".into(), max_uses: None, uses: 0,
            expires_at: None, revoked: false, created_at: crate::db::now_str(),
        };
        db.with_conn(|c| create_invite(c, &invite)).unwrap();

        db.with_conn(|c| revoke_invite(c, "inv1")).unwrap();

        let fetched = db.with_conn(|c| get_invite_by_id(c, "inv1")).unwrap().unwrap();
        assert!(fetched.revoked);
    }

    #[test]
    fn test_get_active_invites_excludes_revoked() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();

        let now = crate::db::now_str();
        let inv1 = Invite {
            id: "inv1".into(), team_id: "t1".into(), created_by: "u1".into(),
            token: "tok1".into(), max_uses: None, uses: 0,
            expires_at: None, revoked: false, created_at: now.clone(),
        };
        let inv2 = Invite {
            id: "inv2".into(), team_id: "t1".into(), created_by: "u1".into(),
            token: "tok2".into(), max_uses: None, uses: 0,
            expires_at: None, revoked: true, created_at: now,
        };
        db.with_conn(|c| create_invite(c, &inv1)).unwrap();
        db.with_conn(|c| create_invite(c, &inv2)).unwrap();

        let active = db.with_conn(|c| get_active_invites_by_team(c, "t1")).unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].token, "tok1");
    }

    // ── Bootstrap token tests ───────────────────────────────────────────

    #[test]
    fn test_create_and_get_bootstrap_token() {
        let db = test_db();
        db.with_conn(|c| create_bootstrap_token(c, "mytoken")).unwrap();

        let fetched = db.with_conn(|c| get_bootstrap_token(c, "mytoken")).unwrap().unwrap();
        assert_eq!(fetched.token, "mytoken");
        assert!(!fetched.used);
    }

    #[test]
    fn test_use_bootstrap_token() {
        let db = test_db();
        db.with_conn(|c| create_bootstrap_token(c, "mytoken")).unwrap();
        db.with_conn(|c| use_bootstrap_token(c, "mytoken")).unwrap();

        let fetched = db.with_conn(|c| get_bootstrap_token(c, "mytoken")).unwrap().unwrap();
        assert!(fetched.used);
    }

    #[test]
    fn test_get_nonexistent_bootstrap_token() {
        let db = test_db();
        let result = db.with_conn(|c| get_bootstrap_token(c, "nope")).unwrap();
        assert!(result.is_none());
    }
}
