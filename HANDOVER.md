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

### H-4 — Pre-existing test-rot cleanup (parked)

`cargo test` doesn't compile because legacy test fixture struct
literals construct `db::User` / `db::Channel` / `Team` / `Message`
/ `UpdateChannelRequest` with old field sets — missing
`quiet_hours_*`, `locked`, `hidden_if_restricted`,
`slow_mode_seconds`, `group_id`, `reply_to_message_id`,
`force_turn_relay`.

**Parked.** Attempted bulk-patch via a Python script in this
session over-edited (gutted production struct definitions in
`models.rs` and elsewhere) and was reverted. The fix needs a
surgical per-site approach — open each `#[cfg(test)]` block,
inspect the literal, append the missing fields by hand. Scope is
~30 files of test code. Production code does not depend on this;
release builds are clean. Suggested approach for the next pass:
do it in a dedicated branch / PR with no other changes so the
diff is reviewable.

### H-8b — GeoLite2 country DB wiring (remainder of H-8)

The Tor-exit-list half of H-8 shipped (commit follows). The
GeoLite2 country half is still open:

- `auth_handlers::derive_country_from_ip` returns the literal
  string `"unknown"` for non-RFC-1918 IPs. A real country needs
  MaxMind's GeoLite2-Country.mmdb (free with attribution) and the
  `maxminddb` crate.
- Add `geoip_db_path: String` to Config (env
  `DILLA_GEOIP_DB_PATH`).
- New `geoip` module mirroring `tor_list::init` / `get` — loads
  the mmdb file at startup, exposes `country_for(ip) -> Option<String>`.
- `derive_country_from_ip` consults it when set, falls back to
  the current `unknown` placeholder otherwise.

**Definition of done:** when the file is present, country signal
populates correctly on logins; when absent, no regression.
~80 LoC + the `maxminddb` crate dependency.

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
