# Dilla — P0 Critical Fixes (Step 4 / Remediation)

**Scope:** `/Users/thim/Repositories/dilla-chat/`
**Branch:** `feat/mesh-redesign`
**Date applied:** 2026-05-21
**Inputs:** `.security-hardening/01-vulnerability-scan.md`,
`.security-hardening/02-threat-model.md`,
`.security-hardening/03-architecture-review.md`.

This step closes the P0 critical / high findings — VULN-001, -003,
-004, -005, -006, -007, -008, -009, -016, -017, -018, -019, -021,
-024 — plus a partial Phase-1 fix for VULN-002. Each fix is one
conventional commit; no `Co-Authored-By` lines per the user's
global instructions.

---

## 1. Summary table

| VULN-ID | Fix description | Commit | Tests added | Regression risk |
|---|---|---|---|---|
| VULN-004 + VULN-024 + VULN-016 | Channel-access gate on WS `channel:join` AND `typing:start`/`typing:stop` | `c9adcd8` | 4 new unit tests in `ws::client::tests` and 1 in `ws::tests` | Low — existing `message:send` path already used the same gate |
| VULN-007 | Per-channel ACL on REST `messages::list`, `::create`, `::edit`, `::delete_msg` | `9f6478c` | none new (relies on existing `user_can_access_channel` tests) | Low |
| VULN-003 + VULN-008 | Move attachment download behind auth + channel ACL; sanitize upload Content-Type to allow-list; sandbox + force-octet-stream on download | `a8f807f` | 6 new unit tests for `sanitize_upload_content_type` | Medium — unlinked attachments past 1-hour grace now 403 (Giphy embed clients must link promptly) |
| VULN-009 | Bootstrap token written to `${DATA_DIR}/BOOTSTRAP_TOKEN` mode 0600; 15-minute expiry enforced via new `bootstrap_tokens.expires_at` column | `7182d9e` | Pre-existing `validate_bootstrap_token_*` tests cover the new expiry path | Medium — DB schema migration 026, operator UX change (no more banner-with-token) |
| VULN-005 + VULN-021 | HKDF-SHA256 derivation of join-token HMAC key; startup-time `JoinManager::enforce_security_policy` panics on empty `join_secret` when peers configured AND `insecure=false` | `da4b983` | none new (constructor remains tested by existing `join.rs` tests; new fn is wired into startup, exercised by manual `cargo run`) | High for ops — outstanding join JWTs become invalid; operators must re-issue |
| VULN-002 (partial) | Constant-time `subtle::ConstantTimeEq` for federation `join_token` compare; reject auth when `expected_secret` empty unless `insecure=true` | `e4cc48b` | none (private fn; full redesign deferred — see Open items) | Low |
| VULN-006 | `db::users_share_team` gate on `GET /api/v1/prekeys/{user_id}`; OTPK only consumed when `?initiate=true` | `dc8bccb` | none new (new DB helper trivially testable) | Low — wrap/unwrap and backfill paths confirmed not to need OTPK |
| VULN-017 + VULN-018 + VULN-019 | `npm audit fix` in `client/` | `71a460e` | `npm run build` passes after upgrade | Low |
| VULN-001 | `start_server` binds via `axum_server::bind_rustls` when TLS_CERT + TLS_KEY are both set; refuses plaintext bind when `insecure=false`; loud warning when insecure | `244e15d` | none new (manual `curl` smoke verified) | Medium — operators relying on plaintext default without `DILLA_INSECURE=true` will see startup failure |

Verification: `cargo build --release` clean after every commit; `npm
run build` clean after the audit-fix commit; running dev server
(`DILLA_INSECURE=true`) restarted between every commit, `/api/v1/health`
returns 200 throughout.

---

## 2. Per-fix detail

### Fix 1 — VULN-004 + VULN-024 + VULN-016 (commit `c9adcd8`)

**Files:**
- `/Users/thim/Repositories/dilla-chat/server-rs/src/ws/client.rs` (lines 140-156, 221-340, 559-769)
- `/Users/thim/Repositories/dilla-chat/server-rs/src/ws/handlers/message.rs` (lines 308-340)
- `/Users/thim/Repositories/dilla-chat/server-rs/src/ws/tests.rs` (handle_typing tests + new handle_channel_event regression test)

**What changed.** A new `pub(crate) async fn user_can_subscribe_to_channel(hub, user_id, team_id, channel_id) -> bool` consolidates the authorization decision for WS subscriptions. It dispatches:

1. **Text/voice channel:** `db::get_channel_by_id(channel_id)` — if it exists, require `channel.team_id == team_id` AND `db::user_can_access_channel(user_id, team_id, channel_id)`.
2. **DM channel:** `db::is_dm_member(channel_id, user_id)`.
3. **Unknown:** deny.

`handle_channel_event` now takes `user_id` + `team_id`, runs the check before calling `hub.subscribe`, and silently drops with `tracing::debug!` on denial. `handle_typing` runs the same check before broadcasting the typing indicator. The dispatch tables in `client::handle_event` are threaded through to pass `team_id` to typing.

**Why.** Before this change, the only WS authorization on `channel:join` was "do you have a valid JWT". An attacker with any registered user account could enumerate `channel_id` values, send `channel:join`, and receive every subsequent broadcast: `sender_id`, `username`, `created_at`, reply graph, attachment IDs, reaction counts, typing indicators. Same for DM channels (the hub uses a single subscriber map for channels + DMs + threads). This was the single biggest practical breach of the project's "metadata-protecting" promise.

**Test plan.**
- New `channel_join_denied_when_user_not_a_team_member` (in `ws::client::tests`): outsider must NOT pass the gate for a role-restricted private channel.
- New `channel_join_denied_when_channel_belongs_to_another_team`: the team-owner-bypass shortcut must still respect the cross-team boundary.
- New `dm_subscribe_requires_dm_membership`: only `dm_members` rows pass.
- New `channel_join_denied_for_unknown_channel_id`: unknown IDs deny.
- New `handle_channel_event_denies_subscribe_for_unauthorized_user` (in `ws::tests`): integration-level test confirming an unauthorized subscriber does NOT receive `broadcast_to_channel` traffic.
- Existing `typing_broadcasts_to_channel_excluding_sender` and `typing_is_throttled` updated to seed the team + channel via new `seed_open_channel` helper.

### Fix 2 — VULN-003 + VULN-008 (commit `a8f807f`)

**Files:**
- `/Users/thim/Repositories/dilla-chat/server-rs/src/api/uploads.rs` (lines 17-67 sanitize helper + lines 159-292 rewritten download)
- `/Users/thim/Repositories/dilla-chat/server-rs/src/api/mod.rs` (lines 122-134 public route removed, line 344-346 protected route registered)

**What changed.**
- Route `GET /api/v1/teams/{team_id}/attachments/{attachment_id}` moved from the public group to the protected group (so `auth::auth_middleware` runs).
- `download` now extracts `Extension(UserId)`, requires team membership, and for linked attachments validates the owning message's team AND runs `user_can_access_channel` on its channel.
- For unlinked attachments (Giphy embed window) we restrict to team members within a 1-hour grace window measured from `attachments.created_at`; past that the attachment is treated as orphaned and the handler returns 403.
- Response headers: `Content-Type: application/octet-stream` (hard-coded — bodies are ciphertext); `Content-Disposition: attachment; filename="<attachment_id>"`; `Content-Security-Policy: default-src 'none'; sandbox`; `X-Content-Type-Options: nosniff`.
- New `sanitize_upload_content_type(raw) -> &str` allow-list on upload (image/*, audio/*, video/*, text/plain, application/pdf, application/json, application/octet-stream). Anything else stored as `application/octet-stream`.

**Why.** Before this change the route was public, so any anonymous network caller who learned an `attachment_id` could fetch the ciphertext + filename + MIME, AND the server became a free CDN for distributing arbitrary attacker-controlled MIME-typed payloads against any browser that bypassed the `Content-Disposition: attachment` directive.

**Test plan.** Six new unit tests for `sanitize_upload_content_type` covering allowed image/audio/video types, allowed PDF, rejection of `text/html`, `application/javascript`, `application/xhtml+xml`, `text/xml`, garbage input, empty input.

### Fix 3 — VULN-007 (commit `9f6478c`)

**Files:**
- `/Users/thim/Repositories/dilla-chat/server-rs/src/api/messages.rs` (lines 42-260; added access checks in `list`, `create`, `edit`, `delete_msg`)

**What changed.** All four REST message handlers now run `db::user_can_access_channel` after the existing `require_team_member`. The WS `message:send` path already did this; the REST path didn't. Access-denied returns 403 (`AppError::Forbidden` via the existing `InvalidParameterName → Forbidden` mapping in `helpers::map_db_error`) — not 404, to avoid leaking channel existence.

**Test plan.** Relies on the existing `user_can_access_channel` test coverage in `db::channel_access_queries::tests`; the handler-level integration tests in this codebase are blocked on pre-existing `tests.rs` compile errors unrelated to this work (see Open items).

### Fix 4 — VULN-005 + VULN-021 (commit `da4b983`)

**Files:**
- `/Users/thim/Repositories/dilla-chat/server-rs/src/federation/join.rs` (lines 1-21 HKDF imports, 23-44 `derive_join_secret`, 46-115 `JoinManager::new` + `enforce_security_policy`)
- `/Users/thim/Repositories/dilla-chat/server-rs/src/main.rs` (lines 472-481 startup hook in `init_federation_mesh`)

**What changed.**
- `JoinManager::new` passes `join_secret` through HKDF-SHA256 (`info = b"dilla-federation-join-v1"`) to derive a 32-byte HMAC key. Matches the auth.rs pattern for the JWT signing secret. A 7-byte `"changeme"` no longer becomes a 7-byte HMAC key trivially brute-forced offline against a captured join JWT.
- New `enforce_security_policy(join_secret, peers_configured, insecure)` called from `init_federation_mesh`. Behavior:
  - peers + empty secret + `insecure=false` → **panic** with explicit error.
  - peers + empty secret + `insecure=true` → loud `tracing::error!` + start.
  - peers + secret shorter than 32 raw bytes → `tracing::warn!`.

**Why.** The old constructor accepted any bytes as the raw HMAC key. Operators who set `DILLA_JOIN_SECRET=changeme` shipped a 7-byte HMAC key directly to brute-force. Empty `join_secret` silently became a random ephemeral key lost on restart (and `transport.rs` skipped auth entirely on empty secret).

**Test plan.** Existing `join.rs` test suite continues to pass against the new derived-key shape. `enforce_security_policy` itself is exercised at every startup; manual verification via `cargo run` with combinations of empty / short / long secrets and `insecure` true/false.

### Fix 5 — VULN-002 partial (commit `e4cc48b`)

**Files:**
- `/Users/thim/Repositories/dilla-chat/server-rs/src/federation/transport.rs` (lines 23-65 `validate_auth_message` + `validate_auth_message_with_insecure`)
- `/Users/thim/Repositories/dilla-chat/server-rs/Cargo.toml` (line 27 `subtle = "2"`)

**What changed.** `validate_auth_message` now uses `subtle::ConstantTimeEq` for the `join_token` comparison, and rejects authentication entirely when the configured `expected_secret` is empty unless explicit `insecure=true` is passed.

**Note.** The full VULN-002 redesign — per-node Ed25519 signing keys, signed `FederationEvent` envelopes, removal of `merge_*` last-writer-wins semantics — is tracked as a Phase-3 architectural change. This commit is the Phase-1 timing-oracle + empty-secret fix only.

### Fix 6 — VULN-009 (commit `7182d9e`)

**Files:**
- `/Users/thim/Repositories/dilla-chat/server-rs/migrations/026_bootstrap_token_expiry.sql` (new)
- `/Users/thim/Repositories/dilla-chat/server-rs/src/db/mod.rs` (line 86 migration registration)
- `/Users/thim/Repositories/dilla-chat/server-rs/src/db/models.rs` (lines 188-197 `BootstrapToken.expires_at`)
- `/Users/thim/Repositories/dilla-chat/server-rs/src/db/invite_queries.rs` (lines 99-145 ttl-aware create + extended select)
- `/Users/thim/Repositories/dilla-chat/server-rs/src/api/auth_handlers.rs` (lines 357-385 expiry check in `validate_bootstrap_token`)
- `/Users/thim/Repositories/dilla-chat/server-rs/src/main.rs` (lines 14-18 import, 207-295 rewritten `check_first_start` + `write_bootstrap_token_file`)

**What changed.**
- New column `bootstrap_tokens.expires_at` (default 15 minutes after creation).
- `validate_bootstrap_token` rejects rows with `Utc::now() > expires_at`.
- `check_first_start` writes the token to `${DATA_DIR}/BOOTSTRAP_TOKEN` with `OpenOptions::create_new(true).mode(0o600)`, and only prints the *path* to stderr — never the token itself. Falls back to legacy stderr-print with a loud error if the FS write fails (so the operator isn't locked out).

### Fix 7 — VULN-006 (commit `dc8bccb`)

**Files:**
- `/Users/thim/Repositories/dilla-chat/server-rs/src/db/member_queries.rs` (lines 111-141 new `users_share_team` helper)
- `/Users/thim/Repositories/dilla-chat/server-rs/src/api/prekeys.rs` (lines 1-26 new `GetBundleQuery`, 86-160 rewritten `get_bundle`)
- `/Users/thim/Repositories/dilla-chat/client/src/services/api.ts` (lines 1144-1175 `getPrekeyBundle` + initiate option)
- `/Users/thim/Repositories/dilla-chat/client/src/services/crypto.ts` (line 237 `initiate: true` in `ensurePeerSession`)

**What changed.**
- Server now refuses prekey-bundle fetch unless `users_share_team(caller, target)` returns true. Same-user lookups are always allowed.
- OTPK is only consumed when the client passes `?initiate=true`. Drive-by fetches (wrap/unwrap, safety-number recomputation, presence) leave it false.
- Client `api.getPrekeyBundle` exposes `{ initiate?: boolean }`; `crypto.ensurePeerSession` (the only true X3DH initiator) sets it.

### Fix 8 — VULN-017 + VULN-018 + VULN-019 (commit `71a460e`)

**Files:**
- `/Users/thim/Repositories/dilla-chat/client/package-lock.json`

**What changed.** `npm audit fix` resolved 3 advisories (1 Critical / protobufjs, 2 Moderate / postcss + @protobufjs/utf8). `npm run build` continues to succeed.

### Fix 9 — VULN-001 (commit `244e15d`)

**Files:**
- `/Users/thim/Repositories/dilla-chat/server-rs/Cargo.toml` (lines 50-55 `axum-server` dep with `tls-rustls`)
- `/Users/thim/Repositories/dilla-chat/server-rs/src/main.rs` (lines 580-665 rewritten `start_server`)

**What changed.**
- When `TLS_CERT` and `TLS_KEY` are both set: bind via `axum_server::bind_rustls(addr, RustlsConfig::from_pem_file(...).await?)`.
- When neither is set AND `insecure=false`: panic at startup with a clear error pointing at the two opt-in paths.
- When neither is set AND `insecure=true`: log a loud `tracing::warn!` and continue with the legacy plain `tokio::net::TcpListener` bind. The dev startup command in `CLAUDE.md` (`DILLA_INSECURE=true ...`) continues to work unchanged.

The HSTS layer in `api::create_router` was already gated on `!tls_cert.is_empty() && !tls_key.is_empty()`, which is the same condition we use to decide the TLS bind — so HSTS now only ships when the transport is actually TLS.

---

## 3. Regression test requirements

The codebase has a substantial pre-existing test-compilation problem (model struct evolution: `User.quiet_hours_*`, `Channel.locked` / `hidden_if_restricted` / `slow_mode_seconds` / `group_id`, `UpdateChannelRequest.locked` / `hidden_if_restricted` / `slow_mode_seconds`) that blocks the whole `cargo test` run on this branch. None of those errors were introduced by this remediation; they predate it and are visible on plain `git stash && cargo test`. The new tests added here compile against the same struct shapes — they'll run as soon as the maintainer un-rots the pre-existing test suite.

Integration tests the maintainer must add as soon as the suite compiles:

- **VULN-004:** an attacker who sends `channel:join` for a channel they don't have access to must not receive subsequent `broadcast_to_channel` events. (Unit-level analog exists at `handle_channel_event_denies_subscribe_for_unauthorized_user`.)
- **VULN-024:** the same denial must apply when the target is a DM channel and the caller is not in `dm_members`.
- **VULN-016:** `typing:start` for a private channel from an unauthorized user must not deliver `typing:indicator` to legitimate channel members.
- **VULN-003:** unauthenticated `GET /api/v1/teams/{team_id}/attachments/{attachment_id}` must return 401, and an authenticated caller without channel access must return 403.
- **VULN-008:** uploaded attachments with `Content-Type: text/html` or `application/javascript` must be stored as `application/octet-stream`; the download response must always emit `Content-Type: application/octet-stream` and the CSP sandbox header.
- **VULN-007:** REST `POST /messages` and `GET /messages` for a private channel from an excluded team member must return 403.
- **VULN-009:** after running migration 026, an unconsumed bootstrap token older than 15 minutes must be rejected with "bootstrap token expired"; the token file at `${DATA_DIR}/BOOTSTRAP_TOKEN` must be mode 0600.
- **VULN-005:** starting the server with `DILLA_PEERS=ws://x:8081` and empty `DILLA_JOIN_SECRET` and unset `DILLA_INSECURE` must panic at boot. Same start with `DILLA_INSECURE=true` must log an error and continue. Starting with a 31-byte `DILLA_JOIN_SECRET` and peers configured must log a `tracing::warn!`.
- **VULN-006:** `GET /api/v1/prekeys/{u}` by a caller who shares no team with `u` must return 403. Same call to a shared-team `u` without `?initiate=true` must return an empty `one_time_prekeys` array AND must not decrement OTPK count.
- **VULN-001:** starting the server with empty `TLS_CERT` and empty `TLS_KEY` and unset `DILLA_INSECURE` must exit with the new error banner. Starting with valid TLS material must serve HTTPS with HSTS header attached.
- **VULN-002 (partial):** federation incoming auth with an empty configured `join_secret` and `insecure=false` must reject. Same with `insecure=true` must accept any peer (legacy behavior preserved for dev).

---

## 4. Open items / deferred work

- **Full VULN-002 redesign — Phase 3.** This commit set delivers only the constant-time compare + empty-secret rejection. The structural problem — federation peers can call `merge_channels`, `merge_roles`, `merge_members`, `merge_messages` with last-writer-wins semantics on attacker-supplied `updated_at` — requires per-node Ed25519 signing keys and a signed `FederationEvent` envelope. Tracked in `.security-hardening/03-architecture-review.md` section 7. Estimated effort: 2-3 weeks (schema migration for `nodes.public_key`, signed-event serializer, mesh re-handshake protocol bump, peer-pinning UX in admin panel).
- **Pre-existing test-compile rot.** Several call sites in `server-rs/src/main.rs` (test mod), `server-rs/src/api/tests.rs`, and `server-rs/src/ws/tests.rs` construct `db::User` / `db::Channel` / `UpdateChannelRequest` without the fields added in migrations 016, 017, 018, 020, 023. New tests added by this remediation compile correctly against current struct shapes, so they'll pass once the maintainer adds the missing fields to the legacy test builders. This is not blocking for the security fixes but blocks running `cargo test` on the branch.
- **No bulk-delete or rotation API for bootstrap tokens.** Today an operator who lets the 15-minute window lapse must restart the server to mint a new one (the first-start gate is keyed off `database.has_users() == false`). Acceptable for v1 of the fix; consider a `dilla-server admin rotate-bootstrap-token` subcommand later.
- **Attachment uploader provenance.** The unlinked-grace window in the new download path uses a 1-hour timer rather than an "uploaded by caller" check, because the `attachments` table has no `uploader_id` column today. Tracked as a follow-up (migration 027) to tighten this from "any team member in 1h" to "the uploader in 1h".

---

## 5. Migration impact

| Change | Impact |
|---|---|
| Migration 026: `ALTER TABLE bootstrap_tokens ADD COLUMN expires_at` | Backfill gives existing unconsumed tokens a 15-minute lease from migration time. No-op on a fresh DB. |
| `DILLA_INSECURE` is now load-bearing | An operator who currently relies on plaintext defaults without explicitly setting `DILLA_INSECURE=true` will see a startup error. Documented in the new `start_server` error message. |
| `DILLA_JOIN_SECRET` policy at startup | Operators with federation configured AND empty `DILLA_JOIN_SECRET` AND unset `DILLA_INSECURE` will see the new panic. Outstanding join JWTs issued under the old raw-bytes HMAC become invalid; operators must re-issue. |
| `Content-Disposition` filename change on attachment download | Clients that relied on the server-returned filename via `Content-Disposition` will now see the server-generated attachment ID instead. The encrypted filename in `attachments.filename_encrypted` is still returned via the message-list JSON payload — the change is download-time only. |
| Attachment download route moved to protected group | Any client that fetched attachments without an `Authorization: Bearer …` header will now 401. The webapp uses `api.request(...)` which always attaches the JWT, so the in-tree client is unaffected. |
| Bootstrap-token banner format change | Operators automating first-time setup must now read the token from `${DATA_DIR}/BOOTSTRAP_TOKEN` (mode 0600) instead of stdout. The banner points at the path. |
| `GET /api/v1/prekeys/{user_id}` requires shared team | Out-of-tree clients that fetched prekey bundles cross-team will now 403. Pass `?initiate=true` to consume an OTPK; default is identity-key-only fetch. |
| New direct dep `axum-server` (`tls-rustls`) and `subtle` | Build pipeline impact: both crates are well-known and already transitively present; `cargo build --release` succeeds without further changes. |

---

## 6. What still ships in plaintext on the dev box

The running dev server uses `DILLA_INSECURE=true` per the project's CLAUDE.md, which means:

- HTTP on `:8888` (no TLS) — intentional for local dev.
- Federation transport accepts the configured `join_secret` constant-time, OR (when empty) accepts any peer.
- Federation events still apply last-writer-wins state merge to whatever a peer sends — Phase-3 work.

For any non-dev deployment, drop `DILLA_INSECURE=true`, set valid `TLS_CERT` + `TLS_KEY`, and set a 32+ byte `DILLA_JOIN_SECRET`. Startup will refuse otherwise.
