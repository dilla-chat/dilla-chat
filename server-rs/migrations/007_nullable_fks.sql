-- Migration 007: Make optional FK columns nullable for proper foreign key enforcement.
-- SQLite requires table recreation to change NOT NULL constraints.

-- Step 1: Recreate messages table with nullable channel_id.
-- channel_id is NULL for DM messages; dm_channel_id is NULL for channel messages.
CREATE TABLE messages_new (
    id TEXT PRIMARY KEY,
    channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES users(id),
    content BLOB NOT NULL,
    type TEXT NOT NULL DEFAULT 'text' CHECK(type IN ('text', 'system', 'file')),
    thread_id TEXT,
    edited_at TEXT,
    deleted INTEGER NOT NULL DEFAULT 0,
    lamport_ts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    dm_channel_id TEXT REFERENCES dm_channels(id)
);

INSERT INTO messages_new (id, channel_id, author_id, content, type, thread_id, edited_at, deleted, lamport_ts, created_at, dm_channel_id)
    SELECT id, NULLIF(channel_id, ''), author_id, content, type, NULLIF(thread_id, ''),
           edited_at, deleted, lamport_ts, created_at, NULLIF(dm_channel_id, '')
    FROM messages;

DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_dm_channel ON messages(dm_channel_id);

-- Step 2: Recreate attachments table with nullable message_id.
-- message_id is NULL when the attachment is uploaded but not yet linked to a message.
CREATE TABLE attachments_new (
    id TEXT PRIMARY KEY,
    message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
    filename_encrypted BLOB NOT NULL,
    content_type_encrypted BLOB,
    size INTEGER NOT NULL,
    storage_path TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO attachments_new (id, message_id, filename_encrypted, content_type_encrypted, size, storage_path, created_at)
    SELECT id, NULLIF(message_id, ''), filename_encrypted, content_type_encrypted, size, storage_path, created_at
    FROM attachments;

DROP TABLE attachments;
ALTER TABLE attachments_new RENAME TO attachments;

-- Step 3: Convert empty-string FK values to NULL in other tables.
UPDATE dm_channels SET team_id = NULL WHERE team_id = '';
