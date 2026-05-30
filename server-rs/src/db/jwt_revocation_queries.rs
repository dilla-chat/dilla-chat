use rusqlite::{params, Connection};

/// Insert a JWT id (`jti`) into the revocation list with its natural
/// expiry as a unix timestamp. The row is GC'd by `gc_revoked_jtis` once
/// past expiry — keeping it small enough that the on-each-request lookup
/// stays a primary-key probe.
///
/// H2 / VULN-012 / AUTH-WEAK-1.
pub fn revoke_jti(conn: &Connection, jti: &str, expires_at: i64) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT OR REPLACE INTO jwt_revocations (jti, expires_at, revoked_at)
         VALUES (?1, ?2, datetime('now'))",
        params![jti, expires_at],
    )?;
    Ok(())
}

/// True when a JWT id is on the revocation list and has not yet expired.
/// Expired rows return false so a long-since-invalid jti can't pin a
/// row in the table forever — pair with `gc_revoked_jtis` to actually
/// remove it.
pub fn is_revoked(conn: &Connection, jti: &str) -> Result<bool, rusqlite::Error> {
    let now = chrono::Utc::now().timestamp();
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM jwt_revocations WHERE jti = ?1 AND expires_at > ?2",
        params![jti, now],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// Drop all revocation rows whose `expires_at` is in the past. Returns
/// the number of rows deleted. Call periodically from a background task.
#[allow(dead_code)]
pub fn gc_revoked_jtis(conn: &Connection) -> Result<usize, rusqlite::Error> {
    let now = chrono::Utc::now().timestamp();
    let n = conn.execute(
        "DELETE FROM jwt_revocations WHERE expires_at <= ?1",
        params![now],
    )?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn test_db() -> Database {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
        db.run_migrations().unwrap();
        std::mem::forget(tmp);
        db
    }

    #[test]
    fn revoke_and_check_revoked() {
        let db = test_db();
        let future = chrono::Utc::now().timestamp() + 3600;
        db.with_conn(|c| {
            revoke_jti(c, "test-jti-1", future)?;
            assert!(is_revoked(c, "test-jti-1")?);
            assert!(!is_revoked(c, "other-jti")?);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn expired_revocation_treated_as_unrevoked() {
        let db = test_db();
        let past = chrono::Utc::now().timestamp() - 10;
        db.with_conn(|c| {
            revoke_jti(c, "expired-jti", past)?;
            assert!(!is_revoked(c, "expired-jti")?);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn gc_drops_expired_rows() {
        let db = test_db();
        let now = chrono::Utc::now().timestamp();
        db.with_conn(|c| {
            revoke_jti(c, "old", now - 10)?;
            revoke_jti(c, "new", now + 600)?;
            let removed = gc_revoked_jtis(c)?;
            assert_eq!(removed, 1);
            // The fresh one is still present.
            assert!(is_revoked(c, "new")?);
            Ok(())
        })
        .unwrap();
    }
}
