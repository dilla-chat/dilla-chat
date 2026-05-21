-- A1 / AUTH-MULTIDEV-1: per-user device key trust.
--
-- Dilla auth is passwordless (Ed25519 challenge-response → JWT). Before
-- this migration a user is identified by a single public_key on the
-- users row, so a stolen private key can be revoked only by re-keying
-- the user. With user_devices, a user can hold N (device_id, pubkey)
-- pairs and revoke any one of them from any other still-trusted device.
--
-- Backfill: every existing users row with a non-empty public_key
-- becomes a single device row labeled "primary". Migration is
-- idempotent (INSERT OR IGNORE keyed off (user_id, public_key)).

CREATE TABLE IF NOT EXISTS user_devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Raw 32-byte Ed25519 public key. Each device has its own
    -- keypair; the user-level users.public_key remains the
    -- "primary" device's pubkey for backward compat with the v1
    -- challenge-response flow.
    public_key BLOB NOT NULL,
    -- Human-readable label set at enrollment time ("MacBook Air",
    -- "iPhone 15", "office desktop"). Bounded to 64 chars at the
    -- API layer; rendered verbatim in /devices listings.
    device_label TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- Last time this device successfully verified a challenge.
    -- Null until first login through the device-aware verify path.
    last_seen_at TEXT,
    -- A2: risk-context for the most recent login. Per-device so a
    -- compromise of one device shows in its own row without
    -- contaminating the parent user's other devices.
    last_seen_ip TEXT,
    last_seen_user_agent TEXT,
    last_seen_country TEXT,
    -- A4: the session-start of the JWT issued at the most recent
    -- /auth/verify. Lets `/devices` show "this device has been
    -- logged in for 3h" without storing the JWT itself.
    current_session_started_at TEXT,
    -- Revocation set by an enrolled device; once non-null, future
    -- JWT issuance fails for this device_id. Existing JWTs survive
    -- their natural exp window unless the caller also revokes the
    -- jti via the existing /auth/logout path.
    revoked_at TEXT,
    -- A4: unix-seconds cutoff. JWTs with `iat < tokens_invalidated_after`
    -- are rejected at validate-time. Used by the force-logout path
    -- when a user's role changes server-side so the in-flight access
    -- token can't be used with the new perms while the old still
    -- show in the JWT's signature claims.
    tokens_invalidated_after INTEGER NOT NULL DEFAULT 0,
    UNIQUE (user_id, public_key)
);

CREATE INDEX IF NOT EXISTS idx_user_devices_user_id
    ON user_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_user_devices_public_key
    ON user_devices(public_key);

-- Backfill one device row per existing user. The label "primary"
-- mirrors how the UI will surface this device after the migration:
-- the user can rename it from /devices.
INSERT OR IGNORE INTO user_devices (id, user_id, public_key, device_label, created_at)
SELECT
    lower(hex(randomblob(16))),
    id,
    public_key,
    'primary',
    datetime('now')
FROM users
WHERE length(public_key) = 32;

-- A3 backfill: every Admin-style role on every existing team gets
-- PERM_MANAGE_FEDERATION (1<<10) + PERM_VIEW_AUDIT_LOG (1<<11) so
-- nothing breaks for operators who have already structured their
-- role ladder. Roles that hold PERM_ADMIN (1<<0) get the bits
-- ORed in; everything else is left alone (granting these to a
-- regular role is the operator's call).
UPDATE roles
SET permissions = permissions | 3072  -- (1<<10) | (1<<11)
WHERE (permissions & 1) = 1;  -- PERM_ADMIN
