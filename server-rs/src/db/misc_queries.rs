use super::member_queries::get_member_by_user_and_team;
use super::models::*;
use super::{new_id, now_str};
use super::role_queries::row_to_role;
use rusqlite::{params, Connection, OptionalExtension};

// ── Federation sync update queries ──────────────────────────────────────────

pub fn update_channel_from_sync(conn: &Connection, ch: &Channel) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE channels SET name = ?1, topic = ?2, category = ?3, position = ?4, updated_at = ?5 WHERE id = ?6",
        params![ch.name, ch.topic, ch.category, ch.position, ch.updated_at, ch.id],
    )?;
    Ok(())
}

pub fn update_role_from_sync(conn: &Connection, role: &Role) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE roles SET name = ?1, color = ?2, position = ?3, permissions = ?4, updated_at = ?5 WHERE id = ?6",
        params![role.name, role.color, role.position, role.permissions, role.updated_at, role.id],
    )?;
    Ok(())
}

pub fn update_member_from_sync(conn: &Connection, member: &Member) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE members SET nickname = ?1, updated_at = ?2 WHERE id = ?3",
        params![member.nickname, member.updated_at, member.id],
    )?;
    Ok(())
}

pub fn update_message_from_sync(conn: &Connection, msg: &Message) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE messages SET content = ?1, edited_at = ?2, deleted = ?3 WHERE id = ?4",
        params![msg.content, msg.edited_at, msg.deleted as i32, msg.id],
    )?;
    Ok(())
}

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
    let rows = stmt.query_map([member_id], |row| row_to_role(row))?;
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
        |row| row_to_invite(row),
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
        |row| row_to_invite(row),
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
    let rows = stmt.query_map([team_id], |row| row_to_invite(row))?;
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

// ── Ban queries ─────────────────────────────────────────────────────────────

pub fn create_ban(conn: &Connection, ban: &Ban) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO bans (team_id, user_id, banned_by, reason, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![ban.team_id, ban.user_id, ban.banned_by, ban.reason, ban.created_at],
    )?;
    Ok(())
}

pub fn delete_ban(
    conn: &Connection,
    team_id: &str,
    user_id: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM bans WHERE team_id = ?1 AND user_id = ?2",
        params![team_id, user_id],
    )?;
    Ok(())
}

pub fn get_ban(
    conn: &Connection,
    team_id: &str,
    user_id: &str,
) -> Result<Option<Ban>, rusqlite::Error> {
    conn.query_row(
        "SELECT team_id, user_id, banned_by, reason, created_at FROM bans WHERE team_id = ?1 AND user_id = ?2",
        params![team_id, user_id],
        |row| {
            Ok(Ban {
                team_id: row.get(0)?,
                user_id: row.get(1)?,
                banned_by: row.get(2)?,
                reason: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                created_at: row.get(4)?,
            })
        },
    )
    .optional()
}

#[allow(dead_code)]
pub fn get_banned_users(
    conn: &Connection,
    team_id: &str,
) -> Result<Vec<Ban>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT team_id, user_id, banned_by, reason, created_at FROM bans WHERE team_id = ?1",
    )?;
    let rows = stmt.query_map([team_id], |row| {
        Ok(Ban {
            team_id: row.get(0)?,
            user_id: row.get(1)?,
            banned_by: row.get(2)?,
            reason: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            created_at: row.get(4)?,
        })
    })?;
    rows.collect()
}

// ── Prekey bundle queries ───────────────────────────────────────────────────

pub fn save_prekey_bundle(
    conn: &Connection,
    bundle: &PrekeyBundle,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT OR REPLACE INTO prekey_bundles (id, user_id, identity_key, signed_prekey, signed_prekey_signature, one_time_prekeys, uploaded_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            bundle.id,
            bundle.user_id,
            bundle.identity_key,
            bundle.signed_prekey,
            bundle.signed_prekey_signature,
            bundle.one_time_prekeys,
            bundle.uploaded_at,
        ],
    )?;
    Ok(())
}

pub fn get_prekey_bundle(
    conn: &Connection,
    user_id: &str,
) -> Result<Option<PrekeyBundle>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, user_id, identity_key, signed_prekey, signed_prekey_signature, one_time_prekeys, uploaded_at
         FROM prekey_bundles WHERE user_id = ?1",
        [user_id],
        |row| {
            Ok(PrekeyBundle {
                id: row.get(0)?,
                user_id: row.get(1)?,
                identity_key: row.get(2)?,
                signed_prekey: row.get(3)?,
                signed_prekey_signature: row.get(4)?,
                one_time_prekeys: row.get::<_, Option<Vec<u8>>>(5)?.unwrap_or_default(),
                uploaded_at: row.get(6)?,
            })
        },
    )
    .optional()
}

pub fn delete_prekey_bundle(conn: &Connection, user_id: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM prekey_bundles WHERE user_id = ?1",
        [user_id],
    )?;
    Ok(())
}

pub fn consume_one_time_prekey(
    conn: &Connection,
    user_id: &str,
) -> Result<Option<Vec<u8>>, rusqlite::Error> {
    let bundle = get_prekey_bundle(conn, user_id)?;
    if let Some(bundle) = bundle {
        if bundle.one_time_prekeys.is_empty() {
            return Ok(None);
        }
        // Parse JSON array of base64-encoded prekeys, pop the first one.
        let keys: Vec<String> = serde_json::from_slice(&bundle.one_time_prekeys).unwrap_or_default();
        if keys.is_empty() {
            return Ok(None);
        }
        let consumed = keys[0].clone();
        let remaining = &keys[1..];
        let remaining_json = serde_json::to_vec(remaining).unwrap_or_default();
        conn.execute(
            "UPDATE prekey_bundles SET one_time_prekeys = ?1 WHERE user_id = ?2",
            params![remaining_json, user_id],
        )?;
        use base64::Engine;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&consumed)
            .unwrap_or_default();
        Ok(Some(decoded))
    } else {
        Ok(None)
    }
}

// ── Settings queries ────────────────────────────────────────────────────────

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        [key],
        |row| row.get(0),
    )
    .optional()
}

pub fn set_setting(
    conn: &Connection,
    key: &str,
    value: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        params![key, value],
    )?;
    Ok(())
}

// ── Identity blob queries ───────────────────────────────────────────────────

pub fn upsert_identity_blob(
    conn: &Connection,
    user_id: &str,
    blob: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('identity_blob:' || ?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = ?2",
        params![user_id, blob],
    )?;
    Ok(())
}

pub fn get_identity_blob(
    conn: &Connection,
    user_id: &str,
) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = 'identity_blob:' || ?1",
        [user_id],
        |row| row.get(0),
    )
    .optional()
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

    // ── Ban tests ───────────────────────────────────────────────────────

    #[test]
    fn test_create_ban_and_fetch() {
        let db = test_db();
        let owner = make_user("u1", "owner", &[1u8; 32]);
        let target = make_user("u2", "target", &[2u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &owner)).unwrap();
        db.with_conn(|c| crate::db::create_user(c, &target)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();

        let ban = Ban {
            team_id: "t1".into(), user_id: "u2".into(), banned_by: "u1".into(),
            reason: "spamming".into(), created_at: crate::db::now_str(),
        };
        db.with_conn(|c| create_ban(c, &ban)).unwrap();

        let fetched = db.with_conn(|c| get_ban(c, "t1", "u2")).unwrap().unwrap();
        assert_eq!(fetched.reason, "spamming");
        assert_eq!(fetched.banned_by, "u1");
    }

    #[test]
    fn test_delete_ban() {
        let db = test_db();
        let owner = make_user("u1", "owner", &[1u8; 32]);
        let target = make_user("u2", "target", &[2u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &owner)).unwrap();
        db.with_conn(|c| crate::db::create_user(c, &target)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();

        let ban = Ban {
            team_id: "t1".into(), user_id: "u2".into(), banned_by: "u1".into(),
            reason: "".into(), created_at: crate::db::now_str(),
        };
        db.with_conn(|c| create_ban(c, &ban)).unwrap();
        db.with_conn(|c| delete_ban(c, "t1", "u2")).unwrap();

        let result = db.with_conn(|c| get_ban(c, "t1", "u2")).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_get_banned_users() {
        let db = test_db();
        let owner = make_user("u1", "owner", &[1u8; 32]);
        let u2 = make_user("u2", "user2", &[2u8; 32]);
        let u3 = make_user("u3", "user3", &[3u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &owner)).unwrap();
        db.with_conn(|c| crate::db::create_user(c, &u2)).unwrap();
        db.with_conn(|c| crate::db::create_user(c, &u3)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();

        let now = crate::db::now_str();
        for uid in &["u2", "u3"] {
            let ban = Ban {
                team_id: "t1".into(), user_id: uid.to_string(), banned_by: "u1".into(),
                reason: "".into(), created_at: now.clone(),
            };
            db.with_conn(|c| create_ban(c, &ban)).unwrap();
        }

        let bans = db.with_conn(|c| get_banned_users(c, "t1")).unwrap();
        assert_eq!(bans.len(), 2);
    }

    // ── Prekey bundle tests ─────────────────────────────────────────────

    #[test]
    fn test_save_and_get_prekey_bundle() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();

        let bundle = PrekeyBundle {
            id: "pk1".into(), user_id: "u1".into(),
            identity_key: vec![1, 2, 3], signed_prekey: vec![4, 5, 6],
            signed_prekey_signature: vec![7, 8, 9],
            one_time_prekeys: vec![], uploaded_at: crate::db::now_str(),
        };
        db.with_conn(|c| save_prekey_bundle(c, &bundle)).unwrap();

        let fetched = db.with_conn(|c| get_prekey_bundle(c, "u1")).unwrap().unwrap();
        assert_eq!(fetched.identity_key, vec![1, 2, 3]);
    }

    #[test]
    fn test_delete_prekey_bundle() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();

        let bundle = PrekeyBundle {
            id: "pk1".into(), user_id: "u1".into(),
            identity_key: vec![1], signed_prekey: vec![2],
            signed_prekey_signature: vec![3],
            one_time_prekeys: vec![], uploaded_at: crate::db::now_str(),
        };
        db.with_conn(|c| save_prekey_bundle(c, &bundle)).unwrap();
        db.with_conn(|c| delete_prekey_bundle(c, "u1")).unwrap();

        let result = db.with_conn(|c| get_prekey_bundle(c, "u1")).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_consume_one_time_prekey() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();

        use base64::Engine;
        let key1 = base64::engine::general_purpose::STANDARD.encode([10u8, 20, 30]);
        let key2 = base64::engine::general_purpose::STANDARD.encode([40u8, 50, 60]);
        let prekeys_json = serde_json::to_vec(&vec![key1, key2]).unwrap();

        let bundle = PrekeyBundle {
            id: "pk1".into(), user_id: "u1".into(),
            identity_key: vec![1], signed_prekey: vec![2],
            signed_prekey_signature: vec![3],
            one_time_prekeys: prekeys_json, uploaded_at: crate::db::now_str(),
        };
        db.with_conn(|c| save_prekey_bundle(c, &bundle)).unwrap();

        let consumed = db.with_conn(|c| consume_one_time_prekey(c, "u1")).unwrap().unwrap();
        assert_eq!(consumed, vec![10u8, 20, 30]);

        let consumed2 = db.with_conn(|c| consume_one_time_prekey(c, "u1")).unwrap().unwrap();
        assert_eq!(consumed2, vec![40u8, 50, 60]);

        let consumed3 = db.with_conn(|c| consume_one_time_prekey(c, "u1")).unwrap();
        assert!(consumed3.is_none());
    }

    // ── Settings tests ──────────────────────────────────────────────────

    #[test]
    fn test_set_and_get_setting() {
        let db = test_db();
        db.with_conn(|c| set_setting(c, "theme", "dark")).unwrap();

        let val = db.with_conn(|c| get_setting(c, "theme")).unwrap().unwrap();
        assert_eq!(val, "dark");
    }

    #[test]
    fn test_get_nonexistent_setting() {
        let db = test_db();
        let val = db.with_conn(|c| get_setting(c, "nope")).unwrap();
        assert!(val.is_none());
    }

    #[test]
    fn test_set_setting_upsert() {
        let db = test_db();
        db.with_conn(|c| set_setting(c, "key", "val1")).unwrap();
        db.with_conn(|c| set_setting(c, "key", "val2")).unwrap();

        let val = db.with_conn(|c| get_setting(c, "key")).unwrap().unwrap();
        assert_eq!(val, "val2");
    }

    // ── Identity blob tests ─────────────────────────────────────────────

    #[test]
    fn test_upsert_and_get_identity_blob() {
        let db = test_db();
        db.with_conn(|c| upsert_identity_blob(c, "u1", r#"{"data":"blob"}"#)).unwrap();

        let blob = db.with_conn(|c| get_identity_blob(c, "u1")).unwrap().unwrap();
        assert_eq!(blob, r#"{"data":"blob"}"#);

        db.with_conn(|c| upsert_identity_blob(c, "u1", r#"{"data":"updated"}"#)).unwrap();
        let blob2 = db.with_conn(|c| get_identity_blob(c, "u1")).unwrap().unwrap();
        assert_eq!(blob2, r#"{"data":"updated"}"#);
    }

    // ── Migration tests ─────────────────────────────────────────────────

    #[test]
    fn test_run_migrations_idempotent() {
        let db = test_db();
        db.run_migrations().unwrap();
        db.run_migrations().unwrap();
    }
}
