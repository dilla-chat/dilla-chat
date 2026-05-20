-- Quiet hours for desktop notifications. Stored on the user row so it
-- follows the identity across devices — picking a window on your phone
-- silences your laptop too. Times are HH:MM (24-hour) strings to keep
-- the schema timezone-agnostic; the client interprets them in local time.

ALTER TABLE users
    ADD COLUMN quiet_hours_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users
    ADD COLUMN quiet_hours_from TEXT NOT NULL DEFAULT '22:00';
ALTER TABLE users
    ADD COLUMN quiet_hours_to TEXT NOT NULL DEFAULT '07:30';
