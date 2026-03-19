use super::models::*;
use super::{new_id, now_str};
use rusqlite::{params, Connection, OptionalExtension};

// ── User queries ────────────────────────────────────────────────────────────

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
        |row| row_to_user(row),
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
        |row| row_to_user(row),
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
        |row| row_to_user(row),
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

// ── Team queries ────────────────────────────────────────────────────────────

pub fn create_team(conn: &Connection, team: &Team) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO teams (id, name, description, icon_url, created_by, max_file_size, allow_member_invites, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            team.id,
            team.name,
            team.description,
            team.icon_url,
            team.created_by,
            team.max_file_size,
            team.allow_member_invites as i32,
            team.created_at,
            team.updated_at,
        ],
    )?;
    Ok(())
}

pub fn get_team(conn: &Connection, id: &str) -> Result<Option<Team>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, name, description, icon_url, created_by, max_file_size, allow_member_invites, created_at, updated_at FROM teams WHERE id = ?1",
        [id],
        |row| row_to_team(row),
    )
    .optional()
}

pub fn get_first_team(conn: &Connection) -> Result<Option<Team>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, name, description, icon_url, created_by, max_file_size, allow_member_invites, created_at, updated_at FROM teams ORDER BY created_at ASC LIMIT 1",
        [],
        |row| row_to_team(row),
    )
    .optional()
}

pub fn get_teams_by_user(
    conn: &Connection,
    user_id: &str,
) -> Result<Vec<Team>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, t.description, t.icon_url, t.created_by, t.max_file_size, t.allow_member_invites, t.created_at, t.updated_at
         FROM teams t
         JOIN members m ON m.team_id = t.id
         WHERE m.user_id = ?1",
    )?;
    let rows = stmt.query_map([user_id], |row| row_to_team(row))?;
    rows.collect()
}

pub fn update_team(conn: &Connection, team: &Team) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE teams SET name = ?1, description = ?2, icon_url = ?3, max_file_size = ?4, allow_member_invites = ?5, updated_at = ?6 WHERE id = ?7",
        params![
            team.name,
            team.description,
            team.icon_url,
            team.max_file_size,
            team.allow_member_invites as i32,
            now_str(),
            team.id,
        ],
    )?;
    Ok(())
}

fn row_to_team(row: &rusqlite::Row) -> Result<Team, rusqlite::Error> {
    Ok(Team {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        icon_url: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        created_by: row.get(4)?,
        max_file_size: row.get(5)?,
        allow_member_invites: row.get::<_, i32>(6)? != 0,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

// ── Channel queries ─────────────────────────────────────────────────────────

pub fn create_channel(conn: &Connection, ch: &Channel) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO channels (id, team_id, name, topic, type, position, category, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            ch.id,
            ch.team_id,
            ch.name,
            ch.topic,
            ch.channel_type,
            ch.position,
            ch.category,
            ch.created_by,
            ch.created_at,
            ch.updated_at,
        ],
    )?;
    Ok(())
}

pub fn get_channels_by_team(
    conn: &Connection,
    team_id: &str,
) -> Result<Vec<Channel>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, team_id, name, topic, type, position, category, created_by, created_at, updated_at
         FROM channels WHERE team_id = ?1 ORDER BY position ASC, created_at ASC",
    )?;
    let rows = stmt.query_map([team_id], |row| row_to_channel(row))?;
    rows.collect()
}

pub fn get_channel_by_id(
    conn: &Connection,
    id: &str,
) -> Result<Option<Channel>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, team_id, name, topic, type, position, category, created_by, created_at, updated_at FROM channels WHERE id = ?1",
        [id],
        |row| row_to_channel(row),
    )
    .optional()
}

pub fn update_channel(conn: &Connection, ch: &Channel) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE channels SET name = ?1, topic = ?2, position = ?3, category = ?4, updated_at = ?5 WHERE id = ?6",
        params![ch.name, ch.topic, ch.position, ch.category, now_str(), ch.id],
    )?;
    Ok(())
}

pub fn delete_channel(conn: &Connection, id: &str) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM channels WHERE id = ?1", [id])?;
    Ok(())
}

fn row_to_channel(row: &rusqlite::Row) -> Result<Channel, rusqlite::Error> {
    Ok(Channel {
        id: row.get(0)?,
        team_id: row.get(1)?,
        name: row.get(2)?,
        topic: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        channel_type: row.get(4)?,
        position: row.get(5)?,
        category: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
        created_by: row.get::<_, Option<String>>(7)?.unwrap_or_default(),
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

// ── Member queries ──────────────────────────────────────────────────────────

pub fn create_member(conn: &Connection, member: &Member) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO members (id, team_id, user_id, nickname, joined_at, invited_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            member.id,
            member.team_id,
            member.user_id,
            member.nickname,
            member.joined_at,
            member.invited_by,
        ],
    )?;
    Ok(())
}

pub fn get_members_by_team(
    conn: &Connection,
    team_id: &str,
) -> Result<Vec<(Member, User)>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT m.id, m.team_id, m.user_id, m.nickname, m.joined_at, m.invited_by,
                u.id, u.username, u.display_name, u.public_key, u.avatar_url, u.status_text, u.status_type, u.is_admin, u.created_at, u.updated_at
         FROM members m
         JOIN users u ON u.id = m.user_id
         WHERE m.team_id = ?1",
    )?;
    let rows = stmt.query_map([team_id], |row| {
        let member = Member {
            id: row.get(0)?,
            team_id: row.get(1)?,
            user_id: row.get(2)?,
            nickname: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            joined_at: row.get(4)?,
            invited_by: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
        };
        let user = User {
            id: row.get(6)?,
            username: row.get(7)?,
            display_name: row.get(8)?,
            public_key: row.get(9)?,
            avatar_url: row.get::<_, Option<String>>(10)?.unwrap_or_default(),
            status_text: row.get::<_, Option<String>>(11)?.unwrap_or_default(),
            status_type: row.get::<_, Option<String>>(12)?.unwrap_or("online".into()),
            is_admin: row.get::<_, i32>(13)? != 0,
            created_at: row.get(14)?,
            updated_at: row.get(15)?,
        };
        Ok((member, user))
    })?;
    rows.collect()
}

pub fn get_member_by_user_and_team(
    conn: &Connection,
    user_id: &str,
    team_id: &str,
) -> Result<Option<Member>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, team_id, user_id, nickname, joined_at, invited_by FROM members WHERE user_id = ?1 AND team_id = ?2",
        params![user_id, team_id],
        |row| {
            Ok(Member {
                id: row.get(0)?,
                team_id: row.get(1)?,
                user_id: row.get(2)?,
                nickname: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                joined_at: row.get(4)?,
                invited_by: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
            })
        },
    )
    .optional()
}

pub fn update_member(conn: &Connection, member: &Member) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE members SET nickname = ?1 WHERE id = ?2",
        params![member.nickname, member.id],
    )?;
    Ok(())
}

pub fn delete_member(
    conn: &Connection,
    user_id: &str,
    team_id: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM members WHERE user_id = ?1 AND team_id = ?2",
        params![user_id, team_id],
    )?;
    Ok(())
}

// ── Message queries ─────────────────────────────────────────────────────────

pub fn create_message(conn: &Connection, msg: &Message) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO messages (id, channel_id, dm_channel_id, author_id, content, type, thread_id, lamport_ts, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            msg.id,
            msg.channel_id,
            if msg.dm_channel_id.is_empty() { None } else { Some(&msg.dm_channel_id) },
            msg.author_id,
            msg.content,
            msg.msg_type,
            if msg.thread_id.is_empty() { None } else { Some(&msg.thread_id) },
            msg.lamport_ts,
            msg.created_at,
        ],
    )?;
    Ok(())
}

pub fn get_message_by_id(
    conn: &Connection,
    id: &str,
) -> Result<Option<Message>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, channel_id, dm_channel_id, author_id, content, type, thread_id, edited_at, deleted, lamport_ts, created_at
         FROM messages WHERE id = ?1",
        [id],
        |row| row_to_message(row),
    )
    .optional()
}

pub fn get_messages_by_channel(
    conn: &Connection,
    channel_id: &str,
    before: &str,
    limit: i32,
) -> Result<Vec<Message>, rusqlite::Error> {
    let mut messages = if before.is_empty() {
        let mut stmt = conn.prepare(
            "SELECT id, channel_id, dm_channel_id, author_id, content, type, thread_id, edited_at, deleted, lamport_ts, created_at
             FROM messages WHERE channel_id = ?1 AND (thread_id IS NULL OR thread_id = '')
             ORDER BY created_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![channel_id, limit], |row| row_to_message(row))?;
        rows.collect::<Result<Vec<_>, _>>()?
    } else {
        let mut stmt = conn.prepare(
            "SELECT id, channel_id, dm_channel_id, author_id, content, type, thread_id, edited_at, deleted, lamport_ts, created_at
             FROM messages WHERE channel_id = ?1 AND (thread_id IS NULL OR thread_id = '') AND created_at < ?2
             ORDER BY created_at DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![channel_id, before, limit], |row| {
            row_to_message(row)
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    messages.reverse();
    Ok(messages)
}

pub fn update_message_content(
    conn: &Connection,
    id: &str,
    content: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE messages SET content = ?1, edited_at = ?2 WHERE id = ?3",
        params![content, now_str(), id],
    )?;
    Ok(())
}

pub fn soft_delete_message(conn: &Connection, id: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE messages SET deleted = 1, content = '' WHERE id = ?1",
        [id],
    )?;
    Ok(())
}

fn row_to_message(row: &rusqlite::Row) -> Result<Message, rusqlite::Error> {
    Ok(Message {
        id: row.get(0)?,
        channel_id: row.get(1)?,
        dm_channel_id: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        author_id: row.get(3)?,
        content: row.get(4)?,
        msg_type: row.get(5)?,
        thread_id: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
        edited_at: row.get(7)?,
        deleted: row.get::<_, i32>(8)? != 0,
        lamport_ts: row.get(9)?,
        created_at: row.get(10)?,
    })
}

// ── Role queries ────────────────────────────────────────────────────────────

pub fn create_role(conn: &Connection, role: &Role) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO roles (id, team_id, name, color, position, permissions, is_default, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            role.id,
            role.team_id,
            role.name,
            role.color,
            role.position,
            role.permissions,
            role.is_default as i32,
            role.created_at,
        ],
    )?;
    Ok(())
}

pub fn get_roles_by_team(
    conn: &Connection,
    team_id: &str,
) -> Result<Vec<Role>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, team_id, name, color, position, permissions, is_default, created_at
         FROM roles WHERE team_id = ?1 ORDER BY position ASC",
    )?;
    let rows = stmt.query_map([team_id], |row| row_to_role(row))?;
    rows.collect()
}

pub fn get_role_by_id(conn: &Connection, id: &str) -> Result<Option<Role>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, team_id, name, color, position, permissions, is_default, created_at FROM roles WHERE id = ?1",
        [id],
        |row| row_to_role(row),
    )
    .optional()
}

pub fn update_role(conn: &Connection, role: &Role) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE roles SET name = ?1, color = ?2, position = ?3, permissions = ?4 WHERE id = ?5",
        params![role.name, role.color, role.position, role.permissions, role.id],
    )?;
    Ok(())
}

pub fn delete_role(conn: &Connection, id: &str) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM member_roles WHERE role_id = ?1", [id])?;
    conn.execute("DELETE FROM roles WHERE id = ?1", [id])?;
    Ok(())
}

pub fn get_default_role_for_team(
    conn: &Connection,
    team_id: &str,
) -> Result<Option<Role>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, team_id, name, color, position, permissions, is_default, created_at FROM roles WHERE team_id = ?1 AND is_default = 1",
        [team_id],
        |row| row_to_role(row),
    )
    .optional()
}

fn row_to_role(row: &rusqlite::Row) -> Result<Role, rusqlite::Error> {
    Ok(Role {
        id: row.get(0)?,
        team_id: row.get(1)?,
        name: row.get(2)?,
        color: row.get::<_, Option<String>>(3)?.unwrap_or("#99AAB5".into()),
        position: row.get(4)?,
        permissions: row.get(5)?,
        is_default: row.get::<_, i32>(6)? != 0,
        created_at: row.get(7)?,
    })
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
        "SELECT r.id, r.team_id, r.name, r.color, r.position, r.permissions, r.is_default, r.created_at
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
    use crate::db::Database;

    /// Create a fresh database for each test using a temp directory.
    /// Foreign key enforcement is disabled to match production behavior
    /// where the codebase uses empty strings for optional FK columns.
    fn test_db() -> Database {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
        db.run_migrations().unwrap();
        db
    }

    fn make_user(id: &str, username: &str, public_key: &[u8]) -> User {
        let now = crate::db::now_str();
        User {
            id: id.to_string(),
            username: username.to_string(),
            display_name: username.to_string(),
            public_key: public_key.to_vec(),
            avatar_url: String::new(),
            status_text: String::new(),
            status_type: "online".to_string(),
            is_admin: false,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    fn make_team(id: &str, name: &str, created_by: &str) -> Team {
        let now = crate::db::now_str();
        Team {
            id: id.to_string(),
            name: name.to_string(),
            description: String::new(),
            icon_url: String::new(),
            created_by: created_by.to_string(),
            max_file_size: 10485760,
            allow_member_invites: true,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    fn make_channel(id: &str, team_id: &str, name: &str, created_by: &str) -> Channel {
        let now = crate::db::now_str();
        Channel {
            id: id.to_string(),
            team_id: team_id.to_string(),
            name: name.to_string(),
            topic: String::new(),
            channel_type: "text".to_string(),
            position: 0,
            category: String::new(),
            created_by: created_by.to_string(),
            created_at: now.clone(),
            updated_at: now,
        }
    }

    fn make_message(id: &str, channel_id: &str, author_id: &str, content: &str) -> Message {
        let now = crate::db::now_str();
        Message {
            id: id.to_string(),
            channel_id: channel_id.to_string(),
            dm_channel_id: String::new(),
            author_id: author_id.to_string(),
            content: content.to_string(),
            msg_type: "text".to_string(),
            thread_id: String::new(),
            edited_at: None,
            deleted: false,
            lamport_ts: 0,
            created_at: now,
        }
    }

    fn make_member(id: &str, team_id: &str, user_id: &str) -> Member {
        let now = crate::db::now_str();
        Member {
            id: id.to_string(),
            team_id: team_id.to_string(),
            user_id: user_id.to_string(),
            nickname: String::new(),
            joined_at: now,
            invited_by: user_id.to_string(),
        }
    }

    // ── User tests ──────────────────────────────────────────────────────

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

    // ── Team tests ──────────────────────────────────────────────────────

    #[test]
    fn test_create_team_and_fetch() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();

        let team = make_team("t1", "Test Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

        let fetched = db.with_conn(|c| get_team(c, "t1")).unwrap().unwrap();
        assert_eq!(fetched.name, "Test Team");
        assert_eq!(fetched.created_by, "u1");
    }

    #[test]
    fn test_get_nonexistent_team_returns_none() {
        let db = test_db();
        let result = db.with_conn(|c| get_team(c, "nope")).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_update_team() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();

        let mut team = make_team("t1", "Original", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

        team.name = "Updated Name".to_string();
        team.description = "A description".to_string();
        team.allow_member_invites = false;
        db.with_conn(|c| update_team(c, &team)).unwrap();

        let fetched = db.with_conn(|c| get_team(c, "t1")).unwrap().unwrap();
        assert_eq!(fetched.name, "Updated Name");
        assert_eq!(fetched.description, "A description");
        assert!(!fetched.allow_member_invites);
    }

    #[test]
    fn test_get_first_team() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();

        let result = db.with_conn(|c| get_first_team(c)).unwrap();
        assert!(result.is_none());

        let team = make_team("t1", "First", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

        let fetched = db.with_conn(|c| get_first_team(c)).unwrap().unwrap();
        assert_eq!(fetched.id, "t1");
    }

    #[test]
    fn test_get_teams_by_user() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();

        let team = make_team("t1", "Team One", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

        let member = make_member("m1", "t1", "u1");
        db.with_conn(|c| create_member(c, &member)).unwrap();

        let teams = db.with_conn(|c| get_teams_by_user(c, "u1")).unwrap();
        assert_eq!(teams.len(), 1);
        assert_eq!(teams[0].name, "Team One");

        let user2 = make_user("u2", "loner", &[2u8; 32]);
        db.with_conn(|c| create_user(c, &user2)).unwrap();
        let teams2 = db.with_conn(|c| get_teams_by_user(c, "u2")).unwrap();
        assert!(teams2.is_empty());
    }

    // ── Channel tests ───────────────────────────────────────────────────

    #[test]
    fn test_create_channel_and_fetch_by_id() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

        let ch = make_channel("ch1", "t1", "general", "u1");
        db.with_conn(|c| create_channel(c, &ch)).unwrap();

        let fetched = db.with_conn(|c| get_channel_by_id(c, "ch1")).unwrap().unwrap();
        assert_eq!(fetched.name, "general");
        assert_eq!(fetched.team_id, "t1");
    }

    #[test]
    fn test_get_channels_by_team_ordered() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

        let ch1 = Channel { position: 1, ..make_channel("ch1", "t1", "general", "u1") };
        let ch2 = Channel { position: 0, ..make_channel("ch2", "t1", "random", "u1") };
        db.with_conn(|c| create_channel(c, &ch1)).unwrap();
        db.with_conn(|c| create_channel(c, &ch2)).unwrap();

        let channels = db.with_conn(|c| get_channels_by_team(c, "t1")).unwrap();
        assert_eq!(channels.len(), 2);
        assert_eq!(channels[0].name, "random");
        assert_eq!(channels[1].name, "general");
    }

    #[test]
    fn test_update_channel() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

        let mut ch = make_channel("ch1", "t1", "general", "u1");
        db.with_conn(|c| create_channel(c, &ch)).unwrap();

        ch.name = "announcements".to_string();
        ch.topic = "Important stuff".to_string();
        db.with_conn(|c| update_channel(c, &ch)).unwrap();

        let fetched = db.with_conn(|c| get_channel_by_id(c, "ch1")).unwrap().unwrap();
        assert_eq!(fetched.name, "announcements");
        assert_eq!(fetched.topic, "Important stuff");
    }

    #[test]
    fn test_delete_channel() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

        let ch = make_channel("ch1", "t1", "general", "u1");
        db.with_conn(|c| create_channel(c, &ch)).unwrap();
        db.with_conn(|c| delete_channel(c, "ch1")).unwrap();

        let result = db.with_conn(|c| get_channel_by_id(c, "ch1")).unwrap();
        assert!(result.is_none());
    }

    // ── Message tests ───────────────────────────────────────────────────

    #[test]
    fn test_create_message_and_fetch_by_id() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();
        let ch = make_channel("ch1", "t1", "general", "u1");
        db.with_conn(|c| create_channel(c, &ch)).unwrap();

        let msg = make_message("m1", "ch1", "u1", "Hello world");
        db.with_conn(|c| create_message(c, &msg)).unwrap();

        let fetched = db.with_conn(|c| get_message_by_id(c, "m1")).unwrap().unwrap();
        assert_eq!(fetched.content, "Hello world");
        assert_eq!(fetched.author_id, "u1");
        assert!(!fetched.deleted);
    }

    #[test]
    fn test_get_messages_by_channel_ordering() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();
        let ch = make_channel("ch1", "t1", "general", "u1");
        db.with_conn(|c| create_channel(c, &ch)).unwrap();

        for i in 0..5 {
            let msg = Message {
                created_at: format!("2024-01-01 00:00:0{}", i),
                ..make_message(&format!("m{}", i), "ch1", "u1", &format!("msg {}", i))
            };
            db.with_conn(|c| create_message(c, &msg)).unwrap();
        }

        let messages = db.with_conn(|c| get_messages_by_channel(c, "ch1", "", 50)).unwrap();
        assert_eq!(messages.len(), 5);
        assert_eq!(messages[0].content, "msg 0");
        assert_eq!(messages[4].content, "msg 4");
    }

    #[test]
    fn test_get_messages_by_channel_pagination() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();
        let ch = make_channel("ch1", "t1", "general", "u1");
        db.with_conn(|c| create_channel(c, &ch)).unwrap();

        for i in 0..5 {
            let msg = Message {
                created_at: format!("2024-01-01 00:00:0{}", i),
                ..make_message(&format!("m{}", i), "ch1", "u1", &format!("msg {}", i))
            };
            db.with_conn(|c| create_message(c, &msg)).unwrap();
        }

        let messages = db.with_conn(|c| get_messages_by_channel(c, "ch1", "", 2)).unwrap();
        assert_eq!(messages.len(), 2);

        let messages = db.with_conn(|c| get_messages_by_channel(c, "ch1", "2024-01-01 00:00:03", 10)).unwrap();
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[2].content, "msg 2");
    }

    #[test]
    fn test_update_message_content() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();
        let ch = make_channel("ch1", "t1", "general", "u1");
        db.with_conn(|c| create_channel(c, &ch)).unwrap();

        let msg = make_message("m1", "ch1", "u1", "original");
        db.with_conn(|c| create_message(c, &msg)).unwrap();

        db.with_conn(|c| update_message_content(c, "m1", "edited")).unwrap();

        let fetched = db.with_conn(|c| get_message_by_id(c, "m1")).unwrap().unwrap();
        assert_eq!(fetched.content, "edited");
        assert!(fetched.edited_at.is_some());
    }

    #[test]
    fn test_soft_delete_message() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();
        let ch = make_channel("ch1", "t1", "general", "u1");
        db.with_conn(|c| create_channel(c, &ch)).unwrap();

        let msg = make_message("m1", "ch1", "u1", "secret");
        db.with_conn(|c| create_message(c, &msg)).unwrap();

        db.with_conn(|c| soft_delete_message(c, "m1")).unwrap();

        let fetched = db.with_conn(|c| get_message_by_id(c, "m1")).unwrap().unwrap();
        assert!(fetched.deleted);
        assert_eq!(fetched.content, "");
    }

    // ── Member tests ────────────────────────────────────────────────────

    #[test]
    fn test_create_member_and_fetch() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

        let member = make_member("m1", "t1", "u1");
        db.with_conn(|c| create_member(c, &member)).unwrap();

        let fetched = db
            .with_conn(|c| get_member_by_user_and_team(c, "u1", "t1"))
            .unwrap()
            .unwrap();
        assert_eq!(fetched.id, "m1");
        assert_eq!(fetched.user_id, "u1");
    }

    #[test]
    fn test_get_members_by_team() {
        let db = test_db();
        let u1 = make_user("u1", "alice", &[1u8; 32]);
        let u2 = make_user("u2", "bob", &[2u8; 32]);
        db.with_conn(|c| create_user(c, &u1)).unwrap();
        db.with_conn(|c| create_user(c, &u2)).unwrap();

        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

        let m1 = make_member("m1", "t1", "u1");
        let m2 = make_member("m2", "t1", "u2");
        db.with_conn(|c| create_member(c, &m1)).unwrap();
        db.with_conn(|c| create_member(c, &m2)).unwrap();

        let members = db.with_conn(|c| get_members_by_team(c, "t1")).unwrap();
        assert_eq!(members.len(), 2);
    }

    #[test]
    fn test_update_member_nickname() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

        let mut member = make_member("m1", "t1", "u1");
        db.with_conn(|c| create_member(c, &member)).unwrap();

        member.nickname = "Cool Nick".to_string();
        db.with_conn(|c| update_member(c, &member)).unwrap();

        let fetched = db
            .with_conn(|c| get_member_by_user_and_team(c, "u1", "t1"))
            .unwrap()
            .unwrap();
        assert_eq!(fetched.nickname, "Cool Nick");
    }

    #[test]
    fn test_delete_member() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

        let member = make_member("m1", "t1", "u1");
        db.with_conn(|c| create_member(c, &member)).unwrap();

        db.with_conn(|c| delete_member(c, "u1", "t1")).unwrap();

        let fetched = db.with_conn(|c| get_member_by_user_and_team(c, "u1", "t1")).unwrap();
        assert!(fetched.is_none());
    }

    // ── Role tests ──────────────────────────────────────────────────────

    #[test]
    fn test_create_role_and_fetch() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

        let role = Role {
            id: "r1".to_string(),
            team_id: "t1".to_string(),
            name: "Moderator".to_string(),
            color: "#FF0000".to_string(),
            position: 1,
            permissions: PERM_MANAGE_MESSAGES | PERM_MANAGE_MEMBERS,
            is_default: false,
            created_at: crate::db::now_str(),
        };
        db.with_conn(|c| create_role(c, &role)).unwrap();

        let fetched = db.with_conn(|c| get_role_by_id(c, "r1")).unwrap().unwrap();
        assert_eq!(fetched.name, "Moderator");
        assert_eq!(fetched.color, "#FF0000");
        assert_eq!(fetched.permissions, PERM_MANAGE_MESSAGES | PERM_MANAGE_MEMBERS);
    }

    #[test]
    fn test_get_roles_by_team_ordered_by_position() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

        let now = crate::db::now_str();
        let r1 = Role {
            id: "r1".into(), team_id: "t1".into(), name: "Admin".into(),
            color: "#FF0000".into(), position: 2, permissions: PERM_ADMIN,
            is_default: false, created_at: now.clone(),
        };
        let r2 = Role {
            id: "r2".into(), team_id: "t1".into(), name: "Member".into(),
            color: "#00FF00".into(), position: 0, permissions: PERM_SEND_MESSAGES,
            is_default: true, created_at: now,
        };
        db.with_conn(|c| create_role(c, &r1)).unwrap();
        db.with_conn(|c| create_role(c, &r2)).unwrap();

        let roles = db.with_conn(|c| get_roles_by_team(c, "t1")).unwrap();
        assert_eq!(roles.len(), 2);
        assert_eq!(roles[0].name, "Member");
        assert_eq!(roles[1].name, "Admin");
    }

    #[test]
    fn test_update_role() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

        let mut role = Role {
            id: "r1".into(), team_id: "t1".into(), name: "Mod".into(),
            color: "#000".into(), position: 0, permissions: 0,
            is_default: false, created_at: crate::db::now_str(),
        };
        db.with_conn(|c| create_role(c, &role)).unwrap();

        role.name = "Super Mod".to_string();
        role.permissions = PERM_ADMIN;
        db.with_conn(|c| update_role(c, &role)).unwrap();

        let fetched = db.with_conn(|c| get_role_by_id(c, "r1")).unwrap().unwrap();
        assert_eq!(fetched.name, "Super Mod");
        assert_eq!(fetched.permissions, PERM_ADMIN);
    }

    #[test]
    fn test_delete_role() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

        let role = Role {
            id: "r1".into(), team_id: "t1".into(), name: "Temp".into(),
            color: "#000".into(), position: 0, permissions: 0,
            is_default: false, created_at: crate::db::now_str(),
        };
        db.with_conn(|c| create_role(c, &role)).unwrap();
        db.with_conn(|c| delete_role(c, "r1")).unwrap();

        let fetched = db.with_conn(|c| get_role_by_id(c, "r1")).unwrap();
        assert!(fetched.is_none());
    }

    #[test]
    fn test_get_default_role_for_team() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

        let role = Role {
            id: "r1".into(), team_id: "t1".into(), name: "everyone".into(),
            color: "#000".into(), position: 0, permissions: PERM_SEND_MESSAGES,
            is_default: true, created_at: crate::db::now_str(),
        };
        db.with_conn(|c| create_role(c, &role)).unwrap();

        let def = db.with_conn(|c| get_default_role_for_team(c, "t1")).unwrap().unwrap();
        assert_eq!(def.name, "everyone");
        assert!(def.is_default);
    }

    // ── Member role assignment tests ────────────────────────────────────

    #[test]
    fn test_assign_and_get_member_roles() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();
        let member = make_member("m1", "t1", "u1");
        db.with_conn(|c| create_member(c, &member)).unwrap();

        let now = crate::db::now_str();
        let r1 = Role {
            id: "r1".into(), team_id: "t1".into(), name: "Mod".into(),
            color: "#000".into(), position: 0, permissions: PERM_MANAGE_MESSAGES,
            is_default: false, created_at: now.clone(),
        };
        let r2 = Role {
            id: "r2".into(), team_id: "t1".into(), name: "Admin".into(),
            color: "#000".into(), position: 1, permissions: PERM_ADMIN,
            is_default: false, created_at: now,
        };
        db.with_conn(|c| create_role(c, &r1)).unwrap();
        db.with_conn(|c| create_role(c, &r2)).unwrap();

        db.with_conn(|c| assign_role_to_member(c, "m1", "r1")).unwrap();
        db.with_conn(|c| assign_role_to_member(c, "m1", "r2")).unwrap();

        let roles = db.with_conn(|c| get_member_roles(c, "m1")).unwrap();
        assert_eq!(roles.len(), 2);
    }

    #[test]
    fn test_assign_role_idempotent() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();
        let member = make_member("m1", "t1", "u1");
        db.with_conn(|c| create_member(c, &member)).unwrap();

        let role = Role {
            id: "r1".into(), team_id: "t1".into(), name: "Mod".into(),
            color: "#000".into(), position: 0, permissions: 0,
            is_default: false, created_at: crate::db::now_str(),
        };
        db.with_conn(|c| create_role(c, &role)).unwrap();

        db.with_conn(|c| assign_role_to_member(c, "m1", "r1")).unwrap();
        db.with_conn(|c| assign_role_to_member(c, "m1", "r1")).unwrap();

        let roles = db.with_conn(|c| get_member_roles(c, "m1")).unwrap();
        assert_eq!(roles.len(), 1);
    }

    #[test]
    fn test_remove_role_from_member() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();
        let member = make_member("m1", "t1", "u1");
        db.with_conn(|c| create_member(c, &member)).unwrap();

        let role = Role {
            id: "r1".into(), team_id: "t1".into(), name: "Mod".into(),
            color: "#000".into(), position: 0, permissions: 0,
            is_default: false, created_at: crate::db::now_str(),
        };
        db.with_conn(|c| create_role(c, &role)).unwrap();

        db.with_conn(|c| assign_role_to_member(c, "m1", "r1")).unwrap();
        db.with_conn(|c| remove_role_from_member(c, "m1", "r1")).unwrap();

        let roles = db.with_conn(|c| get_member_roles(c, "m1")).unwrap();
        assert!(roles.is_empty());
    }

    #[test]
    fn test_clear_member_roles() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();
        let member = make_member("m1", "t1", "u1");
        db.with_conn(|c| create_member(c, &member)).unwrap();

        let now = crate::db::now_str();
        for i in 0..3 {
            let role = Role {
                id: format!("r{}", i), team_id: "t1".into(), name: format!("Role{}", i),
                color: "#000".into(), position: i, permissions: 0,
                is_default: false, created_at: now.clone(),
            };
            db.with_conn(|c| create_role(c, &role)).unwrap();
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
        db.with_conn(|c| create_user(c, &user)).unwrap();

        let user2 = make_user("u2", "creator", &[2u8; 32]);
        db.with_conn(|c| create_user(c, &user2)).unwrap();
        let team = make_team("t1", "Team", "u2");
        db.with_conn(|c| create_team(c, &team)).unwrap();

        let has = db.with_conn(|c| user_has_permission(c, "u1", "t1", PERM_MANAGE_CHANNELS)).unwrap();
        assert!(has);
    }

    #[test]
    fn test_user_has_permission_team_owner() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

        let has = db.with_conn(|c| user_has_permission(c, "u1", "t1", PERM_MANAGE_ROLES)).unwrap();
        assert!(has);
    }

    #[test]
    fn test_user_has_permission_via_role() {
        let db = test_db();
        let owner = make_user("u1", "owner", &[1u8; 32]);
        let user = make_user("u2", "member", &[2u8; 32]);
        db.with_conn(|c| create_user(c, &owner)).unwrap();
        db.with_conn(|c| create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

        let member = make_member("m2", "t1", "u2");
        db.with_conn(|c| create_member(c, &member)).unwrap();

        let role = Role {
            id: "r1".into(), team_id: "t1".into(), name: "Mod".into(),
            color: "#000".into(), position: 0, permissions: PERM_MANAGE_MESSAGES,
            is_default: false, created_at: crate::db::now_str(),
        };
        db.with_conn(|c| create_role(c, &role)).unwrap();
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
        db.with_conn(|c| create_user(c, &owner)).unwrap();
        db.with_conn(|c| create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

        let member = make_member("m2", "t1", "u2");
        db.with_conn(|c| create_member(c, &member)).unwrap();

        let role = Role {
            id: "r1".into(), team_id: "t1".into(), name: "Admin Role".into(),
            color: "#000".into(), position: 0, permissions: PERM_ADMIN,
            is_default: false, created_at: crate::db::now_str(),
        };
        db.with_conn(|c| create_role(c, &role)).unwrap();
        db.with_conn(|c| assign_role_to_member(c, "m2", "r1")).unwrap();

        let has = db.with_conn(|c| user_has_permission(c, "u2", "t1", PERM_MANAGE_TEAM)).unwrap();
        assert!(has);
    }

    #[test]
    fn test_user_has_no_permission_without_role() {
        let db = test_db();
        let owner = make_user("u1", "owner", &[1u8; 32]);
        let user = make_user("u2", "member", &[2u8; 32]);
        db.with_conn(|c| create_user(c, &owner)).unwrap();
        db.with_conn(|c| create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

        let member = make_member("m2", "t1", "u2");
        db.with_conn(|c| create_member(c, &member)).unwrap();

        let has = db.with_conn(|c| user_has_permission(c, "u2", "t1", PERM_SEND_MESSAGES)).unwrap();
        assert!(!has);
    }

    // ── Invite tests ────────────────────────────────────────────────────

    #[test]
    fn test_create_invite_and_fetch_by_token() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

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
        db.with_conn(|c| create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

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
        db.with_conn(|c| create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

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
        db.with_conn(|c| create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

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
        db.with_conn(|c| create_user(c, &owner)).unwrap();
        db.with_conn(|c| create_user(c, &target)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

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
        db.with_conn(|c| create_user(c, &owner)).unwrap();
        db.with_conn(|c| create_user(c, &target)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

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
        db.with_conn(|c| create_user(c, &owner)).unwrap();
        db.with_conn(|c| create_user(c, &u2)).unwrap();
        db.with_conn(|c| create_user(c, &u3)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| create_team(c, &team)).unwrap();

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
        db.with_conn(|c| create_user(c, &user)).unwrap();

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
        db.with_conn(|c| create_user(c, &user)).unwrap();

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
        db.with_conn(|c| create_user(c, &user)).unwrap();

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
