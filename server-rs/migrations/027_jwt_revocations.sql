-- H2 / VULN-012 / AUTH-WEAK-1: per-JWT revocation list. Tokens carry a
-- random jti (UUID v4); on logout we insert the jti + its expiry here
-- so validate_jwt can reject it before the natural exp window closes.
-- We GC rows whose expires_at is in the past in a background sweep.
CREATE TABLE IF NOT EXISTS jwt_revocations (
    jti TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    revoked_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jwt_revocations_expires_at
    ON jwt_revocations(expires_at);
