-- Per-user channel mute. NULL muted_until means muted indefinitely;
-- otherwise the mute lifts when the timestamp passes (server treats
-- past timestamps as not-muted).

CREATE TABLE IF NOT EXISTS channel_mutes (
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    muted_until TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_mutes_user
    ON channel_mutes (user_id);
