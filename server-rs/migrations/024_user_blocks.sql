-- User blocks. Symmetric in name but not in effect — when A blocks B,
-- A no longer sees messages or DMs from B, but B isn't notified and
-- doesn't lose access to anything they had. Composite PK so the same
-- (blocker, blocked) pair can't appear twice.

CREATE TABLE IF NOT EXISTS user_blocks (
    blocker_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (blocker_id, blocked_id)
);

-- Lookup by blocker is the hot path (every message:new broadcast checks
-- "is the author blocked by this recipient?"). Index just on blocker_id
-- since the PK already gives us (blocker, blocked) lookups for free.
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker
    ON user_blocks (blocker_id);
