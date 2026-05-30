-- Polls. A poll lives next to its channel and is rendered in the timeline
-- as a kind='poll' "message" by the client. Votes are tallied per-option
-- with one row per (poll, voter) so vote/unvote is idempotent.

CREATE TABLE IF NOT EXISTS polls (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    question TEXT NOT NULL,
    options TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_polls_channel_time
    ON polls (channel_id, created_at);

CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    option_index INTEGER NOT NULL,
    voted_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (poll_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_poll_votes_poll
    ON poll_votes (poll_id);
