use super::models::*;
use super::now_str;
use rusqlite::{params, Connection, OptionalExtension};

pub fn create_member(conn: &Connection, member: &Member) -> Result<(), rusqlite::Error> {
    let updated = if member.updated_at.is_empty() {
        member.joined_at.clone()
    } else {
        member.updated_at.clone()
    };
    conn.execute(
        "INSERT INTO members (id, team_id, user_id, nickname, joined_at, invited_by, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            member.id,
            member.team_id,
            member.user_id,
            member.nickname,
            member.joined_at,
            member.invited_by,
            updated,
        ],
    )?;
    Ok(())
}

pub fn get_members_by_team(
    conn: &Connection,
    team_id: &str,
) -> Result<Vec<(Member, User)>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT m.id, m.team_id, m.user_id, m.nickname, m.joined_at, m.invited_by, m.updated_at,
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
            updated_at: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
        };
        let user = User {
            id: row.get(7)?,
            username: row.get(8)?,
            display_name: row.get(9)?,
            public_key: row.get(10)?,
            avatar_url: row.get::<_, Option<String>>(11)?.unwrap_or_default(),
            status_text: row.get::<_, Option<String>>(12)?.unwrap_or_default(),
            status_type: row.get::<_, Option<String>>(13)?.unwrap_or("online".into()),
            is_admin: row.get::<_, i32>(14)? != 0,
            created_at: row.get(15)?,
            updated_at: row.get(16)?,
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
        "SELECT id, team_id, user_id, nickname, joined_at, invited_by, updated_at FROM members WHERE user_id = ?1 AND team_id = ?2",
        params![user_id, team_id],
        |row| {
            Ok(Member {
                id: row.get(0)?,
                team_id: row.get(1)?,
                user_id: row.get(2)?,
                nickname: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                joined_at: row.get(4)?,
                invited_by: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                updated_at: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
            })
        },
    )
    .optional()
}

pub fn update_member(conn: &Connection, member: &Member) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE members SET nickname = ?1, updated_at = ?2 WHERE id = ?3",
        params![member.nickname, now_str(), member.id],
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::*;

    #[test]
    fn test_create_member_and_fetch() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();

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
        db.with_conn(|c| crate::db::create_user(c, &u1)).unwrap();
        db.with_conn(|c| crate::db::create_user(c, &u2)).unwrap();

        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();

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
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();

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
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();

        let member = make_member("m1", "t1", "u1");
        db.with_conn(|c| create_member(c, &member)).unwrap();

        db.with_conn(|c| delete_member(c, "u1", "t1")).unwrap();

        let fetched = db.with_conn(|c| get_member_by_user_and_team(c, "u1", "t1")).unwrap();
        assert!(fetched.is_none());
    }
}
