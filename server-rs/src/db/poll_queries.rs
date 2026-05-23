use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Poll {
    pub id: String,
    pub team_id: String,
    pub channel_id: String,
    pub question: String,
    /// JSON array of option labels (`["yes","no"]`).
    pub options: String,
    pub created_by: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PollVote {
    pub poll_id: String,
    pub user_id: String,
    pub option_index: i64,
    pub voted_at: String,
}

pub fn create_poll(conn: &Connection, poll: &Poll) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO polls (id, team_id, channel_id, question, options, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            poll.id,
            poll.team_id,
            poll.channel_id,
            poll.question,
            poll.options,
            poll.created_by,
            poll.created_at,
        ],
    )?;
    Ok(())
}

pub fn get_poll_by_id(conn: &Connection, id: &str) -> Result<Option<Poll>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, team_id, channel_id, question, options, created_by, created_at
         FROM polls WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], row_to_poll)?;
    match rows.next() {
        Some(r) => Ok(Some(r?)),
        None => Ok(None),
    }
}

pub fn get_polls_by_channel(
    conn: &Connection,
    channel_id: &str,
) -> Result<Vec<Poll>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, team_id, channel_id, question, options, created_by, created_at
         FROM polls WHERE channel_id = ?1 ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map(params![channel_id], row_to_poll)?;
    rows.collect()
}

pub fn get_votes_for_poll(
    conn: &Connection,
    poll_id: &str,
) -> Result<Vec<PollVote>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT poll_id, user_id, option_index, voted_at
         FROM poll_votes WHERE poll_id = ?1",
    )?;
    let rows = stmt.query_map(params![poll_id], |row| {
        Ok(PollVote {
            poll_id: row.get(0)?,
            user_id: row.get(1)?,
            option_index: row.get(2)?,
            voted_at: row.get(3)?,
        })
    })?;
    rows.collect()
}

pub fn upsert_poll_vote(
    conn: &Connection,
    poll_id: &str,
    user_id: &str,
    option_index: i64,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO poll_votes (poll_id, user_id, option_index, voted_at)
         VALUES (?1, ?2, ?3, datetime('now'))
         ON CONFLICT(poll_id, user_id) DO UPDATE SET option_index = excluded.option_index, voted_at = excluded.voted_at",
        params![poll_id, user_id, option_index],
    )?;
    Ok(())
}

pub fn clear_poll_vote(
    conn: &Connection,
    poll_id: &str,
    user_id: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM poll_votes WHERE poll_id = ?1 AND user_id = ?2",
        params![poll_id, user_id],
    )?;
    Ok(())
}

fn row_to_poll(row: &rusqlite::Row) -> Result<Poll, rusqlite::Error> {
    Ok(Poll {
        id: row.get(0)?,
        team_id: row.get(1)?,
        channel_id: row.get(2)?,
        question: row.get(3)?,
        options: row.get(4)?,
        created_by: row.get::<_, Option<String>>(5)?,
        created_at: row.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::*;

    fn seed(db: &crate::db::Database) {
        db.with_conn(|c| crate::db::create_user(c, &make_user("u1", "alice", &[1u8; 32]))).unwrap();
        db.with_conn(|c| crate::db::create_team(c, &make_team("t1", "Team", "u1"))).unwrap();
        db.with_conn(|c| crate::db::create_channel(c, &make_channel("c1", "t1", "general", "u1"))).unwrap();
    }

    fn poll(id: &str) -> Poll {
        Poll {
            id: id.into(),
            team_id: "t1".into(),
            channel_id: "c1".into(),
            question: "lunch?".into(),
            options: r#"["pizza","sushi"]"#.into(),
            created_by: Some("u1".into()),
            created_at: crate::db::now_str(),
        }
    }

    #[test]
    fn create_then_get_by_id_roundtrip() {
        let db = test_db();
        seed(&db);
        db.with_conn(|c| {
            create_poll(c, &poll("p1"))?;
            let got = get_poll_by_id(c, "p1")?.unwrap();
            assert_eq!(got.id, "p1");
            assert_eq!(got.question, "lunch?");
            assert_eq!(got.created_by.as_deref(), Some("u1"));
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn get_polls_by_channel_returns_in_creation_order() {
        let db = test_db();
        seed(&db);
        db.with_conn(|c| {
            create_poll(c, &poll("p-a"))?;
            std::thread::sleep(std::time::Duration::from_millis(1100));
            let mut p_b = poll("p-b");
            p_b.created_at = crate::db::now_str();
            create_poll(c, &p_b)?;
            let polls = get_polls_by_channel(c, "c1")?;
            // ORDER BY created_at ASC.
            assert_eq!(polls[0].id, "p-a");
            assert_eq!(polls[1].id, "p-b");
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn get_poll_by_id_returns_none_for_unknown() {
        let db = test_db();
        seed(&db);
        db.with_conn(|c| {
            assert!(get_poll_by_id(c, "never")?.is_none());
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn upsert_poll_vote_replaces_existing_choice() {
        let db = test_db();
        seed(&db);
        db.with_conn(|c| {
            create_poll(c, &poll("p1"))?;
            upsert_poll_vote(c, "p1", "u1", 0)?;
            upsert_poll_vote(c, "p1", "u1", 1)?;
            let votes = get_votes_for_poll(c, "p1")?;
            assert_eq!(votes.len(), 1);
            assert_eq!(votes[0].option_index, 1);
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn clear_poll_vote_removes_user_choice() {
        let db = test_db();
        seed(&db);
        db.with_conn(|c| {
            create_poll(c, &poll("p1"))?;
            upsert_poll_vote(c, "p1", "u1", 0)?;
            clear_poll_vote(c, "p1", "u1")?;
            assert!(get_votes_for_poll(c, "p1")?.is_empty());
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn clear_unknown_vote_is_noop() {
        let db = test_db();
        seed(&db);
        db.with_conn(|c| {
            create_poll(c, &poll("p1"))?;
            // No vote cast — clear should not throw.
            assert!(clear_poll_vote(c, "p1", "u1").is_ok());
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn get_votes_for_poll_returns_empty_for_unknown_poll() {
        let db = test_db();
        seed(&db);
        db.with_conn(|c| {
            assert!(get_votes_for_poll(c, "no-poll")?.is_empty());
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    }
}
