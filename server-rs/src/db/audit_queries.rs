use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEvent {
    pub id: String,
    pub team_id: String,
    pub actor_user_id: Option<String>,
    pub action: String,
    pub target_type: Option<String>,
    pub target_id: Option<String>,
    pub details: Option<String>,
    pub created_at: String,
}

pub fn insert_audit_event(
    conn: &Connection,
    team_id: &str,
    actor_user_id: Option<&str>,
    action: &str,
    target_type: Option<&str>,
    target_id: Option<&str>,
    details: Option<&serde_json::Value>,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO audit_events (id, team_id, actor_user_id, action, target_type, target_id, details, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))",
        params![
            super::new_id(),
            team_id,
            actor_user_id,
            action,
            target_type,
            target_id,
            details.map(|v| v.to_string()),
        ],
    )?;
    Ok(())
}

pub fn list_audit_events(
    conn: &Connection,
    team_id: &str,
    limit: i64,
) -> Result<Vec<AuditEvent>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, team_id, actor_user_id, action, target_type, target_id, details, created_at
         FROM audit_events WHERE team_id = ?1
         ORDER BY created_at DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![team_id, limit], |row| {
        Ok(AuditEvent {
            id: row.get(0)?,
            team_id: row.get(1)?,
            actor_user_id: row.get::<_, Option<String>>(2)?,
            action: row.get(3)?,
            target_type: row.get::<_, Option<String>>(4)?,
            target_id: row.get::<_, Option<String>>(5)?,
            details: row.get::<_, Option<String>>(6)?,
            created_at: row.get(7)?,
        })
    })?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::*;

    fn seed_team(db: &crate::db::Database) {
        db.with_conn(|c| crate::db::create_user(c, &make_user("u1", "alice", &[1u8; 32]))).unwrap();
        db.with_conn(|c| crate::db::create_team(c, &make_team("t1", "Team", "u1"))).unwrap();
    }

    #[test]
    fn insert_then_list_roundtrips_the_envelope() {
        let db = test_db();
        seed_team(&db);
        db.with_conn(|c| {
            insert_audit_event(c, "t1", Some("u1"), "member.join", Some("user"), Some("u1"),
                Some(&serde_json::json!({"role": "everyone"})))?;
            let events = list_audit_events(c, "t1", 10)?;
            assert_eq!(events.len(), 1);
            assert_eq!(events[0].action, "member.join");
            assert_eq!(events[0].actor_user_id.as_deref(), Some("u1"));
            assert_eq!(events[0].target_type.as_deref(), Some("user"));
            assert_eq!(events[0].target_id.as_deref(), Some("u1"));
            assert!(events[0].details.as_ref().unwrap().contains("everyone"));
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn insert_tolerates_none_actor_and_target() {
        let db = test_db();
        seed_team(&db);
        db.with_conn(|c| {
            insert_audit_event(c, "t1", None, "system.boot", None, None, None)?;
            let events = list_audit_events(c, "t1", 10)?;
            assert_eq!(events.len(), 1);
            assert!(events[0].actor_user_id.is_none());
            assert!(events[0].target_type.is_none());
            assert!(events[0].details.is_none());
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn list_returns_empty_for_unknown_team() {
        let db = test_db();
        db.with_conn(|c| {
            let events = list_audit_events(c, "no-such-team", 10)?;
            assert!(events.is_empty());
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn list_honors_the_limit() {
        let db = test_db();
        seed_team(&db);
        db.with_conn(|c| {
            for i in 0..5 {
                insert_audit_event(c, "t1", Some("u1"), &format!("evt.{}", i), None, None, None)?;
            }
            let events = list_audit_events(c, "t1", 3)?;
            assert_eq!(events.len(), 3);
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn list_orders_by_created_at_desc() {
        let db = test_db();
        seed_team(&db);
        db.with_conn(|c| {
            insert_audit_event(c, "t1", Some("u1"), "first", None, None, None)?;
            // SQLite datetime('now') resolution is 1 second — sleep
            // briefly so the second insert gets a later timestamp.
            std::thread::sleep(std::time::Duration::from_millis(1100));
            insert_audit_event(c, "t1", Some("u1"), "second", None, None, None)?;
            let events = list_audit_events(c, "t1", 10)?;
            // Most-recent first.
            assert_eq!(events[0].action, "second");
            assert_eq!(events[1].action, "first");
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }
}
