pub mod models;
mod queries;
mod dm_queries;
mod thread_queries;
mod reaction_queries;
mod attachment_queries;

use rusqlite::Connection;
use std::path::Path;
use std::sync::{Arc, Mutex};

pub use models::*;
pub use queries::*;
pub use dm_queries::*;
pub use thread_queries::*;
pub use reaction_queries::*;
pub use attachment_queries::*;

const MIGRATIONS: &[(&str, &str)] = &[
    ("001_initial.sql", include_str!("../../migrations/001_initial.sql")),
    ("002_bans.sql", include_str!("../../migrations/002_bans.sql")),
    ("003_dm_enhancements.sql", include_str!("../../migrations/003_dm_enhancements.sql")),
    ("004_threads.sql", include_str!("../../migrations/004_threads.sql")),
    ("005_reactions_attachments.sql", include_str!("../../migrations/005_reactions_attachments.sql")),
];

#[derive(Clone)]
pub struct Database {
    conn: Arc<Mutex<Connection>>,
}

impl Database {
    pub fn open(data_dir: &str, passphrase: &str) -> Result<Self, rusqlite::Error> {
        let db_path = Path::new(data_dir).join("dilla.db");
        let conn = Connection::open(&db_path)?;

        // Set encryption key via PRAGMA (SQLCipher).
        if !passphrase.is_empty() {
            conn.execute_batch(&format!("PRAGMA key = '{}';", passphrase.replace('\'', "''")))?;
        }

        // Enable WAL mode.
        conn.execute_batch("PRAGMA journal_mode = WAL;")?;

        // Verify the database is accessible.
        conn.execute_batch("SELECT 1;")?;

        tracing::info!(path = %db_path.display(), "database opened");
        Ok(Database {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn run_migrations(&self) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version TEXT PRIMARY KEY,
                applied_at TEXT DEFAULT (datetime('now'))
            );",
        )?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )?;

        for (name, sql) in MIGRATIONS {
            let count: i32 = conn.query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = ?1",
                [name],
                |row| row.get(0),
            )?;

            if count > 0 {
                continue;
            }

            let trimmed = sql.trim();
            if trimmed.is_empty() || (trimmed.starts_with("--") && !trimmed.contains('\n')) {
                tracing::info!(file = name, "skipping empty migration");
            } else {
                conn.execute_batch(trimmed)?;
            }

            conn.execute(
                "INSERT INTO schema_migrations (version) VALUES (?1)",
                [name],
            )?;
            tracing::info!(file = name, "applied migration");
        }

        Ok(())
    }

    pub fn has_users(&self) -> Result<bool, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let count: i32 =
            conn.query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))?;
        Ok(count > 0)
    }

    /// Execute a closure with the database connection.
    /// All database access goes through this to serialize writes.
    pub fn with_conn<F, T>(&self, f: F) -> Result<T, rusqlite::Error>
    where
        F: FnOnce(&Connection) -> Result<T, rusqlite::Error>,
    {
        let conn = self.conn.lock().unwrap();
        f(&conn)
    }
}

/// Ensure the data directory exists.
pub fn ensure_data_dir(dir: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

/// Generate a new UUID v4 string.
pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Format current time as SQLite datetime string.
pub fn now_str() -> String {
    chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()
}
