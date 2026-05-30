-- Slow mode: minimum seconds between successive messages from the same
-- user in a channel. 0 = no limit. Enforced server-side on message:send.

ALTER TABLE channels ADD COLUMN slow_mode_seconds INTEGER NOT NULL DEFAULT 0;
