-- VULN-002 Phase 3 foundation: per-node Ed25519 identity + pinned peers.
--
-- This migration lays the storage groundwork for the federation
-- redesign documented in .security-hardening/14-federation-phase3-design.md.
-- It does NOT change the federation wire protocol — that lands in a
-- follow-up release once every node has been running with the
-- identity in place long enough to exchange keys cleanly.
--
-- What this migration does:
--   1. node_identity — one row per node, holding the node's Ed25519
--      keypair. The private key is stored as raw 32-byte seed bytes;
--      the SQLCipher key derivation in db/mod.rs already encrypts the
--      whole DB at rest, so we rely on that rather than wrapping
--      individually.
--   2. federation_peers — pinned remote-peer public keys. Operators
--      explicitly enroll peers via a CLI subcommand (out-of-band);
--      there is no TOFU on the federation surface.
--   3. federation_seq_watermark — per-(origin, team) sequence
--      watermark for replay defense once signed events ship.
--   4. team_authority — which node owns each team. Populated lazily
--      at team creation; pre-existing teams get NULL and skip
--      authority validation until an operator backfills.
--   5. audit_events.federation_origin_node_id +
--      audit_events.federation_event_id — provenance columns. NULL
--      for local actions; populated when the row was applied via
--      federation replay.
--
-- No data movement here — the keypair is generated on the next
-- startup (server-rs/src/federation/identity.rs).

CREATE TABLE IF NOT EXISTS node_identity (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    node_id TEXT NOT NULL,
    -- Raw 32-byte Ed25519 public key.
    public_key BLOB NOT NULL,
    -- Raw 32-byte Ed25519 secret seed (ed25519-dalek SigningKey::to_bytes).
    private_key BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS federation_peers (
    node_id TEXT PRIMARY KEY,
    public_key BLOB NOT NULL,
    hostname TEXT NOT NULL,
    pinned_at TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_federation_peers_hostname
    ON federation_peers(hostname);

CREATE TABLE IF NOT EXISTS federation_seq_watermark (
    origin_node_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    last_seq INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (origin_node_id, team_id)
);

CREATE TABLE IF NOT EXISTS team_authority (
    team_id TEXT PRIMARY KEY,
    owner_node_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_team_authority_owner
    ON team_authority(owner_node_id);

-- Provenance columns on the existing audit_events table. NULL for
-- everything written before this migration; new federation-merged
-- rows will populate them. Safe ALTER (no constraints, additive only).
ALTER TABLE audit_events ADD COLUMN federation_origin_node_id TEXT;
ALTER TABLE audit_events ADD COLUMN federation_event_id TEXT;
