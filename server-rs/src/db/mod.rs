pub mod models;
#[cfg(test)]
pub(crate) mod test_helpers;
mod user_queries;
mod team_queries;
mod channel_queries;
mod member_queries;
mod message_queries;
mod role_queries;
mod sync_queries;
mod permission_queries;
mod invite_queries;
mod ban_queries;
mod prekey_queries;
mod settings_queries;
mod dm_queries;
mod thread_queries;
mod reaction_queries;
mod attachment_queries;
mod read_queries;

use rusqlite::Connection;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicUsize, Ordering};

pub use models::*;
pub use user_queries::*;
pub use team_queries::*;
pub use channel_queries::*;
pub use member_queries::*;
pub use message_queries::*;
pub use role_queries::*;
pub use sync_queries::*;
pub use permission_queries::*;
pub use invite_queries::*;
pub use ban_queries::*;
pub use prekey_queries::*;
pub use settings_queries::*;
pub use dm_queries::*;
pub use thread_queries::*;
pub use reaction_queries::*;
pub use attachment_queries::*;
pub use read_queries::*;

const MIGRATIONS: &[(&str, &str)] = &[
    ("001_initial.sql", include_str!("../../migrations/001_initial.sql")),
    ("002_bans.sql", include_str!("../../migrations/002_bans.sql")),
    ("003_dm_enhancements.sql", include_str!("../../migrations/003_dm_enhancements.sql")),
    ("004_threads.sql", include_str!("../../migrations/004_threads.sql")),
    ("005_reactions_attachments.sql", include_str!("../../migrations/005_reactions_attachments.sql")),
    ("006_federation_sync.sql", include_str!("../../migrations/006_federation_sync.sql")),
    ("007_nullable_fks.sql", include_str!("../../migrations/007_nullable_fks.sql")),
    ("008_channel_reads.sql", include_str!("../../migrations/008_channel_reads.sql")),
];

/// Default number of read connections in the pool.
const DEFAULT_READ_POOL_SIZE: usize = 4;

/// Database with a connection pool: multiple read connections + 1 write connection.
/// SQLite WAL mode allows concurrent readers with a single writer.
#[derive(Clone)]
pub struct Database {
    /// Dedicated write connection (serialized via Mutex).
    write_conn: Arc<Mutex<Connection>>,
    /// Pool of read connections (round-robin via atomic counter).
    read_pool: Arc<Vec<Mutex<Connection>>>,
    /// Round-robin counter for read connection selection.
    read_index: Arc<AtomicUsize>,
}

/// Open a SQLite connection with SQLCipher passphrase and WAL mode.
fn open_connection(db_path: &Path, passphrase: &str) -> Result<Connection, rusqlite::Error> {
    let conn = Connection::open(db_path)?;
    if !passphrase.is_empty() {
        // Use pragma_update for safe parameter binding instead of string formatting.
        conn.pragma_update(None, "key", passphrase)?;
    }
    conn.execute_batch("PRAGMA journal_mode = WAL;")?;
    conn.execute_batch("PRAGMA busy_timeout = 5000;")?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    conn.execute_batch("SELECT 1;")?;
    Ok(conn)
}

impl Database {
    pub fn open(data_dir: &str, passphrase: &str) -> Result<Self, rusqlite::Error> {
        let db_path = Path::new(data_dir).join("dilla.db");

        // Open the write connection.
        let write_conn = open_connection(&db_path, passphrase)?;

        // Open read connections.
        let mut readers = Vec::with_capacity(DEFAULT_READ_POOL_SIZE);
        for _ in 0..DEFAULT_READ_POOL_SIZE {
            readers.push(Mutex::new(open_connection(&db_path, passphrase)?));
        }

        tracing::info!(
            path = %db_path.display(),
            read_pool_size = DEFAULT_READ_POOL_SIZE,
            "database opened with connection pool"
        );

        Ok(Database {
            write_conn: Arc::new(Mutex::new(write_conn)),
            read_pool: Arc::new(readers),
            read_index: Arc::new(AtomicUsize::new(0)),
        })
    }

    pub fn run_migrations(&self) -> Result<(), rusqlite::Error> {
        let conn = self.write_conn.lock().unwrap();

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
        self.with_read(|conn| {
            let count: i32 =
                conn.query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))?;
            Ok(count > 0)
        })
    }

    /// Execute a read-only closure with a pooled read connection.
    /// Multiple reads can proceed concurrently (SQLite WAL mode).
    pub fn with_read<F, T>(&self, f: F) -> Result<T, rusqlite::Error>
    where
        F: FnOnce(&Connection) -> Result<T, rusqlite::Error>,
    {
        let idx = self.read_index.fetch_add(1, Ordering::Relaxed) % self.read_pool.len();
        let conn = self.read_pool[idx].lock().unwrap();
        f(&conn)
    }

    /// Execute a write closure with the dedicated write connection.
    /// Only one write can proceed at a time (SQLite limitation).
    pub fn with_write<F, T>(&self, f: F) -> Result<T, rusqlite::Error>
    where
        F: FnOnce(&Connection) -> Result<T, rusqlite::Error>,
    {
        let conn = self.write_conn.lock().unwrap();
        f(&conn)
    }

    /// Execute a closure with a database connection (backward compatible).
    /// Uses the write connection to maintain compatibility with existing code
    /// that may mix reads and writes in a single closure.
    pub fn with_conn<F, T>(&self, f: F) -> Result<T, rusqlite::Error>
    where
        F: FnOnce(&Connection) -> Result<T, rusqlite::Error>,
    {
        self.with_write(f)
    }
}

/// Map a database row to a Message struct.
/// Shared by message_queries, dm_queries, and thread_queries.
/// Expects columns: id, channel_id, dm_channel_id, author_id, content, type,
///                   thread_id, edited_at, deleted, lamport_ts, created_at
pub(crate) fn row_to_message(row: &rusqlite::Row) -> Result<Message, rusqlite::Error> {
    Ok(Message {
        id: row.get(0)?,
        channel_id: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
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

/// Ensure the data directory exists.
pub fn ensure_data_dir(dir: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

/// Generate a new UUID v4 string.
pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Convert an empty string to `None` for nullable FK columns.
/// Use in `params![]` so that empty strings are stored as SQL NULL,
/// which correctly skips foreign key checks.
pub fn nullable(s: &str) -> Option<&str> {
    if s.is_empty() { None } else { Some(s) }
}

/// Format current time as SQLite datetime string.
pub fn now_str() -> String {
    chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

#[cfg(test)]
mod nullable_tests {
    use super::*;

    #[test]
    fn nullable_returns_none_for_empty() {
        assert_eq!(nullable(""), None);
    }

    #[test]
    fn nullable_returns_some_for_non_empty() {
        assert_eq!(nullable("hello"), Some("hello"));
    }

    #[test]
    fn foreign_keys_enabled_on_new_connections() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        let fk_enabled: i32 = db
            .with_conn(|c| c.query_row("PRAGMA foreign_keys", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(fk_enabled, 1, "foreign_keys should be ON for write conn");

        let fk_read: i32 = db
            .with_read(|c| c.query_row("PRAGMA foreign_keys", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(fk_read, 1, "foreign_keys should be ON for read conns");
    }
}
