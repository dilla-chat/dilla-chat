-- Phase 9: Reactions & Attachments enhancements
-- The reactions and attachments tables already exist in 001_initial.sql.
-- This migration adds an index for faster reaction lookups and
-- ensures the schema version is tracked.

CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

INSERT OR IGNORE INTO schema_version (version) VALUES (5);
