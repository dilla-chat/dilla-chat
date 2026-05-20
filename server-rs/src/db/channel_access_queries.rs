use rusqlite::{params, Connection};

/// Return the role IDs that gate access to this channel.
///
/// Pure-inheritance model: if the channel is in a group, the group's role
/// list is the source of truth and the channel's own list is ignored.
/// Without a group, fall back to the channel's own list. Empty list = no
/// gating (open to anyone in the team).
pub fn get_channel_access_roles(
    conn: &Connection,
    channel_id: &str,
) -> Result<Vec<String>, rusqlite::Error> {
    let group_id: Option<String> = conn
        .query_row(
            "SELECT group_id FROM channels WHERE id = ?1",
            params![channel_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .unwrap_or(None);
    if let Some(gid) = group_id {
        let mut stmt = conn.prepare(
            "SELECT role_id FROM channel_group_role_access WHERE group_id = ?1",
        )?;
        let rows = stmt.query_map(params![gid], |row| row.get::<_, String>(0))?;
        return rows.collect();
    }
    let mut stmt = conn.prepare(
        "SELECT role_id FROM channel_role_access WHERE channel_id = ?1",
    )?;
    let rows = stmt.query_map(params![channel_id], |row| row.get::<_, String>(0))?;
    rows.collect()
}

/// Role IDs that gate access to a channel group. Empty list = open.
pub fn get_group_access_roles(
    conn: &Connection,
    group_id: &str,
) -> Result<Vec<String>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT role_id FROM channel_group_role_access WHERE group_id = ?1",
    )?;
    let rows = stmt.query_map(params![group_id], |row| row.get::<_, String>(0))?;
    rows.collect()
}

/// Replace the role list that gates access to a channel group.
pub fn set_group_access_roles(
    conn: &Connection,
    group_id: &str,
    role_ids: &[String],
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM channel_group_role_access WHERE group_id = ?1",
        params![group_id],
    )?;
    for rid in role_ids {
        conn.execute(
            "INSERT OR IGNORE INTO channel_group_role_access (group_id, role_id) VALUES (?1, ?2)",
            params![group_id, rid],
        )?;
    }
    Ok(())
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
    // Same pure-inheritance switch as get_channel_access_roles: if the
    // channel has a group_id, the gate is the group's roles; otherwise
    // the channel's own roles.
    let group_id: Option<String> = conn
        .query_row(
            "SELECT group_id FROM channels WHERE id = ?1",
            params![channel_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .unwrap_or(None);
    let sql = if group_id.is_some() {
        "SELECT 1
         FROM members m
         JOIN member_roles mr ON mr.member_id = m.id
         WHERE m.team_id = ?1 AND m.user_id = ?2
           AND mr.role_id IN (
             SELECT role_id FROM channel_group_role_access
             WHERE group_id = (SELECT group_id FROM channels WHERE id = ?3)
           )
         LIMIT 1"
    } else {
        "SELECT 1
         FROM members m
         JOIN member_roles mr ON mr.member_id = m.id
         WHERE m.team_id = ?1 AND m.user_id = ?2
           AND mr.role_id IN (
             SELECT role_id FROM channel_role_access WHERE channel_id = ?3
           )
         LIMIT 1"
    };
    let mut stmt = conn.prepare(sql)?;
    let any = stmt.exists(params![team_id, user_id, channel_id])?;
    Ok(any)
}
