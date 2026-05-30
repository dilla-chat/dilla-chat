-- Role-based channel access. A channel grants visibility to anyone whose
-- member role-list intersects with the channel's access role-list. Empty
-- access list = open to all (legacy back-compat); explicit list = gated.
--
-- Backfills:
--   - Every existing channel gets its team's default ("everyone") role so
--     the default is "open to everyone".
--   - Channels that were `locked=1` lose the everyone role and pick up the
--     Admin role instead, preserving the previous "admins only" intent.

CREATE TABLE IF NOT EXISTS channel_role_access (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (channel_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_role_access_role
    ON channel_role_access (role_id);

-- Backfill: every existing channel + its team's default role.
INSERT OR IGNORE INTO channel_role_access (channel_id, role_id)
SELECT c.id, r.id
FROM channels c
JOIN roles r ON r.team_id = c.team_id AND r.is_default = 1
WHERE c.locked = 0;

-- For previously-locked channels: grant access only to the Admin role
-- (matches the previous PERM_MANAGE_CHANNELS gate semantics).
INSERT OR IGNORE INTO channel_role_access (channel_id, role_id)
SELECT c.id, r.id
FROM channels c
JOIN roles r ON r.team_id = c.team_id AND r.name = 'Admin'
WHERE c.locked = 1;
