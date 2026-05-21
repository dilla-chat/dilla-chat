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
