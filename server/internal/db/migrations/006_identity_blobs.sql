-- Identity blob escrow: server stores encrypted identity blobs for cross-device recovery.
-- The blob is opaque to the server (AES-256-GCM encrypted by the client).

CREATE TABLE IF NOT EXISTS identity_blobs (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    blob TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
