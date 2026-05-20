use rusqlite::{params, Connection};

/// Return the role IDs that gate access to this channel. Empty list = no
/// gating (open to anyone in the team).
pub fn get_channel_access_roles(
    conn: &Connection,
    channel_id: &str,
) -> Result<Vec<String>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT role_id FROM channel_role_access WHERE channel_id = ?1",
    )?;
    let rows = stmt.query_map(params![channel_id], |row| row.get::<_, String>(0))?;
    rows.collect()
}

pub fn set_channel_access_roles(
    conn: &Connection,
    channel_id: &str,
    role_ids: &[String],
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM channel_role_access WHERE channel_id = ?1",
        params![channel_id],
    )?;
    for rid in role_ids {
        conn.execute(
            "INSERT OR IGNORE INTO channel_role_access (channel_id, role_id) VALUES (?1, ?2)",
            params![channel_id, rid],
        )?;
    }
    Ok(())
}

/// Decide whether the user can read / write this channel.
///
/// Order of fall-throughs (first match wins, no later check needed):
///   1. Team owner — always allowed.
///   2. Channel has no access rows — open.
///   3. Channel access list contains the team's default ("everyone") role
///      — every team member is allowed.
///   4. User has at least one role that's in the channel's access list.
pub fn user_can_access_channel(
    conn: &Connection,
    user_id: &str,
    team_id: &str,
    channel_id: &str,
) -> Result<bool, rusqlite::Error> {
    let is_owner: bool = conn
        .query_row(
            "SELECT created_by FROM teams WHERE id = ?1",
            params![team_id],
            |row| row.get::<_, String>(0),
        )
        .map(|owner| owner == user_id)
        .unwrap_or(false);
    if is_owner {
        return Ok(true);
    }

    let access_role_ids = get_channel_access_roles(conn, channel_id)?;
    if access_role_ids.is_empty() {
        return Ok(true);
    }

    let default_role_id: Option<String> = conn
        .query_row(
            "SELECT id FROM roles WHERE team_id = ?1 AND is_default = 1",
            params![team_id],
            |row| row.get::<_, String>(0),
        )
        .ok();

    if let Some(ref default_id) = default_role_id {
        if access_role_ids.iter().any(|r| r == default_id) {
            // Default-role gate: any team member is allowed.
            let is_member: bool = conn
                .query_row(
                    "SELECT 1 FROM members WHERE team_id = ?1 AND user_id = ?2",
                    params![team_id, user_id],
                    |_| Ok(true),
                )
                .unwrap_or(false);
            return Ok(is_member);
        }
    }

    // Otherwise the user needs at least one matching role assigned.
    let mut stmt = conn.prepare(
        "SELECT 1
         FROM members m
         JOIN member_roles mr ON mr.member_id = m.id
         WHERE m.team_id = ?1 AND m.user_id = ?2
           AND mr.role_id IN (
             SELECT role_id FROM channel_role_access WHERE channel_id = ?3
           )
         LIMIT 1",
    )?;
    let any = stmt.exists(params![team_id, user_id, channel_id])?;
    Ok(any)
}
