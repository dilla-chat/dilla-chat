-- Add team_id to dm_channels for team-scoped DMs
ALTER TABLE dm_channels ADD COLUMN team_id TEXT NOT NULL DEFAULT '' REFERENCES teams(id);

-- Add dm_channel_id to messages so DMs use the same messages table
ALTER TABLE messages ADD COLUMN dm_channel_id TEXT DEFAULT '' REFERENCES dm_channels(id);

-- Index for DM message lookups
CREATE INDEX IF NOT EXISTS idx_messages_dm_channel ON messages(dm_channel_id, created_at);

-- Make channel_id nullable-ish (SQLite can't alter NOT NULL, but we default to '')
-- Messages will have either channel_id or dm_channel_id set
