-- Add `locked` flag to channels. Locked channels reject voice joins from
-- non-admins.

ALTER TABLE channels ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
