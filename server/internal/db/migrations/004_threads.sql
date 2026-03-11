-- Threads table
CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    parent_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL,
    creator_id TEXT NOT NULL REFERENCES users(id),
    title TEXT DEFAULT '',
    message_count INTEGER DEFAULT 0,
    last_message_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(parent_message_id)
);

-- Thread messages use the existing messages table with thread_id set
-- Note: messages.thread_id already exists from 001_initial.sql referencing messages(id).
-- We add a new column to reference threads(id) for the new thread model.
-- Since SQLite ALTER TABLE ADD COLUMN is idempotent-safe with IF NOT EXISTS workaround,
-- we rely on the migration runner to skip if already applied.
