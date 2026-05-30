-- Pinned messages — first-class table keyed by message_id so a pin
-- survives edits and stays valid as messages page in/out of the
-- timeline cache. Cascading delete from messages keeps the table
-- consistent if the underlying message is hard-deleted.

CREATE TABLE IF NOT EXISTS pinned_messages (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    pinned_by  TEXT,
    pinned_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pinned_messages_channel
    ON pinned_messages (channel_id, pinned_at DESC);

CREATE INDEX IF NOT EXISTS idx_pinned_messages_team
    ON pinned_messages (team_id);
