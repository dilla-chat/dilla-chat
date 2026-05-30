-- Channel groups are first-class entities so they can own permissions
-- (role-based access lists). Channels reference a group by id; the
-- prior `category` TEXT column on channels stays around for a release
-- as a write-through cache so older clients keep rendering, but new
-- code reads via group_id.
--
-- Pure-inheritance access model: when a channel is in a group, the
-- server checks the group's role list. When a channel has no group,
-- the channel-level role list (channel_role_access) still applies.

CREATE TABLE IF NOT EXISTS channel_groups (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_channel_groups_team
    ON channel_groups (team_id);

-- Names are unique within a team after normalization (matches the
-- channel-name rule from migration 019).
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_groups_name_unique
    ON channel_groups (team_id, lower(trim(name)));

-- Role-based access list for a group. Empty list = open (everyone in
-- the team can see channels in this group). Non-empty list = only
-- members holding at least one of these roles can see them.
CREATE TABLE IF NOT EXISTS channel_group_role_access (
    group_id TEXT NOT NULL REFERENCES channel_groups(id) ON DELETE CASCADE,
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_group_role_access_group
    ON channel_group_role_access (group_id);

-- channels.group_id points back at the owning group. SET NULL on
-- delete so dropping a group doesn't cascade-delete its channels.
ALTER TABLE channels ADD COLUMN group_id TEXT REFERENCES channel_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_channels_group
    ON channels (group_id);

-- Backfill: for each distinct trimmed/lowercased category per team,
-- create a group and point matching channels at it. lower(hex(randomblob(8)))
-- gives a stable 16-char id consistent with db::new_id() in the app
-- layer. The category column stays populated for now — we drop it in
-- a later migration once all clients have been re-deployed.
INSERT INTO channel_groups (id, team_id, name, position)
SELECT
    lower(hex(randomblob(8))),
    team_id,
    -- Display name: keep the original casing of whichever channel was
    -- created first, normalized only for the uniqueness check.
    MIN(name_display) AS name,
    ROW_NUMBER() OVER (PARTITION BY team_id ORDER BY MIN(created_at)) - 1 AS position
FROM (
    SELECT
        team_id,
        trim(category) AS name_display,
        lower(trim(category)) AS name_key,
        created_at
    FROM channels
    WHERE trim(category) != ''
)
GROUP BY team_id, name_key;

UPDATE channels
SET group_id = (
    SELECT g.id
    FROM channel_groups g
    WHERE g.team_id = channels.team_id
      AND lower(trim(g.name)) = lower(trim(channels.category))
)
WHERE trim(category) != '';
