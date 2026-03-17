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
