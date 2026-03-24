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
}
