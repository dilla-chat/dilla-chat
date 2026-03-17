-- Phase 7: DM enhancements
-- Add team_id to dm_channels and dm_channel_id to messages

ALTER TABLE dm_channels ADD COLUMN team_id TEXT DEFAULT '' REFERENCES teams(id);
ALTER TABLE messages ADD COLUMN dm_channel_id TEXT DEFAULT '' REFERENCES dm_channels(id);
CREATE INDEX IF NOT EXISTS idx_messages_dm_channel ON messages(dm_channel_id);
CREATE INDEX IF NOT EXISTS idx_dm_channels_team ON dm_channels(team_id);
