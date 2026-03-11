CREATE TABLE IF NOT EXISTS bans (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    banned_by TEXT NOT NULL REFERENCES users(id),
    reason TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (team_id, user_id)
);
