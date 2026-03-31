use super::models::*;
use super::now_str;
use rusqlite::{params, Connection, OptionalExtension};

pub fn create_user(conn: &Connection, user: &User) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO users (id, username, display_name, public_key, avatar_url, status_text, status_type, is_admin, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            user.id,
            user.username,
            user.display_name,
            user.public_key,
            user.avatar_url,
            user.status_text,
            user.status_type,
            user.is_admin as i32,
            user.created_at,
            user.updated_at,
        ],
    )?;
    Ok(())
}

pub fn get_user_by_id(conn: &Connection, id: &str) -> Result<Option<User>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, username, display_name, public_key, avatar_url, status_text, status_type, is_admin, created_at, updated_at FROM users WHERE id = ?1",
        [id],
        row_to_user,
    )
    .optional()
}

pub fn get_user_by_username(
    conn: &Connection,
    username: &str,
) -> Result<Option<User>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, username, display_name, public_key, avatar_url, status_text, status_type, is_admin, created_at, updated_at FROM users WHERE username = ?1",
        [username],
        row_to_user,
    )
    .optional()
}

pub fn get_user_by_public_key(
    conn: &Connection,
    public_key: &[u8],
) -> Result<Option<User>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, username, display_name, public_key, avatar_url, status_text, status_type, is_admin, created_at, updated_at FROM users WHERE public_key = ?1",
        [public_key],
        row_to_user,
    )
    .optional()
}

pub fn update_user(conn: &Connection, user: &User) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE users SET display_name = ?1, avatar_url = ?2, status_text = ?3, status_type = ?4, updated_at = ?5 WHERE id = ?6",
        params![
            user.display_name,
            user.avatar_url,
            user.status_text,
            user.status_type,
            now_str(),
            user.id,
        ],
    )?;
    Ok(())
}

pub fn update_user_status(
    conn: &Connection,
    user_id: &str,
    status_type: &str,
    custom_status: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE users SET status_type = ?1, status_text = ?2, updated_at = ?3 WHERE id = ?4",
        params![status_type, custom_status, now_str(), user_id],
    )?;
    Ok(())
}

/// Delete a user and all their data (GDPR right to erasure).
///
/// Removes all user-owned data in the correct order to satisfy FK constraints.
/// Messages are hard-deleted (E2E encrypted content is meaningless without keys).
/// Returns an error if the user is the sole admin of any team.
pub fn delete_user(conn: &Connection, user_id: &str) -> Result<(), rusqlite::Error> {
    // 1. Check that the user isn't the sole admin of any team.
    let sole_admin_count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM teams t
         WHERE t.created_by = ?1
         AND NOT EXISTS (
             SELECT 1 FROM members m
             JOIN member_roles mr ON mr.member_id = m.id
             JOIN roles r ON r.id = mr.role_id
             WHERE m.team_id = t.id AND m.user_id != ?1 AND r.permissions & 1 != 0
         )",
        [user_id],
        |row| row.get(0),
    )?;
    if sole_admin_count > 0 {
        return Err(rusqlite::Error::InvalidParameterName(
            "cannot delete: user is the sole admin of a team — transfer ownership first".into(),
        ));
    }

    // 2. Delete reactions by user.
    conn.execute("DELETE FROM reactions WHERE user_id = ?1", [user_id])?;
    // 3. Delete attachments for user's messages.
    conn.execute(
        "DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE author_id = ?1)",
        [user_id],
    )?;
    // 4. Delete threads created by user (cascades to thread messages via thread_id).
    conn.execute(
        "DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE creator_id = ?1)",
        [user_id],
    )?;
    conn.execute("DELETE FROM threads WHERE creator_id = ?1", [user_id])?;
    // 5. Hard-delete user's messages (GDPR erasure).
    conn.execute("DELETE FROM messages WHERE author_id = ?1", [user_id])?;
    // 6. Delete DM memberships.
    conn.execute("DELETE FROM dm_members WHERE user_id = ?1", [user_id])?;
    // 7. Delete invite uses.
    conn.execute("DELETE FROM invite_uses WHERE user_id = ?1", [user_id])?;
    // 8. Delete invites created by user.
    conn.execute("DELETE FROM invites WHERE created_by = ?1", [user_id])?;
    // 9. Delete bans (both as target and as banner).
    conn.execute("DELETE FROM bans WHERE user_id = ?1 OR banned_by = ?1", [user_id])?;
    // 10. Delete prekey bundles.
    conn.execute("DELETE FROM prekey_bundles WHERE user_id = ?1", [user_id])?;
    // 11. Nullify optional FK references.
    conn.execute("UPDATE channels SET created_by = NULL WHERE created_by = ?1", [user_id])?;
    conn.execute("UPDATE members SET invited_by = NULL WHERE invited_by = ?1", [user_id])?;
    // 12. Delete member_roles and members.
    conn.execute(
        "DELETE FROM member_roles WHERE member_id IN (SELECT id FROM members WHERE user_id = ?1)",
        [user_id],
    )?;
    conn.execute("DELETE FROM members WHERE user_id = ?1", [user_id])?;
    // 13. Delete identity blob.
    conn.execute(
        "DELETE FROM settings WHERE key = 'identity_blob:' || ?1",
        [user_id],
    )?;
    // 14. Finally delete the user.
    conn.execute("DELETE FROM users WHERE id = ?1", [user_id])?;
    Ok(())
}

fn row_to_user(row: &rusqlite::Row) -> Result<User, rusqlite::Error> {
    Ok(User {
        id: row.get(0)?,
        username: row.get(1)?,
        display_name: row.get(2)?,
        public_key: row.get(3)?,
        avatar_url: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
        status_text: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
        status_type: row.get::<_, Option<String>>(6)?.unwrap_or("online".into()),
        is_admin: row.get::<_, i32>(7)? != 0,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::*;

    #[test]
    fn test_create_user_and_fetch_by_id() {
        let db = test_db();
        let user = make_user("u1", "alice", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();

        let fetched = db.with_conn(|c| get_user_by_id(c, "u1")).unwrap().unwrap();
        assert_eq!(fetched.username, "alice");
        assert_eq!(fetched.public_key, vec![1u8; 32]);
    }

    #[test]
    fn test_get_user_by_public_key() {
        let db = test_db();
        let pk = vec![42u8; 32];
        let user = make_user("u1", "bob", &pk);
        db.with_conn(|c| create_user(c, &user)).unwrap();

        let fetched = db.with_conn(|c| get_user_by_public_key(c, &pk)).unwrap().unwrap();
        assert_eq!(fetched.id, "u1");
    }

    #[test]
    fn test_get_user_by_username() {
        let db = test_db();
        let user = make_user("u1", "charlie", &[3u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();

        let fetched = db.with_conn(|c| get_user_by_username(c, "charlie")).unwrap().unwrap();
        assert_eq!(fetched.id, "u1");

        let none = db.with_conn(|c| get_user_by_username(c, "nonexistent")).unwrap();
        assert!(none.is_none());
    }

    #[test]
    fn test_get_nonexistent_user_returns_none() {
        let db = test_db();
        let result = db.with_conn(|c| get_user_by_id(c, "nope")).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_update_user() {
        let db = test_db();
        let mut user = make_user("u1", "dave", &[4u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();

        user.display_name = "Dave the Great".to_string();
        user.avatar_url = "https://example.com/avatar.png".to_string();
        db.with_conn(|c| update_user(c, &user)).unwrap();

        let fetched = db.with_conn(|c| get_user_by_id(c, "u1")).unwrap().unwrap();
        assert_eq!(fetched.display_name, "Dave the Great");
        assert_eq!(fetched.avatar_url, "https://example.com/avatar.png");
    }

    #[test]
    fn test_update_user_status() {
        let db = test_db();
        let user = make_user("u1", "eve", &[5u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();

        db.with_conn(|c| update_user_status(c, "u1", "dnd", "busy")).unwrap();
        let fetched = db.with_conn(|c| get_user_by_id(c, "u1")).unwrap().unwrap();
        assert_eq!(fetched.status_type, "dnd");
        assert_eq!(fetched.status_text, "busy");
    }

    #[test]
    fn test_has_users() {
        let db = test_db();
        assert!(!db.has_users().unwrap());

        let user = make_user("u1", "frank", &[6u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();
        assert!(db.has_users().unwrap());
    }

    #[test]
    fn test_create_user_duplicate_username_fails() {
        let db = test_db();
        let user1 = make_user("u1", "same_name", &[1u8; 32]);
        let user2 = make_user("u2", "same_name", &[2u8; 32]);
        db.with_conn(|c| create_user(c, &user1)).unwrap();
        let result = db.with_conn(|c| create_user(c, &user2));
        assert!(result.is_err());
    }

    #[test]
    fn test_create_user_duplicate_public_key_fails() {
        let db = test_db();
        let pk = vec![99u8; 32];
        let user1 = make_user("u1", "user_a", &pk);
        let user2 = make_user("u2", "user_b", &pk);
        db.with_conn(|c| create_user(c, &user1)).unwrap();
        let result = db.with_conn(|c| create_user(c, &user2));
        assert!(result.is_err());
    }

    #[test]
    fn test_delete_user_removes_all_data() {
        let db = test_db();
        let user = make_user("u1", "alice", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();

        db.with_conn(|c| delete_user(c, "u1")).unwrap();

        let result = db.with_conn(|c| get_user_by_id(c, "u1")).unwrap();
        assert!(result.is_none());
        assert!(!db.has_users().unwrap());
    }

    #[test]
    fn test_delete_user_with_messages_and_team() {
        let db = test_db();
        let user1 = make_user("u1", "alice", &[1u8; 32]);
        let user2 = make_user("u2", "bob", &[2u8; 32]);
        db.with_conn(|c| create_user(c, &user1)).unwrap();
        db.with_conn(|c| create_user(c, &user2)).unwrap();

        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();
        let ch = make_channel("ch1", "t1", "general", "u1");
        db.with_conn(|c| crate::db::create_channel(c, &ch)).unwrap();
        let m1 = make_member("m1", "t1", "u1");
        db.with_conn(|c| crate::db::create_member(c, &m1)).unwrap();
        let m2 = make_member("m2", "t1", "u2");
        db.with_conn(|c| crate::db::create_member(c, &m2)).unwrap();

        // Give u2 admin role so u1 isn't sole admin.
        let role = crate::db::Role {
            id: "r1".into(),
            team_id: "t1".into(),
            name: "Admin".into(),
            color: "#000".into(),
            position: 0,
            permissions: 1, // PERM_ADMIN
            is_default: false,
            created_at: crate::db::now_str(),
            updated_at: String::new(),
        };
        db.with_conn(|c| crate::db::create_role(c, &role)).unwrap();
        db.with_conn(|c| crate::db::assign_role_to_member(c, "m2", "r1")).unwrap();

        let msg = make_message("msg1", "ch1", "u1", "hello");
        db.with_conn(|c| crate::db::create_message(c, &msg)).unwrap();

        // Delete u1.
        db.with_conn(|c| delete_user(c, "u1")).unwrap();

        // User is gone.
        assert!(db.with_conn(|c| get_user_by_id(c, "u1")).unwrap().is_none());
        // Message is gone.
        assert!(db.with_conn(|c| crate::db::get_message_by_id(c, "msg1")).unwrap().is_none());
        // Team and other user still exist.
        assert!(db.with_conn(|c| get_user_by_id(c, "u2")).unwrap().is_some());
    }

    #[test]
    fn test_delete_sole_admin_fails() {
        let db = test_db();
        let user = make_user("u1", "alice", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();

        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();

        let result = db.with_conn(|c| delete_user(c, "u1"));
        assert!(result.is_err());
    }
}
