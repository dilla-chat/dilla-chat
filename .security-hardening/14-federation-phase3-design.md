# Phase 3 Federation Trust Redesign — Design Doc

**Status:** Design — not implemented. Provides the spec a future
implementer can pick up.
**Closes:** DILLA-VULN-002 (full), FED-META-1 (mitigates), FED-AUDIT-1 (closes),
the residual Phase-3 deferrals from `.security-hardening/11-pentest-results.md`.
**Estimated effort:** 1–2 weeks (one engineer), assuming the federation
test surface still compiles. Subtract a couple of days for protocol
test scaffolding if the current test rot stays.

---

## 1. Problem statement

Today's federation model:

1. Peers share a single `DILLA_JOIN_SECRET` (HKDF-derived since step 4
   commit `da4b983`). Authenticated peers are fully trusted on state
   merge.
2. `merge_channels` / `merge_roles` / `merge_members` / `merge_messages`
   use last-writer-wins on `updated_at`. A peer can rewrite any row.
3. Replicated audit rows don't carry the originating peer ID, so a
   compromised peer's writes are indistinguishable from local writes.

Net effect: any peer with the join_secret can forge admin roles,
fake message authorship, and rewrite arbitrary channel state on every
other node in the cluster. This is the core of VULN-002.

The phase-1 fixes (constant-time auth, refuse empty secret, HKDF the
key) defeat anonymous attackers but do nothing once a peer is in.
Phase 3 must address the *integrity* of replicated data, not just the
*identity* of the peer pushing it.

## 2. Design goals

1. **Per-event signatures.** Every replicated event carries an Ed25519
   signature over its canonical serialization. Receivers verify with
   the originator's pinned public key.
2. **Per-node identity.** Each Dilla node has a long-lived Ed25519
   keypair. Public keys are exchanged at federation-join time and
   pinned by every receiving node.
3. **Authority validation.** A receiving node verifies that the
   originating node is *authorized* for the action — not just that the
   signature is valid. (A peer cannot mint admin roles in someone
   else's team just because it has a valid signing key.)
4. **Provenance in audit.** Every federation-merged row writes an
   `audit_events` entry tagged with the originating node_id and
   event_id.
5. **Backward compatibility.** Existing clusters running phase-1
   should be able to upgrade without a hard fork — the protocol
   carries a version number and falls back to phase-1 semantics for
   one release cycle.
6. **Non-goal: hide metadata from legitimate peers.** FED-META-1 is
   inherent to a federated chat — operators federate because they
   want to share messages, and message-sharing implies metadata
   sharing. We document this honestly; we don't pretend to fix it.

## 3. Cryptographic primitives

Reuse the existing stack:

- **Ed25519** for node signing (same `ed25519-dalek` crate already on
  the dep list).
- **BLAKE3** (or SHA-256 if BLAKE3 is rejected) for event-id derivation.
- **Canonical JSON** via the `serde_canonical_json` crate (or a small
  in-tree serializer — RFC 8785 JCS). MUST be deterministic across
  Rust + JS implementations so future browser-side federation clients
  can verify.

No new dependencies beyond what's already in the workspace.

## 4. Protocol changes

### 4.1 Federation handshake (auth message)

```jsonc
// Before (phase-1): shared-secret HMAC
{ "join_token": "<bytes>" }

// After (phase-3): per-node Ed25519 challenge-response
{
  "v": 3,
  "node_id": "<uuid>",
  "public_key": "<base64 ed25519 32B>",
  "nonce": "<base64 32B>",
  "signature": "<base64 ed25519 64B over node_id || receiver_node_id || nonce>"
}
```

- Receiver verifies the signature against the supplied public key.
- Receiver checks `node_id` is in its pinned-peers table; if not,
  refuse. (No TOFU on federation peers — operators explicitly enroll.)
- `nonce` is single-use; receiver tracks recent nonces for 5 minutes
  to defeat replay.
- The `DILLA_JOIN_SECRET` HMAC stays as an outer envelope for one
  release to allow rolling upgrade. After deprecation, drop it.

### 4.2 Signed FederationEvent

Every event flowing over the wire is wrapped:

```rust
pub struct SignedFederationEvent {
    /// Event content. Must be canonical-serialized for the signature.
    pub event: FederationEvent,
    /// Originating node id.
    pub origin_node_id: String,
    /// Strictly increasing per-(node, team) sequence number.
    pub seq: u64,
    /// BLAKE3 of the canonical serialization. Doubles as event id.
    pub event_id: String,
    /// Ed25519 signature over the canonical serialization of
    /// { event, origin_node_id, seq, event_id }.
    pub signature: String,
}
```

The existing `FederationEvent` enum (channel/role/member/message
create/update/delete + state-sync) stays unchanged. Only the wrapper
is new.

### 4.3 Authority model

For each event variant, define **who is authoritative**:

| Event | Authoritative node |
|---|---|
| `channel.create/update/delete` | The team's **owning peer** — pinned at team-creation time. Other peers may mirror but not originate. |
| `role.create/update/delete` | Team's owning peer. |
| `member.add/remove` | Team's owning peer OR the user's home peer (mutual signature). |
| `message.create` | Author's home peer. The author's public key must verify the message. |
| `message.edit/delete` | Author's home peer only. |

A new table `team_authority` records which node owns each team:

```sql
CREATE TABLE team_authority (
  team_id TEXT PRIMARY KEY,
  owner_node_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

Populated at team creation (the originating node writes its own
`node_id`) and at federation-join (the join token carries it).

### 4.4 Merge validation

`handle_state_sync_response` and event-replication paths must:

1. Verify the wrapper signature.
2. Verify `origin_node_id` is in the pinned-peers table.
3. Verify `seq` is strictly greater than the last-seen seq for
   `(origin_node_id, team_id)` (replay defense + ordering).
4. Verify `origin_node_id` is authoritative for the event variant per
   §4.3.
5. Only then apply the merge.

Any failure → drop the event, record an `audit_events` row tagged
`federation.event_rejected` with the reason, log a `warn!`.

### 4.5 Per-event provenance in audit

Every federation-merged row writes:

```sql
INSERT INTO audit_events (team_id, actor_user_id, action, target_kind, target_id, details, federation_origin_node_id, federation_event_id)
VALUES (?, ?, 'federation.merge.<variant>', ?, ?, ?, ?, ?);
```

Two new columns on `audit_events`: `federation_origin_node_id`,
`federation_event_id`. Migration writes them as NULL for existing
rows.

## 5. Storage changes

```sql
-- Per-node identity. One row, this node's.
CREATE TABLE node_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  node_id TEXT NOT NULL,
  public_key BLOB NOT NULL,
  private_key BLOB NOT NULL,  -- encrypted at rest via SQLCipher key
  created_at TEXT NOT NULL
);

-- Pinned remote peers.
CREATE TABLE federation_peers (
  node_id TEXT PRIMARY KEY,
  public_key BLOB NOT NULL,
  hostname TEXT NOT NULL,
  pinned_at TEXT NOT NULL,
  revoked_at TEXT
);

-- Per-(origin, team) sequence watermark for replay defense + ordering.
CREATE TABLE federation_seq_watermark (
  origin_node_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  last_seq INTEGER NOT NULL,
  PRIMARY KEY (origin_node_id, team_id)
);

-- Authority per team.
CREATE TABLE team_authority (
  team_id TEXT PRIMARY KEY,
  owner_node_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

ALTER TABLE audit_events ADD COLUMN federation_origin_node_id TEXT;
ALTER TABLE audit_events ADD COLUMN federation_event_id TEXT;
```

The private_key in `node_identity` is bytes-at-rest encrypted by the
existing SQLCipher key derivation — no new key-management surface.
For high-assurance deployments, defer to HSM/`clevis+tang` per
`deploy/secrets/HSM.md`.

## 6. Migration story (rolling upgrade)

Two releases:

### Release N (phase-2 / current)
- Phase-1 hardening live (HKDF, constant-time, empty-secret refusal).
- Federation events unsigned.

### Release N+1 (phase-3 introduction)
- New `FederationEvent` wrapper with a `v: 3` field.
- Old-style events (`v: 1` or absent) are accepted but logged as
  `federation.legacy_event` audit rows.
- New events are signed and verified.
- `team_authority` populated lazily — when a team is created post-
  upgrade, the originating node writes itself in. Pre-existing teams
  default `owner_node_id = NULL` and skip authority validation
  (treat as phase-2-compatible).

### Release N+2 (phase-3 strict)
- Reject `v < 3` events.
- Pre-existing teams must have `team_authority` set; provide a CLI
  one-shot (`dilla-server federation backfill-authority`) for
  operators to assert "this node owns these teams".
- `DILLA_JOIN_SECRET` deprecated; remove the HMAC envelope.

This is two upgrade steps for operators but never a hard cluster
fork.

## 7. Code structure

New modules:

- `server-rs/src/federation/identity.rs` — load/persist `node_identity`,
  expose `sign(event) -> SignedFederationEvent`.
- `server-rs/src/federation/peers.rs` — pinned-peers CRUD + lookup.
- `server-rs/src/federation/authority.rs` — authority-check matrix
  (§4.3 table in code).
- `server-rs/src/federation/wire.rs` — canonical JSON + wrapper
  serialization.

Modified:

- `server-rs/src/federation/transport.rs` — new handshake; existing
  HMAC envelope kept for one release.
- `server-rs/src/federation/sync.rs` — every merge function gains
  an `&SignedFederationEvent` parameter, runs the validate-then-apply
  flow.
- `server-rs/src/federation/mod.rs` — same for the event-replication
  paths.

Configuration:

- `DILLA_FEDERATION_REQUIRE_V3 = false` (release N+1) → `true` (N+2).
- Operator-facing CLI subcommand `dilla-server federation peer add/list/revoke`.

## 8. Testing strategy

1. **Unit tests** for `wire.rs` canonical serialization stability
   across Rust versions and JS reference (a small JS test harness).
2. **Property tests** with `proptest` for sign-then-verify roundtrips
   across random `FederationEvent` payloads.
3. **Integration tests** spinning up two `dilla-server` instances on
   localhost, federating, and asserting:
   - Forged events from an unpinned peer are rejected.
   - Replay (re-sending a previously-applied event) is rejected.
   - Out-of-order events (`seq` decrease) are rejected.
   - Authority violations (peer A trying to write into team owned by
     peer B) are rejected and audit-logged.
   - Legitimate cross-peer flows still succeed.
4. **Wire-format compatibility test** — a fixture file of canonical
   serializations + signatures that future releases must continue to
   verify, so we can't silently break the protocol.

## 9. Out of scope

- **FED-META-1.** Federation peers inherently learn metadata — this
  redesign signs the metadata but doesn't hide it. Documented as a
  known limitation in `SECURITY.md` §9.
- **SFU-IP-1.** Voice ICE candidates leak IPs to channel members.
  Separate work item — could be addressed via TURN-only relay mode
  for high-privacy channels.
- **Cross-peer pseudonymity.** A user federating across orgs is
  visible by `user_id` everywhere. Pseudonymous federation would
  need per-peer derived user IDs, which is a separate research
  project.
- **Censorship resistance / forks.** This design assumes peers are
  cooperative-but-untrusted (Byzantine within their own writes, not
  globally adversarial). True Byzantine fault tolerance against
  network partitions / forks is out of scope.

## 10. Acceptance criteria

After Phase 3 ships, the validation pentest must show:

- **VULN-002:** CLOSED. A peer with `join_secret` cannot forge admin
  roles or messages in teams they don't own.
- **FED-AUDIT-1:** CLOSED. Every federation-sourced row carries
  `federation_origin_node_id` + `federation_event_id`.
- **FED-META-1:** still documented as known limitation. Acceptance
  is "metadata is *signed*", not "metadata is *hidden*".
- **Replay attacks:** rejected at the `seq` watermark.
- **Performance:** verify cost on hot replay paths ≤ 5% throughput
  overhead vs phase-1.

---

**References:**

- `.security-hardening/01-vulnerability-scan.md` VULN-002
- `.security-hardening/02-threat-model.md` G2 attack tree
- `.security-hardening/03-architecture-review.md` §7 (federation redesign)
- `.security-hardening/11-pentest-results.md` Phase-3 deferred items
- `SECURITY.md` §9 (Federation trust model — known limitations)
