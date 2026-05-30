# Dilla — Backend Hardening (Step 5)

**Scope:** `/Users/thim/Repositories/dilla-chat/`
**Branch:** `feat/mesh-redesign`
**Date applied:** 2026-05-21
**Inputs:** `.security-hardening/03-architecture-review.md`, `.security-hardening/04-critical-fixes.md`
**Predecessor:** Step 4 closed the P0 critical findings (VULN-001/-003/-004/-005/-006/-007/-008/-009/-016/-017/-018/-019/-021/-024 + partial -002).

This step closes the medium-severity items that step 4 did not touch — H1..H12 in the original brief. Twelve conventional commits; no `Co-Authored-By` lines per the user's global instructions. Server restart verified after every commit (`DILLA_INSECURE=true DILLA_BROWSER_LOG_FORWARD=true DILLA_DATA_DIR=/Users/thim/Repositories/dilla-chat/tmp-dev-data ...`); `/api/v1/health` returns 200 throughout.

---

## 1. Summary table

| # | What | Findings | Files touched | Commit | Tests added |
|---|---|---|---|---|---|
| H1 | Rate-limit protected router + per-route stricter limits | VULN-011 | `server-rs/src/api/mod.rs`, `server-rs/src/config.rs` | `8a52367` | — (uses tower_governor; existing limiter pattern) |
| H2 | JWT aud/iss/jti + revocation table + 24h refresh + weak-passphrase refusal | VULN-012, AUTH-WEAK-1 | `server-rs/src/auth.rs`, `server-rs/src/main.rs`, `server-rs/src/db/mod.rs`, `server-rs/src/db/jwt_revocation_queries.rs` (new), `server-rs/migrations/027_jwt_revocations.sql` (new), `server-rs/src/api/auth_handlers.rs`, `server-rs/src/api/mod.rs` | `85db447` | 3 new `db::jwt_revocation_queries::tests` (`revoke_and_check_revoked`, `expired_revocation_treated_as_unrevoked`, `gc_drops_expired_rows`), 4 new `auth::tests` (`test_jwt_contains_jti_aud_iss`, `test_jwt_validates_with_matching_node_name`, `test_jwt_rejected_when_aud_mismatches`, `test_revoke_token_blocks_validation`), refresh-expiry test updated to 24 h |
| H3 | Username-enumeration mitigation on `/auth/verify` | AUTH-ENUM-1 | `server-rs/src/api/auth_handlers.rs` | `55ab928` | — (handler-level; relies on existing challenge tests) |
| H4 | Per-WS subscription cap + idle-pong reaper | VULN-023, WS-AMP-1 | `server-rs/src/ws/client.rs`, `server-rs/src/ws/hub.rs` | `f3550a0` | — (hub helper trivially observable; pre-existing test rot blocks full ws integ tests) |
| H5 | Audit-log message edit/delete (REST + WS) | MSG-AUDIT-1 | `server-rs/src/api/messages.rs`, `server-rs/src/ws/handlers/message.rs` | `d5638b6` | — (handler-level; integration tests blocked on pre-existing test rot) |
| H6 | `identity_blob` 64 KiB cap + clamp `?limit` to 200 on messages/dm/threads | VULN-013, MSG-DOS-1 | `server-rs/src/api/users.rs`, `server-rs/src/api/messages.rs`, `server-rs/src/api/dms.rs`, `server-rs/src/api/threads.rs`, `server-rs/src/error.rs` | `201099d` | — (handler-level) |
| H7 | Refuse `ws://` peers unless INSECURE + always-warn on empty join_secret | VULN-014, VULN-021 (final) | `server-rs/src/federation/transport.rs`, `server-rs/src/federation/mod.rs`, `server-rs/src/main.rs` | `e233c37` | 2 new `federation::transport::tests` (`test_build_peer_url_ws_refused_by_default`, `test_build_peer_url_ws_allowed_when_insecure`); existing passthrough test removed |
| H8 | Browser-log: default off, rate-limit, ANSI strip, auth-attach user_id | VULN-010 | `server-rs/src/api/debug.rs`, `server-rs/src/api/mod.rs`, `server-rs/src/config.rs` | `53811d1` | — (handler-level; manually verified ANSI stripping with proper JSON escape) |
| H9 | SecretString-wrap SQLCipher key + load-from-file | DB-MEM-1 | `server-rs/Cargo.toml`, `server-rs/src/db/mod.rs`, `server-rs/src/config.rs`, `server-rs/src/main.rs`, `.env.example` | `726e85a` | — (Database::open is exercised by every test that opens a db) |
| H10 | Centralised policy decision module + initial migration | R-21 (architecture) | `server-rs/src/policy/mod.rs` (new), `server-rs/src/main.rs`, `server-rs/src/ws/client.rs` | `6702f33` | 3 new `policy::tests` (`deny_for_unknown_channel`, `federation_empty_peer_denied`, `log_decision_does_not_panic_on_allow`) |
| H11 | SSRF guard helper `safe_outbound_url` + wired into Giphy embed | OUT-SSRF-1 | `server-rs/src/api/outbound.rs` (new), `server-rs/src/api/mod.rs`, `server-rs/src/api/gif.rs` | `55d2aff` | 9 new `api::outbound::tests` covering RFC-1918, loopback, link-local, AWS metadata, carrier-grade NAT, public v4, IPv6 ULA/loopback/link-local, https-only enforcement, IPv6 bracket parsing, and `safe_outbound_url` integration paths |
| H12 | Per-team upload-bytes quota | UPL-DOS-1 | `server-rs/migrations/028_team_upload_quota.sql` (new), `server-rs/src/db/mod.rs`, `server-rs/src/db/team_queries.rs`, `server-rs/src/api/uploads.rs`, `server-rs/src/api/gif.rs`, `server-rs/src/config.rs` | `587ae67` | — (DB column + helpers; quota path is checked at upload/embed/delete) |

`cargo build --release` clean after every commit. `cargo test` cannot run end-to-end because of the pre-existing test-builder rot called out in step 4's section 4 (legacy test mods construct `db::User` / `db::Channel` / `UpdateChannelRequest` without the fields added in migrations 016-023). Every new test added in this step compiles against the current struct shapes and will run as soon as the maintainer un-rots the legacy builders.

---

## 2. Per-item detail

### H1 — Rate limiting on protected endpoints (commit `8a52367`)

**Files:**
- `/Users/thim/Repositories/dilla-chat/server-rs/src/api/mod.rs` (lines 60-100 limiter wiring, 148, 173-178, 273-277, 339-343 route layers, 376-380 protected-router layer)
- `/Users/thim/Repositories/dilla-chat/server-rs/src/config.rs` (new `ratelimit_per_second`, `ratelimit_burst`, `upload_quota_per_team_gb`, `db_passphrase_file` fields)

**What changed.**
- New `protected_rate_config` (burst 60 / 30 per second, configurable via `DILLA_RATELIMIT_BURST` / `DILLA_RATELIMIT_PER_SECOND`) wraps the protected router. `auth_middleware` still runs first; the limiter is the back-stop for everything behind it.
- New `strict_rate_config` (burst 10 / 5 per second) is attached as `route_layer` on three routes specifically:
  - `POST /api/v1/teams/{team_id}/upload`
  - `POST /api/v1/teams/{team_id}/gif/embed`
  - `GET /api/v1/prekeys/{user_id}`

Both limiters spawn a `retain_recent` GC thread at startup (matches the pre-existing `auth_rate_limiter` cleanup pattern).

**Why.** The auth routes had a per-IP limiter but the protected surface didn't — a single hostile client could pull arbitrary REST traffic at line rate against the JWT-validated endpoints. The three "strict" routes are the ones with non-trivial side effects (disk write, outbound HTTP fetch, OTPK consumption); their tighter limit slows enumeration sweeps to a crawl.

**Breaking change risk.** Low. The defaults are intentionally permissive; the dev pattern is unaffected. Operators with high-traffic deployments can dial them via env var.

### H2 — JWT aud/iss/jti + revocation list (commit `85db447`)

**Files:**
- `/Users/thim/Repositories/dilla-chat/server-rs/src/auth.rs` (Claims/RefreshClaims gain `jti/aud/iss`; new `validate_jwt_full`, `revoke_token`, `with_node_name` constructor)
- `/Users/thim/Repositories/dilla-chat/server-rs/src/db/jwt_revocation_queries.rs` (new — `revoke_jti`, `is_revoked`, `gc_revoked_jtis`)
- `/Users/thim/Repositories/dilla-chat/server-rs/migrations/027_jwt_revocations.sql` (new)
- `/Users/thim/Repositories/dilla-chat/server-rs/src/db/mod.rs` (register new migration + module)
- `/Users/thim/Repositories/dilla-chat/server-rs/src/api/auth_handlers.rs` (new `logout` handler)
- `/Users/thim/Repositories/dilla-chat/server-rs/src/api/mod.rs` (wire `POST /api/v1/auth/logout`)
- `/Users/thim/Repositories/dilla-chat/server-rs/src/main.rs` (new `enforce_jwt_secret_strength`; `with_node_name` wiring; hourly GC task for revoked jtis)

**What changed.**
- Every issued token now carries `aud = iss = node_name` and a random UUID `jti`. `validate_jwt` enforces `aud`/`iss` against the local `node_name` whenever it's non-empty (empty stays permissive for tests / pre-rollout tokens). `is_revoked(jti)` is checked after the signature check.
- Refresh expiry reduced from 7 days to 24 hours.
- `POST /api/v1/auth/logout` revokes the bearer token via `db::revoke_jti(jti, exp)` so the kill switch is instant.
- `enforce_jwt_secret_strength` refuses startup when `DILLA_DB_PASSPHRASE` is empty (and `DILLA_JWT_SECRET` not set) unless `DILLA_INSECURE=true`; refuses sub-32-byte passphrases too. The dev pattern keeps working with a loud warn.

**Why.** Before this commit a stolen JWT lived to natural expiry with no kill switch; a token minted for one node also validated at any other node sharing the HKDF-derived secret; the JWT signing key derived from an empty passphrase was an ephemeral random secret that didn't survive a restart.

**Breaking change risk.** Medium. Operators who relied on a 7-day refresh window will see logins survive only 24 h. Operators with empty `DILLA_DB_PASSPHRASE` and `DILLA_INSECURE=false` will see the new startup-refusal — same shape as the H7 / VULN-001 refusal that already shipped in step 4.

### H3 — Username enumeration mitigation (commit `55ab928`)

**File:** `/Users/thim/Repositories/dilla-chat/server-rs/src/api/auth_handlers.rs::verify` (lines 76-100).

**What changed.** Both failure modes — invalid signature, no user row for this public key — now return the identical `Unauthorized("invalid signature")` response. The DB lookup runs unconditionally so the timing profile stays consistent regardless of which side failed.

**Why.** Previously a successful signature verification followed by a missing user row returned a distinct `"no account found for this public key — register first"` error, letting callers probe the DB for registered public keys.

**Note about challenge endpoint.** Re-read of the spec: the challenge endpoint takes `public_key` (not a username), so it doesn't actually leak registration state — a challenge is generated regardless. The leak surfaced in `verify`; mitigated there.

### H4 — WS subscription cap + idle-pong reaper (commit `f3550a0`)

**Files:**
- `/Users/thim/Repositories/dilla-chat/server-rs/src/ws/client.rs` (new `MAX_SUBSCRIPTIONS_PER_CLIENT = 200`; refactored read pump to `tokio::select!` with `sleep_until` branch)
- `/Users/thim/Repositories/dilla-chat/server-rs/src/ws/hub.rs` (new `Hub::client_subscription_count`)

**What changed.**
1. Per-client cap of 200 active channel subscriptions. Beyond the cap, `channel:join` is silently dropped with a `warn` log.
2. Read pump refactored to `tokio::select!` with a `tokio::time::sleep_until(last_pong + PONG_WAIT)` branch so idle ghost connections are reaped even when no frame arrives (the previous loop only checked `PONG_WAIT` after a frame, missing the half-open-TCP case).

**Why.** A connected client could subscribe to an unbounded number of channels and serve as a free amplification target for `broadcast_to_channel`. Half-open TCP sockets piled up indefinitely with no read activity.

### H5 — Audit-log message edit/delete (commit `d5638b6`)

**Files:**
- `/Users/thim/Repositories/dilla-chat/server-rs/src/api/messages.rs::edit` and `::delete_msg`
- `/Users/thim/Repositories/dilla-chat/server-rs/src/ws/handlers/message.rs::handle_message_edit` and `::handle_message_delete`

**What changed.** Every successful edit/delete now writes an `audit_events` row with action `"message.edit"` / `"message.delete"`, `actor_user_id` = caller, `target_kind = "message"`, `target_id` = message id, and a JSON details payload carrying `{ channel_id, edited_at | deleted_at }`.

**Idempotence.**
- Edit: same-content no-op edits skip the audit insert so the log doesn't bloat on retries.
- Delete: a pre-check refuses to soft-delete an already-deleted row, short-circuiting before the audit insert.

The WS handlers resolve `team_id` via `get_channel_by_id` so the audit row is correctly scoped to a team (DM-channel edits skip the audit row — `dm_channels` has its own audit story).

### H6 — Identity blob 64 KiB cap + paginate listings server-side (commit `201099d`)

**Files:**
- `/Users/thim/Repositories/dilla-chat/server-rs/src/api/users.rs::put_identity_blob` — 64 KiB cap with new `AppError::PayloadTooLarge` → HTTP 413.
- `/Users/thim/Repositories/dilla-chat/server-rs/src/error.rs` — new `PayloadTooLarge(String)` variant.
- `/Users/thim/Repositories/dilla-chat/server-rs/src/api/messages.rs` — `pub(crate) const MAX_PAGE_LIMIT = 200`; `list` clamps to it.
- `/Users/thim/Repositories/dilla-chat/server-rs/src/api/dms.rs::list_messages` — clamps to `MAX_PAGE_LIMIT`.
- `/Users/thim/Repositories/dilla-chat/server-rs/src/api/threads.rs::list_messages` — clamps to `MAX_PAGE_LIMIT`.

**Why.** The `identity_blob` upload was unbounded; an attacker could pin arbitrary-sized rows in the DB. Pagination caps used to be `clamp(1, 100)` on a per-handler basis; widened to a single shared 200 cap and made the server authoritative (clients may pass any number; server silently clamps).

**Note.** The reaction list endpoint doesn't take a `limit` (returns the full reaction set on a single message), so no change there.

### H7 — Refuse `ws://` peers unless INSECURE; always-warn on empty join_secret (commit `e233c37`)

**Files:**
- `/Users/thim/Repositories/dilla-chat/server-rs/src/federation/transport.rs` — new `build_peer_url_with_insecure(addr, insecure)`; `Transport` gains an `insecure` field via new `Transport::with_settings(secret, insecure)` constructor; `connect_to_peer` early-returns when the URL is plain `ws://` and `insecure=false`.
- `/Users/thim/Repositories/dilla-chat/server-rs/src/federation/mod.rs` — `MeshConfig` gains `insecure`; `MeshNode::new` propagates to `Transport`.
- `/Users/thim/Repositories/dilla-chat/server-rs/src/main.rs::init_federation_mesh` — wires `cfg.insecure`; emits a loud always-on warning at startup when peers are configured AND `join_secret` is empty (the in-process HMAC key is then an ephemeral random fallback).

**Why.** Step 4 only panicked on the empty-secret + peers + `!insecure` combination. With `insecure=true` the operator could quietly run with a per-restart random key. This commit always logs a `tracing::warn!` in that case so the operator can see it on every restart.

### H8 — Browser-log relay hardening (commit `53811d1`)

**Files:**
- `/Users/thim/Repositories/dilla-chat/server-rs/src/api/debug.rs` — new `strip_ansi`; handler signature changed from `Json<BrowserLogBatch>` to raw `Request` so we can inspect the `Authorization` header and conditionally attach the JWT subject.
- `/Users/thim/Repositories/dilla-chat/server-rs/src/api/mod.rs` — `route_layer(GovernorLayer { config: auth_rate_config.clone() })` on `POST /api/v1/debug/browser-log`.
- `/Users/thim/Repositories/dilla-chat/server-rs/src/config.rs` — `browser_log_forward` now defaults to `false` regardless of `DILLA_INSECURE`.

**What changed.**
1. Default `browser_log_forward = false`. The dev pattern (`DILLA_BROWSER_LOG_FORWARD=true`) keeps working but we no longer implicitly enable it via the insecure flag.
2. Same auth-route rate limit (10 burst / 6 per second per IP) applied as a `route_layer`.
3. `strip_ansi` pass on session, tag, user, message before they hit `tracing`. Works on the char iterator so multi-byte UTF-8 survives intact; drops CSI sequences and C0 control chars except common whitespace.
4. When the caller carries a valid `Authorization: Bearer …` the handler extracts the JWT subject via `auth.validate_jwt(token)` and prefers it over the client-supplied `user` field; when absent the span is marked `unauthenticated_browser_log=true` for filtering.

Manual smoke test confirmed `[31m...[0m hello` lands in the tracing pipeline as plain `evil red hello`.

### H9 — SQLCipher key zeroize + load from file (commit `726e85a`)

**Files:**
- `/Users/thim/Repositories/dilla-chat/server-rs/Cargo.toml` — `secrecy = "0.10"` direct dep.
- `/Users/thim/Repositories/dilla-chat/server-rs/src/db/mod.rs` — `open_connection` takes `&SecretString` instead of `&str`; `Database::open` wraps the passphrase in a single `SecretString` reused across write + read connection opens. SecretString's drop impl zeroizes the buffer.
- `/Users/thim/Repositories/dilla-chat/server-rs/src/config.rs` — new `db_passphrase_file` field.
- `/Users/thim/Repositories/dilla-chat/server-rs/src/main.rs` — new `load_db_passphrase_from_file` runs before any consumer sees the passphrase; takes precedence over the env var.
- `/Users/thim/Repositories/dilla-chat/.env.example` — documents `DILLA_DB_PASSPHRASE_FILE`.

**Why.** Step 4 already addressed the env-var leak via the bootstrap-token-file change. This step extends the discipline to the DB passphrase: the cleartext never sits in the process memory for longer than the connection open, and operators can keep it off `ps` / `/proc/{pid}/environ` by switching to file mode.

### H10 — Policy decision module (commit `6702f33`)

**Files:**
- `/Users/thim/Repositories/dilla-chat/server-rs/src/policy/mod.rs` (new)
- `/Users/thim/Repositories/dilla-chat/server-rs/src/main.rs` — `mod policy`.
- `/Users/thim/Repositories/dilla-chat/server-rs/src/ws/client.rs::user_can_subscribe_to_channel` — delegates to `policy::can_subscribe_channel` + `policy::log_decision`.

**What it provides.**
- `Decision { Allow, Deny(&'static str) }` — static reason strings keep the deny space small.
- `can_subscribe_channel`, `can_send_message`, `can_manage_team`, `can_read_attachment`, `can_call_federation` — initial API per the spec.
- `log_decision(decision, ctx)` traces every Deny under `target="policy"` with `user_id`, `target_kind`, `target_id`, `reason`, `ctx_reason`.

**Migration scope.** Only the WS subscribe path was migrated in this commit to keep diffs surgical. The new module is dead-code-marked on `#[allow(dead_code)]` for the four functions not yet wired in; future commits can migrate REST handlers / attachment-download / etc. without changing behavior. The migration of `ws::client::user_can_subscribe_to_channel` preserves semantics (same channel-vs-DM-vs-unknown dispatch).

### H11 — SSRF guard on outbound HTTP (commit `55d2aff`)

**Files:**
- `/Users/thim/Repositories/dilla-chat/server-rs/src/api/outbound.rs` (new) — `safe_outbound_url`, `is_public_ip`, tiny `url_lite` parser.
- `/Users/thim/Repositories/dilla-chat/server-rs/src/api/mod.rs` — `pub mod outbound`.
- `/Users/thim/Repositories/dilla-chat/server-rs/src/api/gif.rs::embed` — calls `safe_outbound_url` before the Giphy fetch and uses the returned URL.

**What it provides.**
- Refuses non-https URLs.
- Resolves the hostname via `tokio::net::lookup_host` and rejects when ANY resolved address fails `is_public_ip` — defends against DNS rebinding pointing `media.giphy.com` at 127.0.0.1, 169.254.169.254, RFC-1918, etc.
- `is_public_ip` rejects loopback, link-local (incl. AWS metadata), RFC 1918, RFC 4193 IPv6 ULA, carrier-grade NAT (100.64/10), documentation, broadcast, multicast, unspecified.

The pre-existing `is_giphy_url` host pinning stays as belt; `safe_outbound_url` is the network-layer braces.

### H12 — Per-team disk-usage quota on uploads (commit `587ae67`)

**Files:**
- `/Users/thim/Repositories/dilla-chat/server-rs/migrations/028_team_upload_quota.sql` (new) — adds `teams.upload_bytes_used` and backfills from the existing attachments table.
- `/Users/thim/Repositories/dilla-chat/server-rs/src/db/team_queries.rs` — new `get_team_upload_bytes_used`, `add_team_upload_bytes` (MAX(0, …) clamp).
- `/Users/thim/Repositories/dilla-chat/server-rs/src/db/mod.rs` — register migration 028.
- `/Users/thim/Repositories/dilla-chat/server-rs/src/api/uploads.rs::upload` — pre-check before disk write, bump on attachment insert. `::delete_attachment` refunds on delete.
- `/Users/thim/Repositories/dilla-chat/server-rs/src/api/gif.rs::embed` — pre-check before Giphy fetch, post-fetch quota recheck (catches the in-between flip), bump on insert.

**Config.** New env var `DILLA_UPLOAD_QUOTA_PER_TEAM_GB` (default 10 GiB). Setting it to 0 disables enforcement.

Over-quota returns HTTP 413 PayloadTooLarge.

---

## 3. New configuration variables

| Env var | Default | What it does | Safety implication |
|---|---|---|---|
| `DILLA_RATELIMIT_PER_SECOND` | 30 | Per-IP rate for the protected router | Lower = stricter; tune up for high-traffic teams. |
| `DILLA_RATELIMIT_BURST` | 60 | Per-IP burst for the protected router | Same. |
| `DILLA_UPLOAD_QUOTA_PER_TEAM_GB` | 10 | Per-team upload quota in GiB | Set to 0 to disable; uploads past the cap → HTTP 413. |
| `DILLA_DB_PASSPHRASE_FILE` | _empty_ | Read SQLCipher passphrase from disk | Takes precedence over `DILLA_DB_PASSPHRASE`; recommended `0400`. Keeps the secret out of `ps` / `/proc/{pid}/environ`. |
| `DILLA_BROWSER_LOG_FORWARD` | `false` (was previously `DILLA_INSECURE`-coupled) | Enable the browser-log relay | Default-off now regardless of INSECURE; explicit opt-in required. |
| `POST /api/v1/auth/logout` | n/a | Revoke caller's bearer JWT | New endpoint, idempotent. |

---

## 4. Outstanding items

- **Policy module migration.** Only the WS subscribe path was rewritten to call `policy::can_subscribe_channel`. REST handlers (`api/messages.rs`, `api/dms.rs`, `api/threads.rs`, etc.) still call the underlying `db::user_can_access_channel` directly. The policy module's `Allow / Deny` log-on-deny hook is in place; future commits can migrate without touching call-site semantics.
- **Attachment uploader provenance.** Step 4's open item — adding `attachments.uploader_id` so the 1-hour grace window for unlinked attachments can tighten from "any team member" to "the uploader" — is unchanged. `policy::can_read_attachment` deliberately abstains on unlinked attachments so the new policy module doesn't get in the way of that future migration.
- **Full VULN-002 federation redesign (Phase 3).** Still deferred per step 4. This step did not touch the federation event signing or the `merge_*` last-writer-wins semantics; the `policy::can_call_federation` stub is a hook point for the future per-node Ed25519 trust store.
- **Pre-existing test rot.** Same as step 4. The new tests added in this step compile against current struct shapes and will run as soon as the maintainer un-rots the legacy `User` / `Channel` / `UpdateChannelRequest` test builders.
- **`DILLA_BROWSER_LOG_FORWARD` doc surface.** The handler's default flipped from "follows DILLA_INSECURE" to "always-off-by-default". Existing dev pattern in `CLAUDE.md` already sets the env var explicitly so this is invisible in the dev loop, but the project documentation should be updated separately to reflect the new default. Not done in this commit set because the user said "always do iac unless i tell you so" — and the dev pattern in CLAUDE.md already passes `DILLA_BROWSER_LOG_FORWARD=true`.

---

## 5. Regression notes

- **JWT refresh expiry.** Anyone with an outstanding refresh token will see it expire after 24 hours instead of 7 days. The first long-tail visible symptom will be the client prompting to re-login a day later instead of weekly.
- **`POST /api/v1/auth/logout` route.** Net-new; existing clients ignore it.
- **Rate limits.** The protected-router limiter is generous (burst 60, 30 per second per IP). A test that hammers the server from a single IP at >60 RPS will see 429s; tune via env var if needed.
- **WS subscription cap of 200.** A power user with WS connections to 30 teams each holding ~5 channels still has 50% headroom. A pathological dashboard scraping every team would notice.
- **Upload quota default 10 GiB per team.** Operators with existing large attachment stores will see migration 028 backfill `upload_bytes_used` correctly; new uploads start counting from there. Set `DILLA_UPLOAD_QUOTA_PER_TEAM_GB=0` to disable if you don't want it.
- **Browser-log default off.** Operators using the relay outside the documented `DILLA_BROWSER_LOG_FORWARD=true` path will silently stop receiving logs. The handler's 204-on-disabled response is preserved so client behavior doesn't change otherwise.
- **JWT secret strength refusal.** Same shape as step 4's TLS refusal — set `DILLA_INSECURE=true` to acknowledge, or fix the passphrase. The dev pattern in CLAUDE.md (which sets `DILLA_INSECURE=true`) keeps working.
- **`ws://` peer refusal.** New: federation peers must be `wss://` unless `DILLA_INSECURE=true`. The dev pattern keeps working.
- **Audit log volume.** Every message edit / delete now writes one row. Already-deleted re-delete and same-content re-edit are skipped (idempotence). For a chatty team this materially increases `audit_events` growth — backed by migration 013's schema, which has no retention sweep yet; consider adding one if disk-usage on `audit_events` becomes a concern.
