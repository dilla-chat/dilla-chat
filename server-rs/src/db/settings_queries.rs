use rusqlite::{params, Connection, OptionalExtension};

// ── Settings queries ────────────────────────────────────────────────────────

#[allow(dead_code)] // Public API for future use (server settings management)
pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        [key],
        |row| row.get(0),
    )
    .optional()
}

#[allow(dead_code)] // Public API for future use (server settings management)
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
