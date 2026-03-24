use super::models::*;
use super::now_str;
use rusqlite::{params, Connection, OptionalExtension};

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
    let rows = stmt.query_map([team_id], row_to_channel)?;
    rows.collect()
}

pub fn get_channel_by_id(
    conn: &Connection,
    id: &str,
) -> Result<Option<Channel>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, team_id, name, topic, type, position, category, created_by, created_at, updated_at FROM channels WHERE id = ?1",
        [id],
        row_to_channel,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::*;

    #[test]
    fn test_create_channel_and_fetch_by_id() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();

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
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();

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
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();

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
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();
        let team = make_team("t1", "Team", "u1");
        db.with_conn(|c| crate::db::create_team(c, &team)).unwrap();

        let ch = make_channel("ch1", "t1", "general", "u1");
        db.with_conn(|c| create_channel(c, &ch)).unwrap();
        db.with_conn(|c| delete_channel(c, "ch1")).unwrap();

        let result = db.with_conn(|c| get_channel_by_id(c, "ch1")).unwrap();
        assert!(result.is_none());
    }
}
