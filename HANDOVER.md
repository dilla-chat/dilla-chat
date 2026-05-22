# Dilla — Repo Handover (live document)

This is the **live source of truth** for everything outstanding
across the whole repo. When an item is finished, delete its block
**in the same commit that closes the item**. The commit message
should reference the item id (H-N). When this file is empty, no
in-flight work remains.

**How to use this:**
- **Tractable** — items an in-session contributor can knock out
  one-by-one. Each has a concrete "definition of done".
- **Integration tier** — release-coordinated work that touches the
  federation wire protocol or other multi-node concerns. Do NOT
  auto-apply these — they need explicit operator coordination and
  rolling-upgrade planning.
- **Product / UX follow-ups** — non-security work known to be
  in-flight or stubbed.
- **Architectural deferrals** — known limitations that are
  documented (in `SECURITY.md` §9 etc.) and tracked here for
  future revisits.

**Branch posture going into this handover:**
- On `feat/mesh-redesign`, 500+ commits ahead of `main`.
- Server builds clean (`cargo build --release`).
- Dev pattern `DILLA_INSECURE=true …` works.
- Client builds clean (`npm run build`).
- `npm audit` reports 0 vulnerabilities.
- `cargo test` does **not** compile due to pre-existing test rot
  (see H-4 below).

---

## Tractable (in-session-friendly)

### H-2 — `DILLA_FEDERATION_REQUIRE_V3` config flag scaffolding

The Phase 3 design (§6) calls for a two-release rolling upgrade.
This commit lays the flag without flipping any wire path:

- Add `require_federation_v3: bool` to `server-rs/src/config.rs`
  (env `DILLA_FEDERATION_REQUIRE_V3`, default `false`).
- Document in `.env.example` + `deploy/secrets/CHECKLIST.md`.
- No call sites yet — those land with H-7/H-8/H-9.

**Definition of done:** flag readable from env, default false,
documented. ~30 LoC.

### H-3 — SFU-IP-1 mitigation: per-team TURN-only voice mode

Voice ICE candidates leak each speaker's real IP to legitimate
channel members. Operator-facing fix: a per-team
`force_turn_relay` flag.

- Migration `031_team_turn_relay.sql` adds
  `teams.force_turn_relay BOOLEAN DEFAULT 0`.
- `PATCH /api/v1/teams/{id}` accepts the new flag (gated by
  `PERM_MANAGE_TEAM`).
- WS `voice:rooms-snapshot` and team payload carry the flag so
  the client knows to apply `RTCIceTransportPolicy = "relay"`.
- Client-side enforcement is a separate diff (a follow-up).

**Definition of done:** migration applied, flag persists, team
PATCH respects it, snapshot carries it. ~120 LoC server-side.

### H-4 — Pre-existing test-rot cleanup

`cargo test` doesn't compile because legacy test fixture builders
construct `db::User` and `db::Channel` with the old field set —
missing `quiet_hours_*`, `locked`, `hidden_if_restricted`,
`slow_mode_seconds`, `group_id`.

- Audit every `tests` module under `server-rs/src/` for struct
  literals over `db::User` / `db::Channel` / `UpdateChannelRequest`
  / others.
- Add the missing fields with sensible defaults (`String::new()`,
  `false`, `0`, `None`).
- Make `cargo test --bin dilla-server` compile end-to-end.

**Definition of done:** `cargo test` runs end-to-end (pass/fail
per-test irrelevant — just needs to compile). ~150 LoC across ~6
files. No production code changes.

### H-5 — Sliding-refresh client awareness

Server-side sliding refresh ships (commit `85db447`). Client isn't
reading the `rotated: true` response flag, so the next refresh
after rotation fails with "refresh token revoked".

- `client/src/services/api.ts` — read `rotated` from
  `POST /api/v1/auth/refresh` response, store the new
  `refresh_token` when present, replacing the old one. Re-encrypt
  at rest via the existing step-6-F4 wrap key.

**Definition of done:** rotation roundtrip works without forcing
re-login. ~30 LoC.

### H-6 — Per-device JWT revocation table

Today device revocation invalidates the user's outstanding JWTs
broadly via `tokens_invalidated_after`. A per-device revocation
table lets operators kill one device's sessions without forcing
everyone else to re-login.

- Migration `032_device_jwt_revocations.sql` — table
  `device_jwt_revocations(jti, device_id, revoked_at, expires_at)`.
- `revoke_device` writes a row tagged with the device_id;
  `validate_jwt_full` checks both global jti revocation AND the
  per-device table.
- Index on `(device_id, revoked_at)` for hot-path lookup.

**Definition of done:** revoking device A doesn't log out device B
on the same user. ~120 LoC.

### H-7 — Unlinked-attachment `uploader_id` column

`server-rs/src/api/uploads.rs:221` calls out that the unlinked
attachment cross-team check is implemented by parsing
`storage_path`, but a proper fix needs an `uploader_id` column
on the `attachments` table.

- Migration `033_attachments_uploader_id.sql` — add
  `uploader_id TEXT` (NULL for pre-existing rows; populated on new
  uploads).
- `create_attachment` sets it from the upload handler's `user_id`.
- Download path checks `uploader_id == caller_id` in the in-grace
  window instead of falling back to the storage-path team trick.

**Definition of done:** migration applied, new uploads carry
`uploader_id`, in-grace path uses it. ~60 LoC.

### H-8 — Tor exit-list + GeoLite2 wiring for risk scoring

`auth_handlers::compute_risk_score` (commit `0d55d30`) records
risk signals but the Tor lookup is stubbed and country resolution
returns `"unknown"`.

- Optional `data/tor-exit-nodes.txt` reader at startup; populates
  an `Arc<HashSet<IpAddr>>` checked in `compute_risk_score`.
- Optional `data/GeoLite2-Country.mmdb` reader; populates the
  `country` field on `user_devices.last_seen_country` when
  present.
- Both opt-in via env vars (`DILLA_TOR_EXIT_LIST_PATH`,
  `DILLA_GEOIP_DB_PATH`); absence is non-fatal.

**Definition of done:** when the files are present, risk events
fire correctly; when absent, no regression. ~80 LoC + a small
binary-file deserializer for MMDB or a thin wrapper around the
`maxminddb` crate.

---

## Integration tier (release-coordinated, NOT for autonomous patching)

### H-9 — Transport handshake change (Phase 3 §4.1)

Switch peer auth from shared `DILLA_JOIN_SECRET` HMAC to per-node
Ed25519 challenge-response, using `node_identity` + `peers` from
Phase 3 steps 1–2.

Touches `transport.rs::handle_incoming` + peer-dial path. **Needs:**
H-2 in place + a backward-compat window where both v1 (HMAC) and
v3 (Ed25519) auth styles are accepted.

### H-10 — `sync.rs` / `mod.rs` plumb signing/verifying into merge paths

Every outbound replication wraps the `FederationEvent` in
`wire::sign`. Every inbound runs:
1. `wire::verify(conn, signed)` — signature + pinned-peer OK
2. `authority::check(conn, &signed)` — origin authoritative for
   this event variant
3. seq-watermark check against `federation_seq_watermark`
4. apply the merge
5. write the audit row with `federation_origin_node_id` +
   `federation_event_id`

Touches `mod.rs::handle_message_*`, `sync.rs::merge_*`,
`sync.rs::handle_state_sync_response`. **Needs:** H-9 in place
first.

### H-11 — Two-release migration story

- **Release N+1:** accept both v1 + v3 events. `LegacyTeam`
  authority decisions accepted with `federation.legacy_team`
  audit rows.
- **Release N+2:** `DILLA_FEDERATION_REQUIRE_V3=true` default. v1
  events refused. Operators MUST have backfilled `team_authority`
  via H-1 before this release.

Needs flag wiring in `validate_auth_message_with_insecure`,
`handle_incoming`, and the merge paths. Coordinated with H-9 + H-10.

### H-12 — Worker migration for crypto (DR-XSS-1 phase 2)

Today only safety-number computation lives in the Web Worker.
Migrate X3DH-initiate / Double-Ratchet decrypt / GroupSession
derive into the worker so a WebView XSS can't reach the ratchet
keys via the main-thread IndexedDB handle.

**Needs:** IndexedDB session-store handle to move into the worker
scope first (currently the main thread owns the store + posts
state blobs back). Real architectural work — should be its own
project. Files: `client/src/services/crypto/worker.ts:19` calls
this out as TODO follow-up.

### H-13 — httpOnly cookie token migration

Encrypted-at-rest sessionStorage closes most of the JWT-theft
window, but httpOnly cookies are the gold standard for browser
auth tokens. Requires server-side cookie issuance (Set-Cookie with
SameSite=Strict + Secure + HttpOnly) and matching client logic
that doesn't try to read the token from storage.

---

## Product / UX follow-ups

### H-14 — Client-side device-enrollment UI

Server-side device APIs ship (`POST /api/v1/devices/enroll-begin`,
`/enroll-complete`, `/revoke`, `GET /devices`). The Tauri-side
enrollment flow (QR code + authorizing-device signing) is not
yet wired.

- New view under `client/src/pages/` for listing + revoking
  devices.
- New flow: scan a QR (or copy a code) from the new device, the
  authorizing device signs the enroll-complete request.
- Recovery path when the user has only one device and wants to
  enroll a second.

### H-15 — TeamSidebar stubs

`client/src/components/TeamSidebar/TeamSidebar.tsx:200-201`:
- `onMarkAllRead` — currently `console.warn('TODO')`
- `onLeave` — currently `console.warn('TODO')`

Both need to call into the existing REST endpoints (mark-all-read
on channel reads; leave-team is `POST /api/v1/teams/{id}/leave`).

### H-16 — Incoming-call accept wiring

`client/src/pages/AppLayout.tsx:826` notes a TODO: "actually join
the call once voice signaling exposes incoming-call accept". The
voice signaling now exists; the accept button just needs hooking
up.

---

## Architectural deferrals (documented; not for in-session work)

### H-17 — FED-META-1 (federation metadata is inherently shared)

Federation peers see ciphertext + the full social graph for every
replicated team. This is inherent to a federated chat — operators
federate because they want to share messages. Documented as a
known limitation in `SECURITY.md` §9. Mitigating it would require
either per-peer pseudonymous IDs or fundamentally rethinking how
federation works. Out of scope for hardening; revisit only if
strategically prioritized.

### H-18 — Hidden-Service / Tor deploy guide for high-anonymity ops

`deploy/docker/compose.yml` has a commented-out
`tor-hidden-service` block. A real guide would explain how to run
Dilla as a `.onion` service — bridging operator anonymity over a
federated chat. Not security-critical for the typical operator;
documentation-only effort, but coordinated with H-3 (TURN-only)
+ H-13 (cookies) for a full anonymity story.

---

## Closed in earlier sessions (for the record)

Summarized — full details in `.security-hardening/`:

- Phase 1 assessment (24 numbered findings + threat model +
  architecture review).
- Phase 2 remediation: critical fixes (commits `c9adcd8`..`244e15d`),
  backend hardening (`8a52367`..`587ae67`), frontend hardening
  (`5dbc856`..`bb03b16`).
- Phase 3 controls: auth enhancement (`0d55d30`..`b7eb3cd`),
  infrastructure docs (`004dbad`), secrets management
  (`eea6661`, `6644a6b`).
- Phase 4 validation + compliance + SIEM playbook (`004dbad`..`c286dca`).
- Federation Phase 3 foundation: design doc (`55063cc`), identity
  + migrations (`d3ac12a`), peers (`f7e55df`), wire (`76885cd`),
  authority (`8225e43`), admin API (`7410d31`), team-owner hook
  (`677f403`).
- 8 net-new findings from validation closed: VULN-015 doc
  (`3be0633`), bootstrap expiry fail-closed (`372b5f6`),
  federation empty-secret rejection (`5dbf455`), WS team-param
  membership (`3f46be4`), unlinked-attachment cross-team
  (`0552035`), TOCTOU revoke (`aa7bc50`), DNS-rebind SSRF
  (`4470fe8`).
- A6 policy-migration tail across 11 REST handlers (`3b7828c`).
- SECURITY.md §9 federation known-limitations (`33b83ab`).
