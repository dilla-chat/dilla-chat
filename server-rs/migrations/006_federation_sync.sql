-- Add updated_at to roles and members for federation conflict resolution.
ALTER TABLE roles ADD COLUMN updated_at TEXT DEFAULT '';
ALTER TABLE members ADD COLUMN updated_at TEXT DEFAULT '';
