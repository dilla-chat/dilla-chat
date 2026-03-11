//! Local SQLite database for message cache and key storage

use rusqlite::{Connection, Result};

pub struct LocalDb {
    conn: Connection,
}

impl LocalDb {
    pub fn open(path: &str) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;"
        )?;
        Ok(Self { conn })
    }

    pub fn run_migrations(&self) -> Result<()> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS local_config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS cached_messages (
                id TEXT PRIMARY KEY,
                team_id TEXT NOT NULL,
                channel_id TEXT NOT NULL,
                content_encrypted BLOB NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS encryption_sessions (
                id TEXT PRIMARY KEY,
                peer_public_key BLOB NOT NULL,
                session_data BLOB NOT NULL,
                updated_at TEXT NOT NULL
            );"
        )?;
        Ok(())
    }
}
