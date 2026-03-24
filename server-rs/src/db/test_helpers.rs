use super::models::*;
use super::Database;

/// Create a fresh database for each test using a temp directory.
/// Foreign key enforcement is disabled to match production behavior
/// where the codebase uses empty strings for optional FK columns.
pub fn test_db() -> Database {
    let tmp = tempfile::tempdir().unwrap();
    let db = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
    db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;"))
        .unwrap();
    db.run_migrations().unwrap();
    db
}

pub fn make_user(id: &str, username: &str, public_key: &[u8]) -> User {
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

pub fn make_team(id: &str, name: &str, created_by: &str) -> Team {
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

pub fn make_channel(id: &str, team_id: &str, name: &str, created_by: &str) -> Channel {
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

pub fn make_message(id: &str, channel_id: &str, author_id: &str, content: &str) -> Message {
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

pub fn make_member(id: &str, team_id: &str, user_id: &str) -> Member {
    let now = crate::db::now_str();
    Member {
        id: id.to_string(),
        team_id: team_id.to_string(),
        user_id: user_id.to_string(),
        nickname: String::new(),
        joined_at: now.clone(),
        invited_by: user_id.to_string(),
        updated_at: now,
    }
}
