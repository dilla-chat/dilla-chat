-- H12 / UPL-DOS-1: per-team disk-usage tracking. Every successful
-- upload bumps upload_bytes_used by the file size; delete_attachment
-- decrements it. The default cap is DILLA_UPLOAD_QUOTA_PER_TEAM_GB
-- (10 GiB out of the box). Reject with 413 once usage + new_file > cap.
ALTER TABLE teams ADD COLUMN upload_bytes_used INTEGER NOT NULL DEFAULT 0;

-- Backfill existing usage so a server that's been collecting uploads
-- pre-quota starts in the correct state. The aggregate is bounded by
-- the existing attachments table size; cheap on any realistic dataset.
UPDATE teams SET upload_bytes_used = COALESCE((
    SELECT SUM(a.size)
    FROM attachments a
    INNER JOIN messages m ON m.id = a.message_id
    INNER JOIN channels c ON c.id = m.channel_id
    WHERE c.team_id = teams.id
), 0);
