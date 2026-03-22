use serde_json::Value;

use axum::Json;

use crate::db;
use crate::error::AppError;

/// Verify that a user is a member of the given team, returning `Err` if not.
pub fn require_team_member(
    conn: &rusqlite::Connection,
    user_id: &str,
    team_id: &str,
) -> Result<(), rusqlite::Error> {
    if db::get_member_by_user_and_team(conn, user_id, team_id)?.is_none() {
        return Err(rusqlite::Error::InvalidParameterName(
            "not a member of this team".into(),
        ));
    }
    Ok(())
}

/// Check that a user has a specific permission in a team, returning `Err` if not.
pub fn require_permission(
    conn: &rusqlite::Connection,
    user_id: &str,
    team_id: &str,
    permission: i64,
) -> Result<(), rusqlite::Error> {
    if !db::user_has_permission(conn, user_id, team_id, permission)? {
        return Err(rusqlite::Error::InvalidParameterName(
            "insufficient permissions".into(),
        ));
    }
    Ok(())
}

/// Run a blocking database closure on `spawn_blocking` and flatten the join error.
pub async fn spawn_db<F, T>(db: db::Database, f: F) -> Result<T, AppError>
where
    F: FnOnce(&rusqlite::Connection) -> Result<T, rusqlite::Error> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(move || db.with_conn(f))
        .await
        .map_err(|e| AppError::Internal(format!("task join: {}", e)))?
        .map_err(map_db_error)
}

/// Map a rusqlite error to the appropriate AppError variant.
///
/// - `InvalidParameterName` -> `Forbidden`
/// - `QueryReturnedNoRows` -> `NotFound` with a generic message
/// - everything else -> `Internal`
pub fn map_db_error(e: rusqlite::Error) -> AppError {
    match e {
        rusqlite::Error::InvalidParameterName(msg) => AppError::Forbidden(msg),
        rusqlite::Error::QueryReturnedNoRows => AppError::NotFound("not found".into()),
        other => AppError::Internal(format!("db: {}", other)),
    }
}

/// Convenience: wrap a serializable value in `Json<Value>`.
pub fn json_ok<T: serde::Serialize>(val: T) -> Result<Json<Value>, AppError> {
    Ok(Json(serde_json::json!(val)))
}

/// Convenience: return `{ "ok": true }` as JSON.
pub fn json_ok_true() -> Result<Json<Value>, AppError> {
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{self, Database};

    fn test_db() -> (Database, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
        db.run_migrations().unwrap();
        (db, tmp)
    }

    // ── map_db_error tests ──────────────────────────────────────────────

    #[test]
    fn map_db_error_invalid_parameter_name_returns_forbidden() {
        let err = rusqlite::Error::InvalidParameterName("no access".into());
        let app_err = map_db_error(err);
        match app_err {
            AppError::Forbidden(msg) => assert_eq!(msg, "no access"),
            other => panic!("expected Forbidden, got {:?}", other),
        }
    }

    #[test]
    fn map_db_error_query_returned_no_rows_returns_not_found() {
        let err = rusqlite::Error::QueryReturnedNoRows;
        let app_err = map_db_error(err);
        match app_err {
            AppError::NotFound(msg) => assert_eq!(msg, "not found"),
            other => panic!("expected NotFound, got {:?}", other),
        }
    }

    #[test]
    fn map_db_error_other_returns_internal() {
        let err = rusqlite::Error::InvalidColumnIndex(42);
        let app_err = map_db_error(err);
        match app_err {
            AppError::Internal(msg) => assert!(msg.starts_with("db:")),
            other => panic!("expected Internal, got {:?}", other),
        }
    }

    // ── json_ok tests ───────────────────────────────────────────────────

    #[test]
    fn json_ok_wraps_value() {
        let result = json_ok(serde_json::json!({"name": "test"}));
        assert!(result.is_ok());
        let json = result.unwrap();
        assert_eq!(json.0["name"], "test");
    }

    #[test]
    fn json_ok_with_string() {
        let result = json_ok("hello");
        assert!(result.is_ok());
        let json = result.unwrap();
        assert_eq!(json.0, "hello");
    }

    #[test]
    fn json_ok_with_vec() {
        let result = json_ok(vec![1, 2, 3]);
        assert!(result.is_ok());
        let json = result.unwrap();
        assert_eq!(json.0, serde_json::json!([1, 2, 3]));
    }

    // ── json_ok_true tests ──────────────────────────────────────────────

    #[test]
    fn json_ok_true_returns_ok_true() {
        let result = json_ok_true();
        assert!(result.is_ok());
        let json = result.unwrap();
        assert_eq!(json.0["ok"], true);
    }

    // ── require_team_member tests ───────────────────────────────────────

    #[test]
    fn require_team_member_success() {
        let (db, _tmp) = test_db();
        let now = db::now_str();

        db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: "u1".into(),
                username: "alice".into(),
                display_name: "Alice".into(),
                public_key: vec![1u8; 32],
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            })?;
            db::create_team(conn, &db::Team {
                id: "t1".into(),
                name: "Team".into(),
                description: String::new(),
                icon_url: String::new(),
                created_by: "u1".into(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                created_at: now.clone(),
                updated_at: now.clone(),
            })?;
            db::create_member(conn, &db::Member {
                id: "m1".into(),
                team_id: "t1".into(),
                user_id: "u1".into(),
                nickname: String::new(),
                joined_at: now.clone(),
                invited_by: String::new(),
                updated_at: String::new(),
            })?;
            require_team_member(conn, "u1", "t1")
        })
        .unwrap();
    }

    #[test]
    fn require_team_member_not_member_returns_error() {
        let (db, _tmp) = test_db();
        let now = db::now_str();

        let result = db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: "u1".into(),
                username: "alice".into(),
                display_name: "Alice".into(),
                public_key: vec![1u8; 32],
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            })?;
            db::create_team(conn, &db::Team {
                id: "t1".into(),
                name: "Team".into(),
                description: String::new(),
                icon_url: String::new(),
                created_by: "u1".into(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                created_at: now.clone(),
                updated_at: now.clone(),
            })?;
            require_team_member(conn, "u1", "t1")
        });
        assert!(result.is_err());
    }

    // ── require_permission tests ────────────────────────────────────────

    #[test]
    fn require_permission_success_as_owner() {
        let (db, _tmp) = test_db();
        let now = db::now_str();

        db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: "u1".into(),
                username: "owner".into(),
                display_name: "Owner".into(),
                public_key: vec![1u8; 32],
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            })?;
            db::create_team(conn, &db::Team {
                id: "t1".into(),
                name: "Team".into(),
                description: String::new(),
                icon_url: String::new(),
                created_by: "u1".into(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                created_at: now.clone(),
                updated_at: now.clone(),
            })?;
            require_permission(conn, "u1", "t1", db::PERM_MANAGE_CHANNELS)
        })
        .unwrap();
    }

    #[test]
    fn require_permission_denied_without_role() {
        let (db, _tmp) = test_db();
        let now = db::now_str();

        let result = db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: "u1".into(),
                username: "owner".into(),
                display_name: "Owner".into(),
                public_key: vec![1u8; 32],
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            })?;
            db::create_user(conn, &db::User {
                id: "u2".into(),
                username: "member".into(),
                display_name: "Member".into(),
                public_key: vec![2u8; 32],
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            })?;
            db::create_team(conn, &db::Team {
                id: "t1".into(),
                name: "Team".into(),
                description: String::new(),
                icon_url: String::new(),
                created_by: "u1".into(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                created_at: now.clone(),
                updated_at: now.clone(),
            })?;
            db::create_member(conn, &db::Member {
                id: "m1".into(),
                team_id: "t1".into(),
                user_id: "u2".into(),
                nickname: String::new(),
                joined_at: now.clone(),
                invited_by: String::new(),
                updated_at: String::new(),
            })?;
            require_permission(conn, "u2", "t1", db::PERM_MANAGE_CHANNELS)
        });
        assert!(result.is_err());
    }

    // ── spawn_db tests ──────────────────────────────────────────────────

    #[tokio::test]
    async fn spawn_db_success() {
        let (db, _tmp) = test_db();
        let result = spawn_db(db, |_conn| Ok(42)).await;
        assert_eq!(result.unwrap(), 42);
    }

    #[tokio::test]
    async fn spawn_db_maps_error() {
        let (db, _tmp) = test_db();
        let result: Result<(), AppError> = spawn_db(db, |_conn| {
            Err(rusqlite::Error::QueryReturnedNoRows)
        })
        .await;
        match result {
            Err(AppError::NotFound(_)) => {}
            other => panic!("expected NotFound, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn spawn_db_maps_forbidden() {
        let (db, _tmp) = test_db();
        let result: Result<(), AppError> = spawn_db(db, |_conn| {
            Err(rusqlite::Error::InvalidParameterName("denied".into()))
        })
        .await;
        match result {
            Err(AppError::Forbidden(msg)) => assert_eq!(msg, "denied"),
            other => panic!("expected Forbidden, got {:?}", other),
        }
    }
}
