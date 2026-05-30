-- Audit log of admin actions for a team. Read via the Settings → Audit log
-- panel. Append-only.

CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    actor_user_id TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    details TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_events_team_time
    ON audit_events (team_id, created_at DESC);
