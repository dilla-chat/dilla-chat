-- Phase 8: Threads table

CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    parent_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL DEFAULT '',
    creator_id TEXT NOT NULL REFERENCES users(id),
    title TEXT DEFAULT '',
    message_count INTEGER DEFAULT 0,
    last_message_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(parent_message_id)
);

CREATE INDEX IF NOT EXISTS idx_threads_channel ON threads(channel_id);
CREATE INDEX IF NOT EXISTS idx_threads_parent ON threads(parent_message_id);
