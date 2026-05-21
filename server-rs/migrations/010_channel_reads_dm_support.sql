-- Migration 010: Allow channel_reads.channel_id to reference DM channels too.
-- The original 008 FK is REFERENCES channels(id), but the read-state table
-- is reused for both team channels and DM channels (keyed by the same id).
-- Recreate without the FK so DM reads can be tracked.

CREATE TABLE channel_reads_new (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL,
    last_read_message_id TEXT NOT NULL DEFAULT '',
    last_read_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, channel_id)
);

INSERT INTO channel_reads_new (user_id, channel_id, last_read_message_id, last_read_at)
    SELECT user_id, channel_id, last_read_message_id, last_read_at FROM channel_reads;

DROP TABLE channel_reads;
ALTER TABLE channel_reads_new RENAME TO channel_reads;
CREATE INDEX IF NOT EXISTS idx_channel_reads_channel ON channel_reads(channel_id);
