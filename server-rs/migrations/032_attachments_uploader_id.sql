-- H-7: per-attachment uploader provenance.
--
-- Replaces the storage_path-parsing trick the in-grace download path
-- has been using to verify cross-team isolation (commit 0552035) with
-- a proper foreign-key-style reference to the uploader. Lets the
-- unlinked-grace window scope to the actual uploader instead of
-- "any team member of the URL's team_id".
--
-- Migration is additive: pre-existing rows get NULL, the download
-- handler falls back to the storage_path check for those, new rows
-- carry the uploader_id and the handler prefers that path.

ALTER TABLE attachments ADD COLUMN uploader_id TEXT;
CREATE INDEX IF NOT EXISTS idx_attachments_uploader_id
    ON attachments(uploader_id);
