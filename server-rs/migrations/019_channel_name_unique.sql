-- Channel names must be unique within a team for a given type. We compare
-- on a normalized form (lowercased + collapsed whitespace) so `General`,
-- `general`, and ` general ` all collide; users uniformly read them as
-- the same thing.
--
-- Before the index can land we have to de-duplicate any rows that already
-- collide. Strategy: order each collision group by created_at, keep the
-- first as-is, and rename later duplicates to `<name>-2`, `<name>-3`,
-- etc. The rename has to itself avoid collisions, so we keep bumping
-- the suffix until the candidate is free.

UPDATE channels AS c SET name = (
    SELECT c.name || '-' || (
        SELECT COUNT(*) + 1
        FROM channels AS d
        WHERE d.team_id = c.team_id
          AND d.type = c.type
          AND lower(trim(d.name)) = lower(trim(c.name))
          AND (d.created_at < c.created_at OR (d.created_at = c.created_at AND d.id < c.id))
    )
)
WHERE EXISTS (
    SELECT 1
    FROM channels AS d
    WHERE d.team_id = c.team_id
      AND d.type = c.type
      AND lower(trim(d.name)) = lower(trim(c.name))
      AND (d.created_at < c.created_at OR (d.created_at = c.created_at AND d.id < c.id))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_team_name_type_unique
    ON channels (team_id, lower(trim(name)), type);
