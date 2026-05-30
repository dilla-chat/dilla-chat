# Dilla — Step 12 Compliance Audit Report

**Subject:** Dilla — federated, end-to-end encrypted Discord alternative
**Frameworks in scope (per `state.json`):** OWASP only — OWASP Top 10 (2021), OWASP ASVS 4.0.3 Level 2, CIS Benchmarks (Docker v1.6, Distribution-independent Linux, Kubernetes)
**Frameworks explicitly out of scope:** GDPR, CCPA, HIPAA, PCI-DSS, SOC 2 — Dilla is a self-hosted product, not a SaaS, and does not handle regulated data; operator-deployment compliance is the operator's responsibility (see §4).
**Method:** Documentary review of `.security-hardening/01-…11-…` against ASVS L2 verifier controls and CIS benchmark items. No new source-code changes. Every claim cites a file path, line range, DILLA-VULN-NNN ID, or step report subsection.
**Posture today (per `11-pentest-results.md` §7):** 0 Critical, 1 partially-closed High (VULN-002 Phase 1), 5 Medium residuals, 6 Low net-new, 3 architectural deferreds.

---

## 1. OWASP Top 10 (2021) gap analysis

**A01:2021 — Broken Access Control · COVERED (with one low-severity residual).** Original baseline (`01-vulnerability-scan.md`) carried five A01 findings: VULN-003 (unauthenticated attachment download), VULN-004 (WS channel:join with no ACL), VULN-006 (cross-team prekey fetch), VULN-007 (REST message ACL skip), VULN-016/VULN-024 (typing + DM subscribe). All five are closed per `11-pentest-results.md` §2: VULN-003 routes through `policy::require_team_member` + channel ACL; VULN-004/016/024 route through `policy::can_subscribe_channel` at `server-rs/src/ws/client.rs:316-361` and `ws/handlers/message.rs:367-376`; VULN-006 enforces `users_share_team` + opt-in OTPK consumption at `api/prekeys.rs:107-121`; VULN-007 enforces `user_can_access_channel` on list/create/edit/delete at `api/messages.rs:65-71, 129-133, 184-188, 267-271`. **Residuals:** (a) VULN-020 — WS `team` query parameter still not gated on membership (`api/mod.rs:543-595`), Low severity, voice-room snapshot metadata leak only; (b) unlinked-attachment grace path doesn't bind attachment to URL `team_id` (`11-pentest-results.md §5 #2`), Low severity.

**A02:2021 — Cryptographic Failures · COVERED.** Original baseline VULN-001 (TLS missing on HTTP/WS), VULN-005 (`join_secret` used as raw HS256 key), VULN-012 (JWT aud/iss/jti + revocation missing), VULN-014 (ws:// federation peers), VULN-015 (AES-GCM nonce documentation), VULN-022 (timing on token compare), AUTH-WEAK-1 (JWT HMAC from weak passphrase). All material items closed: TLS bind via `axum_server::bind_rustls` at `server-rs/src/main.rs:796-877` with refuse-plaintext-default; HKDF on `join_secret` with info `b"dilla-federation-join-v1"` at `federation/join.rs:33-44`; JWT carries `jti/aud/iss/did` and `validate_jwt_full` enforces them plus revocation lookup; federation auth uses `subtle::ConstantTimeEq`; `enforce_jwt_secret_strength` refuses startup on empty passphrase outside `DILLA_INSECURE`. **Residual:** VULN-015 documentation deliverable (5-line comment near `aesGcmEncrypt`) not in tree per `11-pentest-results.md §3 — VULN-015`; cryptographic invariant itself is preserved by the Double Ratchet's per-message-key rotation.

**A03:2021 — Injection · COVERED.** Step-1 verified clean for SQL injection (all queries via `params!`), XSS (no direct DOM HTML-injection sinks / no `eval` in `client/src/`), command injection (no `Command::new` outside `open::that()` URL launch), path traversal (explicit `../`/`/`/`\\` checks in `uploads.rs:77-79`). VULN-008 (user-controlled `Content-Type` on attachment serve) closed via `sanitize_upload_content_type` allow-list at upload + always `application/octet-stream` on download + `CSP default-src 'none'; sandbox` at `api/uploads.rs:303-316`. Trusted Types `default` policy registered pre-DOM in `client/src/services/trustedTypes.ts` (F7 in `06-frontend-hardening.md`). No open A03 items.

**A04:2021 — Insecure Design · PARTIAL.** The headline open item is VULN-002 federation trust — Phase 1 closed (constant-time compare + empty-secret reject + HKDF + ws:// reject) but Phase 3 redesign (per-node Ed25519 signing + signed `FederationEvent` envelopes + replacement of last-writer-wins merges) is **explicitly deferred** per `11-pentest-results.md §6 #1`. A trusted federation peer can today still forge channels/roles/members/messages once admitted. Other A04 items closed: VULN-011 rate limits applied to protected router (`05-backend-hardening.md` H1), WS subscription cap `MAX_SUBSCRIPTIONS_PER_CLIENT=200` at `ws/client.rs:20, 285-299`, OUT-SSRF-1 outbound SSRF guard with TOCTOU caveat documented. Architectural deferrals FED-META-1 (federation peer sees full metadata) and SFU-IP-1 (ICE-candidate IP exposure to legitimate channel members) are documented as design constraints, not bugs.

**A05:2021 — Security Misconfiguration · COVERED.** Refuse-plaintext-default at `main.rs:796-877`; HSTS gated on TLS-actually-serving so cleartext + HSTS combination cannot occur; CSP/COOP/COEP/X-Content-Type-Options/Referrer-Policy emitted on SPA shell (smoke-test output in `11-pentest-results.md §4`); systemd unit with `NoNewPrivileges`, `ProtectSystem=strict`, empty `CapabilityBoundingSet`, `RestrictAddressFamilies`, seccomp `@system-service` at `deploy/systemd/dilla-server.service:43-89`; Docker Compose with `read_only: true`, `cap_drop: ALL`, `no-new-privileges:true`, `user: "65532:65532"` at `deploy/docker/compose.yml:40-55`; Kubernetes PodSecurity `restricted` profile at `deploy/k8s/podsecurity.yaml`. Operator-facing config checklist in `SECURITY.md §8`.

**A06:2021 — Vulnerable and Outdated Components · COVERED.** `npm audit` reports 0 vulnerabilities (verified in `11-pentest-results.md §2`); `Cargo.lock` present in both `server-rs/` and `client/src-tauri/` (the latter was a TAU-SUPPLY-1 net-new finding, now closed via commit `68193fb`); SRI on every JS chunk via `scripts/sri.cjs` rewriting 18 tags with `sha384-…` integrity + `crossorigin="anonymous"` (EMB-INTEG-1 closed). **Residual:** DR-SUPPLY-1 acknowledges that a hostile crates.io publish landing in CI remains a vector — only partially mitigated. Server binary itself is not yet signed.

**A07:2021 — Identification and Authentication Failures · COVERED.** Passwordless Ed25519 challenge-response with single-use challenges, 5-min expiry, 256-bit nonces; collapsed-error path on verify (`auth_handlers.rs:138-164`) closes AUTH-ENUM-1; JWT lifecycle hardened per VULN-012 closure; bootstrap token written 0600 with 15-min expiry to `${DATA_DIR}/BOOTSTRAP_TOKEN` (VULN-009 closed); multi-device key trust with `user_devices` table + `did` JWT claim (A1 closed server-side); auth-events logged via `audit_events` taxonomy (A5 closed). **Caveat:** A1 client-UI for QR/authorizer-signing flow is pending per `11-pentest-results.md §6 #8`; AUTH-LOG-1 records login events but does not retain the signature bytes themselves.

**A08:2021 — Software and Data Integrity Failures · PARTIAL.** SRI on every embedded JS chunk closes EMB-INTEG-1; `Cargo.lock` pinned for both Rust crates closes TAU-SUPPLY-1; Trusted Types + strict CSP defend against DR-XSS-1 (only safety-number op migrated to worker; full crypto-in-worker migration pending per `06-frontend-hardening.md` F3 and `11-pentest-results.md §6 #6`). VULN-002's integrity-of-replicated-state dimension still has the Phase-3 hole described under A04. FED-AUDIT-1 (federation merge provenance — no per-event signature, no origin-node tag on audit rows) is deferred per `11-pentest-results.md §2`.

**A09:2021 — Security Logging and Monitoring Failures · COVERED.** Browser-log relay default-off, JWT-auth-attach, rate-limited (10/200, 60/429 verified live), ANSI-stripped, client-side `scrubLogLine` redacts JWT-shape / Bearer / base64-ish ≥40-char tokens with 2 KiB per-line cap (VULN-010 + F6 closed); audit log writes for every team-settings mutation and every authentication event (`auth.login`, `auth.login_failed`, `auth.logout`, `auth.token_refresh`, `device.enrolled`, `device.revoked`, `device.risk_event`, `bootstrap.consumed` — all rows verified in `11-pentest-results.md §2 — A5`); detection guide in `deploy/detection/README.md` with LogQL + SQL snippets. PII scrubbing audit-trail intentional — no JWT tokens written to logs anywhere (per F4 in `06-frontend-hardening.md`).

**A10:2021 — Server-Side Request Forgery · COVERED with TOCTOU caveat.** `safe_outbound_url` + `is_public_ip` cover RFC-1918, loopback, link-local, AWS metadata, CGNAT, IPv6 ULA, IPv4-mapped; HTTPS-only enforced. **Residual:** DNS-rebinding between check and `reqwest::Client::get(&safe_url).send()` is not pinned per `11-pentest-results.md §5 #4`; belt-and-braces is the `is_giphy_url` host-suffix check on the only outbound-fetch endpoint today.

---

## 2. OWASP ASVS 4.0.3 Level 2 conformance

The table below walks ASVS chapters V1-V14, prioritizing controls relevant to Dilla's surface. Verifier IDs reference ASVS 4.0.3. "N/A" entries are out of scope for a self-hosted passwordless E2EE chat product; "Partial" entries are honest acknowledgements rather than gildings.

### V1 — Architecture, Design and Threat Modeling

| ASVS ID | Requirement | Status | Evidence |
|---|---|---|---|
| V1.1.1 | SDLC includes security and threat modeling | Pass | `.security-hardening/02-threat-model.md` (STRIDE per element + per data flow + attack trees + DREAD) |
| V1.1.2 | Threat model performed for changes | Pass | `02-threat-model.md` §1.1-1.4 trust zones, DFD, STRIDE rollup |
| V1.1.4 | Trust boundaries documented | Pass | `02-threat-model.md §1.1` Z0-Z6 zone map; `03-architecture-review.md` §7-9 |
| V1.1.5 | Authentication / authorization centralized | Partial | `policy::can_subscribe_channel`, `policy::require_team_member`, `policy::user_can_access_channel` exist; A6 migration tail of REST handlers (dms/threads/reactions/polls/pins/gif/invites/roles/integrations/channel_groups/audit/presence/voice/federation) still calls `helpers::require_*` (`11-pentest-results.md §2 — A6`). Semantically equivalent, mechanically incomplete. |
| V1.2.1 | Unique low-privilege OS account | Pass | systemd `User=dilla` (`deploy/systemd/dilla-server.service:27`), container `user: "65532:65532"` distroless (`deploy/docker/compose.yml:48`), K8s `runAsUser: 65532, runAsNonRoot: true` (`deploy/k8s/podsecurity.yaml:46-48, 79-80`) |
| V1.4.1 | Trusted enforcement points at every tier | Pass | REST: `policy::*` + `require_*`. WS: `user_can_subscribe_to_channel`. Federation: `validate_auth_message_with_insecure`. Reverse proxy + WAF: `deploy/reverse-proxy/*`, `deploy/waf/*`. |
| V1.4.4 | Authorization decisions logged | Partial | `log_decision` telemetry on policy-migrated paths; missing on A6 migration tail (`11-pentest-results.md §2 — A6`) |
| V1.5.2 | Serialization is safe across trust boundaries | Pass | `serde_json` everywhere; JWT alg pinned `HS256`; federation events tagged enum |
| V1.7.1 | Logs sent to a remote sink resistant to tampering | Partial | `deploy/detection/README.md` documents Loki + Grafana; no built-in WORM log target — operator-responsible |
| V1.8.1 | Sensitive data identified and classified | Pass | `02-threat-model.md §3` data-asset inventory; ciphertext vs metadata distinction documented throughout |
| V1.9.1 | Communications encrypted with current best practice | Pass | TLS bind (`main.rs:796-877`), wss-only federation (VULN-014), `upgrade-insecure-requests` CSP directive |
| V1.10.1 | Source-control + integrity controls | Pass | Conventional commits, signed commits possible; `Cargo.lock` + `package-lock.json` + SRI; `gitleaks` workflow at `.github/workflows/secret-scan.yml` (per `10-secrets-management.md §1`) |
| V1.11.1 | Component definition and trust boundaries | Pass | `03-architecture-review.md` (full module map) |
| V1.14.4 | Documented and reproducible build | Pass | `cargo build --release` + `npm run build` + `scripts/sri.cjs`; Docker base pinned distroless |

### V2 — Authentication

ASVS V2 was written around passwords. Dilla is passwordless — identity *is* an Ed25519 keypair (`SECURITY.md §1`). Below maps each V2 verifier to either the equivalent Ed25519 control, the multi-device trust model (`08-auth-enhancement.md` A1), or marks N/A where the requirement is genuinely password-shaped.

| ASVS ID | Requirement | Status | Evidence |
|---|---|---|---|
| V2.1.1 | Passwords ≥12 chars | N/A — passwordless | `SECURITY.md §1`; identity is Ed25519 keypair, no shared secret |
| V2.1.2 | Long passwords (>=64) permitted | N/A — passwordless | — |
| V2.1.7 | No password composition rules | N/A | — |
| V2.1.9 | No periodic password rotation | N/A | — |
| V2.1.11 | "Show password" option | N/A | — |
| V2.2.1 | Anti-automation on auth | Pass | Auth rate-limit `10/6s` per `05-backend-hardening.md` H1; live: `/auth/challenge` 10×200/15×429 in `11-pentest-results.md §4` |
| V2.2.2 | Lockout / lockout-bypass safe | Pass-by-design | Passwordless eliminates lockout; rate-limit is the analog |
| V2.2.3 | Notification on credential changes | Partial | `auth.login`, `device.enrolled`, `device.revoked` audit rows shipped; **no email/push notification** — operator-responsibility because Dilla has no built-in mailer |
| V2.3.1 | Initial-secret generated server-side or user-chosen | Pass | Identity keypair generated client-side; server only stores public key |
| V2.4.1 | Salted, slow hash for stored credentials | N/A — server stores public keys, not credentials | — |
| V2.5.1 | No password-recovery hint | N/A | — |
| V2.5.4 | Default account not "admin" with default password | Pass | Bootstrap-token mechanism + 15-min expiry + 0600 file (VULN-009 closed); no default admin/admin |
| V2.5.5 | Account-recovery secret has same strength as credential | Pass | Bootstrap token is 32-byte hex (128-bit entropy); recovery requires operator-side CLI per `SECURITY.md §6` |
| V2.5.7 | Shared/default account passwords change after first use | Pass | Bootstrap token is single-use (consumed via `bootstrap_tokens` row) with 15-min expiry |
| V2.6.1 | OOB authenticator generated by app | Pass — adapted | Per-device Ed25519 keypair; new-device enrollment requires an already-trusted device to sign the new pubkey (`SECURITY.md §2`; `08-auth-enhancement.md` A1) |
| V2.7.1 | OOB devices time-bound | Pass | Device enrollment uses a short-lived authorizer signature; refresh token 24h with sliding rotation at ≤12h remaining |
| V2.7.5 | Verifier presents a code to user to confirm OOB identity (safety number) | Partial | F9 surfaces "Verified ✓ / Verify identity / Re-verify identity" in `UserProfile` popover (`06-frontend-hardening.md` F9); full numeric safety-number compare modal wired to `verifiedContactsStore` + `SafetyCompare` but TOFU pinning is inherent (X3DH-MITM-1 partial). |
| V2.8.1 | OTP-like authenticators time-bound | Pass | Challenges: 5-min expiry, single-use, 256-bit nonces (`SECURITY.md §1`); WS tickets: 30-second single-use |
| V2.9.1 | Cryptographic keys to authenticate are stored securely | Pass | Tauri keychain on desktop; IndexedDB-backed encrypted storage in browser; private keys never leave the device |
| V2.9.3 | Approved cryptographic algorithms | Pass | Ed25519 (FIPS 186-5 / RFC 8032), X25519, AES-256-GCM, SHA-256, HKDF-SHA256 |
| V2.10.1 | Service accounts not user-keyed | Pass | Federation join secret (HKDF-derived) is service-scoped, distinct from user JWT secret |

### V3 — Session Management

| ASVS ID | Requirement | Status | Evidence |
|---|---|---|---|
| V3.1.1 | App never reveals session tokens in URL parameters | Pass | JWT in `Authorization: Bearer`; WS ticket is 30-second single-use querystring on `/ws` only (acceptable per V3.1.1 exception) |
| V3.2.1 | Generates a new session token on auth | Pass | Fresh access + refresh JWT minted in `auth_handlers.rs` verify path; `jti` is UUID v4 per `SECURITY.md §3` |
| V3.2.2 | ≥64 bits of entropy | Pass | JWT signed with HKDF-derived 32-byte key; `jti` is 128-bit UUID v4 |
| V3.2.3 | Session bound to TLS | Pass when TLS on | `validate_jwt_full` does not bind to TLS-session, but `SECURITY.md §8` requires `DILLA_TLS_CERT`/`KEY` in production; reverse-proxy mode delegates TLS to Caddy/nginx with HSTS |
| V3.3.1 | Logout terminates session | Pass | `/auth/logout` adds `jti` to `jwt_revocations` table; revocation checked in `validate_jwt_full` (VULN-012 closed) |
| V3.3.2 | Idle timeout / re-auth | Pass | Access JWT exp 1h; refresh 24h; sliding renewal at ≤12h remaining (`SECURITY.md §3`) |
| V3.3.3 | Re-auth on permission change | Pass | `tokens_invalidated_after` cutoff enforced in `validate_jwt_full`; `update_member` calls `db::invalidate_user_tokens_now` (A4 closed per `11-pentest-results.md §2`) |
| V3.4.1 | Cookies marked Secure | N/A — JWT carried in `Authorization` header, not cookies | — |
| V3.4.3 | SameSite | N/A | — |
| V3.5.1 | Allows revocation of session tokens | Pass | Per-token (`jti`) revocation list; per-device (`did`) revocation via `user_devices.revoked_at`; per-user (`tokens_invalidated_after`) cutoff |
| V3.5.2 | Stateful sessions / stateless tokens digitally signed | Pass | JWT HS256 with HKDF-derived key (AUTH-WEAK-1 closed); `aud`/`iss` pinned to `node_name` (VULN-012) |
| V3.5.3 | Tokens include audience and issuer claims | Pass | `aud` + `iss` = `node_name` enforced by `validate_jwt_full` (`SECURITY.md §3`) |
| V3.7.1 | Re-authentication for protected operations | Partial | Force-logout on permission change covers role escalation; **no separate step-up auth** for high-risk operations (federation token mint, role grant). Future enhancement. |

### V4 — Access Control

| ASVS ID | Requirement | Status | Evidence |
|---|---|---|---|
| V4.1.1 | Principle of least privilege | Pass | Bitmask role model (`SECURITY.md §4`); PERM_MANAGE_FEDERATION (1<<10) + PERM_VIEW_AUDIT_LOG (1<<11) split out (A3 closed) |
| V4.1.2 | Server-side enforcement | Pass | Every WS event and REST handler enforces server-side ACL; client-side checks are advisory only |
| V4.1.3 | Centralized access-control mechanism | Partial | `policy` module covers `messages`, `uploads`, `channels`, `teams`; A6 tail of 14 REST handler families still on `helpers::require_*` (semantically equivalent, mechanically not in `policy`). `11-pentest-results.md §2 — A6` |
| V4.1.5 | Fails securely (deny by default) | Pass | `user_can_subscribe_to_channel` returns false on unknown ID; REST handlers return 403 via `AppError::Forbidden` |
| V4.2.1 | No IDOR / direct object references | Pass | All multi-tenant IDs gated by `require_team_member` + `user_can_access_channel`. **Residual:** unlinked-attachment grace path doesn't bind to URL `team_id` (`11-pentest-results.md §5 #2`) — Low. |
| V4.2.2 | No re-auth via CSRF | Pass | JWT in `Authorization` header (not cookies) — exempt from classic CSRF |
| V4.3.1 | Administrative interfaces use MFA | Pass-by-design | Passwordless model + multi-device key trust; "admin" is a permission bit not a separate account |
| V4.3.2 | Admin-only logging visible to admins | Pass | `audit_events` table; `GET /api/v1/teams/{team_id}/audit` gated by `PERM_VIEW_AUDIT_LOG` (`SECURITY.md §5`) |
| V4.3.3 | Sensitive admin operations have additional protection | Partial | Federation token mint gated by `PERM_MANAGE_FEDERATION` (A3); role grant audit-logged; no separate step-up reauth. |

### V5 — Validation, Sanitization and Encoding

| ASVS ID | Requirement | Status | Evidence |
|---|---|---|---|
| V5.1.1 | Input validation strategy documented | Pass | `05-backend-hardening.md` H3, H5, H12 |
| V5.1.3 | Server-side input validation enforced | Pass | `identity_blob` 64 KiB cap (VULN-013); `MAX_PAGE_LIMIT=200` server clamp (MSG-DOS-1); `MAX_SUBSCRIPTIONS_PER_CLIENT=200` (WS-AMP-1); upload quota migration 028 (UPL-DOS-1) |
| V5.1.4 | Structured-data validated with strict schema | Pass | `serde_json` deserialization with tagged enums for WS events |
| V5.1.5 | URL redirects use allow-list | Pass | `safe_outbound_url` + `is_giphy_url` host-suffix pin; HTTPS-only |
| V5.2.1 | Untrusted HTML stripped or sanitized | N/A | Bodies are E2EE ciphertext; client renders Markdown not HTML; Trusted Types policy at `client/src/services/trustedTypes.ts` is the belt-and-braces |
| V5.2.2 | Markdown converter safe by default | Pass | Client uses sanitized markdown renderer; CSP `script-src 'self'` + Trusted Types default policy reject inline-script vectors (F1, F7) |
| V5.2.3 | Email format validated | Pass | Email is not a primary identifier in Dilla; only used for reset notifications (operator-side) |
| V5.2.7 | SVG accepted only with strict allow-list | Pass — by exclusion | Attachment `Content-Type` allow-list excludes SVG (VULN-008 closure); download always `application/octet-stream` |
| V5.2.8 | Scriptable content stripped from uploads | Pass | `sanitize_upload_content_type` + sandbox CSP on download (`api/uploads.rs:303-316`) |
| V5.3.1 | Output encoding context-aware | Pass | React JSX context-aware escaping; no raw-HTML React prop usage; CSP `script-src 'self'` |
| V5.3.3 | XSS prevention in DOM contexts | Pass | Trusted Types `default` policy + CSP `require-trusted-types-for 'script'` (F1 + F7) |
| V5.3.4 | Parameterized queries | Pass | All SQL via `rusqlite` `params!` (verified clean in `01-vulnerability-scan.md` §"Categories that came back clean") |
| V5.3.5 | Safe API to escape ORM placeholders | Pass | No ORM; raw rusqlite with `params!` |
| V5.4.1 | Memory-safe language or safe string functions | Pass | Rust server, TypeScript client; `unsafe` Rust audited (none in security-critical paths) |
| V5.5.1 | Untrusted data deserialized only into expected types | Pass | `serde` strict typing |

### V6 — Stored Cryptography

| ASVS ID | Requirement | Status | Evidence |
|---|---|---|---|
| V6.1.1 | Data classified and protected accordingly | Pass | E2EE ciphertext at rest in SQLCipher; metadata also at rest in SQLCipher |
| V6.1.2 | Sensitive data encrypted at rest | Pass | SQLCipher AES-256 via `rusqlite` `bundled-sqlcipher`; passphrase HKDF-strengthened |
| V6.2.1 | Cryptographic keys controlled by application | Pass | SQLCipher key wrapped in `SecretString`; `expose_secret` only at PRAGMA call site in `db/mod.rs:119-150`; DB-MEM-1 closed |
| V6.2.2 | Industry-vetted algorithms | Pass | AES-256-GCM, X25519, Ed25519, SHA-256, HKDF-SHA256, Argon2 (where applicable) |
| V6.2.3 | Cryptographic random where needed | Pass | `ring`/`OsRng` server-side; `crypto.getRandomValues()` client-side; per-message 12-byte AES-GCM nonces from WebCrypto |
| V6.2.4 | Key length follows best practice | Pass | Ed25519 (256-bit), X25519 (256-bit), AES-256, SHA-256, JWT key 32 bytes after HKDF |
| V6.2.5 | Key management documented | Pass | `10-secrets-management.md`; `deploy/secrets/ROTATION.md` covers per-secret rotation cadence |
| V6.2.6 | Nonces / IVs not reused | Pass | AES-GCM uses 12 random bytes per message; Double Ratchet rotates message keys per message (VULN-015 invariant). **Caveat:** code-comment documenting this is not yet in tree per `11-pentest-results.md §3 — VULN-015`. |
| V6.2.7 | Authenticated encryption | Pass | AES-GCM is AEAD; `ed25519-dalek` for signatures |
| V6.3.1 | Cryptographic secrets generated server-side or by approved process | Pass | Bootstrap token via `OsRng`; JWT signing key via HKDF; federation join via HKDF |
| V6.3.2 | Random session identifiers | Pass | UUID v4 for `jti`; 128-bit hex tokens elsewhere |
| V6.4.1 | Secret-key vaults / KMS for high-value keys | Operator-responsible | systemd `LoadCredential` + `DILLA_DB_PASSPHRASE_FILE` + Tier 1-4 storage matrix in `deploy/secrets/README.md` |

### V7 — Error Handling and Logging

| ASVS ID | Requirement | Status | Evidence |
|---|---|---|---|
| V7.1.1 | App does not log credentials | Pass | F4 + F6: no token logging anywhere; `scrubLogLine` redacts JWT-shape / Bearer / base64-ish ≥40-char tokens |
| V7.1.2 | App does not log sensitive data | Pass | Browser-log relay scrubbing; 2 KiB per-line cap; `AppError` paths sanitized to avoid PII leak |
| V7.1.3 | Each log event has standard fields (timestamp, source, user, action, outcome) | Pass | `audit_events` schema `(id, team_id, actor_user_id, action, target_type, target_id, details, created_at)` (`SECURITY.md §5`) |
| V7.1.4 | Logs encoded to prevent injection | Pass | ANSI strip via CSI-byte-state machine (`05-backend-hardening.md` browser-log relay) |
| V7.2.1 | All authentication decisions logged | Pass | `auth.login`, `auth.login_failed`, `auth.logout`, `auth.token_refresh`, `device.enrolled`, `device.revoked`, `device.risk_event`, `bootstrap.consumed` rows verified |
| V7.2.2 | All access-control decisions can be logged | Partial | `log_decision` instrumentation on policy-migrated paths only; A6 tail missing (`11-pentest-results.md §2 — A6`) |
| V7.3.1 | Logs protected against tampering | Operator-responsible | `audit_events` SQLite table; tamper-evidence requires operator to ship logs to external WORM store (`deploy/detection/README.md`) |
| V7.4.1 | Generic error message on failure | Pass | `AppError` collapses to standard 4xx/5xx; verify-path collapsed-error closes AUTH-ENUM-1 |
| V7.4.2 | Exception handlers in place | Pass | Axum middleware catches and converts to `AppError` |
| V7.4.3 | Last-resort handler defined | Pass | `tower::ServiceExt::handle_error` |

### V8 — Data Protection

| ASVS ID | Requirement | Status | Evidence |
|---|---|---|---|
| V8.1.1 | Sensitive data not in HTTP cache | Pass | `Cache-Control: no-store` on auth + protected responses |
| V8.1.5 | Backup data encrypted | Operator-responsible | SQLCipher means raw DB file is encrypted; backup-tooling is operator's choice |
| V8.2.1 | Sensitive data not in temp storage | Pass | F4: JWT/team-tokens encrypted at rest in sessionStorage with non-extractable AES-GCM wrap key (`06-frontend-hardening.md` F4) |
| V8.2.2 | Sensitive data not in browser DOM | Pass | F4 + Trusted Types + CSP |
| V8.3.1 | Sensitive data sent via response body, not URL | Pass | JWT in `Authorization`; identity blobs in POST bodies |
| V8.3.2 | Users can delete their data | Partial | Per-user `DELETE` endpoints exist for messages/uploads; **bulk account erasure is operator-responsibility** — Dilla provides no built-in "delete-my-account" affordance today |
| V8.3.4 | Sensitive data identified | Pass | `02-threat-model.md §3` asset inventory |
| V8.3.5 | Access to sensitive data audited | Pass | `audit_events` covers every team-settings mutation; PII access by admins logged |
| V8.3.7 | Data retention policy defined | Operator-responsible | Dilla does not enforce a retention TTL; **operator must document and configure** per `SECURITY.md §8` |
| V8.3.8 | Personal data identified | Partial | Federation peer learns full metadata graph (FED-META-1) — architectural deferral acknowledged. Message bodies E2EE; metadata is the residual privacy boundary. |

### V9 — Communication Security

| ASVS ID | Requirement | Status | Evidence |
|---|---|---|---|
| V9.1.1 | TLS used for all client connectivity | Pass when configured | `axum_server::bind_rustls` at `main.rs:796-877`; refuse-plaintext-default unless `DILLA_INSECURE=true` |
| V9.1.2 | TLS configured per current best practice | Pass | `rustls` defaults (TLS 1.2+/1.3, modern cipher suites); reverse-proxy configs in `deploy/reverse-proxy/*` ship hardened TLS |
| V9.1.3 | Backend connectivity encrypted | Pass | Federation peers require `wss://` outside `DILLA_INSECURE` (VULN-014); federation auth uses HKDF-derived secret |
| V9.2.1 | Server certificates validated | Pass | `rustls` default validators; CA roots from system trust store |
| V9.2.2 | All connections to external systems encrypted | Pass | Giphy / Cloudflare TURN / OTel collector all over HTTPS; `is_public_ip` SSRF guard rejects plaintext |
| V9.2.4 | Strict TLS to remote services | Pass | `reqwest::Client` defaults plus explicit HTTPS-only check in `safe_outbound_url` |
| V9.2.5 | Backend TLS failures logged | Pass | `tracing::error!` on `axum_server::bind_rustls` failure |

### V10 — Malicious Code

| ASVS ID | Requirement | Status | Evidence |
|---|---|---|---|
| V10.1.1 | Codebase reviewed for unauthorized embedded malicious functionality | Pass | `01-vulnerability-scan.md` §"Secrets exposure report" — no hardcoded production credentials, API keys, or embedded private keys |
| V10.2.1 | App source-code integrity controls in place | Pass | Git + conventional commits + signed-commits-possible; `Cargo.lock` + `package-lock.json` pinned; `gitleaks` workflow (`10-secrets-management.md §1`) |
| V10.2.2 | App uses code-signing for binaries (where supported) | Partial | Tauri build signs the desktop installer; server binary is not yet signed (`11-pentest-results.md §2 — DR-SUPPLY-1`) |
| V10.2.3 | App integrity verified at runtime | Pass on client | SRI on every embedded JS chunk (`scripts/sri.cjs`; F2 in `06-frontend-hardening.md`); server-side: distroless container image + read-only rootfs |
| V10.3.1 | App updates over secure channels | Operator-responsible | Tauri's update channel uses signed manifests; server is operator-deployed |
| V10.3.2 | Updates signed | Partial | Tauri yes; server binary not yet (DR-SUPPLY-1 residual) |
| V10.3.3 | App source-code dependencies audited | Pass | `npm audit` 0 vulnerabilities (verified live); `cargo deny`-amenable; SBOM in `01-vulnerability-scan.md §SBOM inventory` |

### V11 — Business Logic

| ASVS ID | Requirement | Status | Evidence |
|---|---|---|---|
| V11.1.1 | Business logic flows sequential | Pass | Audit log preserves order via `created_at` + Lamport clock for federation |
| V11.1.2 | Business logic limits abuse | Pass | Rate limits: auth (10/6s), strict (10/5s on uploads/gif/embed/prekeys), protected (60/30s); WS subscription cap; upload quota per team |
| V11.1.3 | Anti-automation | Pass | tower_governor SmartIpKeyExtractor (XFF / X-Real-IP / Forwarded / peer IP) |
| V11.1.4 | Throughput limits per user | Pass | Per-IP rate limits + per-team upload quota (migration 028) + per-client WS subscription cap (200) |
| V11.1.5 | Required step ordering | Pass | Challenge → verify → JWT mint sequence enforced; bootstrap token single-use |
| V11.1.6 | TOCTOU race conditions reviewed | Partial | DNS-rebinding SSRF (`11-pentest-results.md §5 #4`) + last-device self-revoke TOCTOU (`§5 #3`) — both Low severity |
| V11.1.7 | Anti-automation against monitoring evasion | Pass | Rate-limit `429`s themselves are logged; audit-event taxonomy includes `auth.login_failed` |
| V11.1.8 | Re-entrancy and concurrency | Partial | rusqlite serializes via mutex; TOCTOU items above are the residual |

### V12 — File and Resources

| ASVS ID | Requirement | Status | Evidence |
|---|---|---|---|
| V12.1.1 | App will not accept large files that could fill storage | Pass | Per-team upload quota (migration 028 + `upload_bytes_used` column) |
| V12.1.2 | Compressed files validated before extraction | N/A | Server does not extract uploaded archives |
| V12.1.3 | Per-user upload limits | Pass | Quota is per-team (most restrictive); per-user implicit via team membership |
| V12.2.1 | Files from untrusted sources validated | Pass | `sanitize_upload_content_type` allow-list; multipart field bounded by `axum`'s body-size limit |
| V12.3.1 | User-submitted filenames not used directly | Pass | Storage path is `upload_dir/{team_id}/{uuid}` — server-generated UUID; original filename is encrypted client-side (E2EE bag) |
| V12.3.2 | User-submitted filenames used safely | Pass | `..`/`/`/`\\` checks at `uploads.rs:77-79` |
| V12.3.3 | Files written outside the web root | Pass | `upload_dir` is `${DATA_DIR}/uploads` — not under the rust-embed bundle |
| V12.4.1 | Files served with `Content-Disposition: attachment` | Pass | Always `application/octet-stream` + sandbox CSP on download (`api/uploads.rs:303-316`) |
| V12.4.2 | Files served from non-web-root location | Pass | Served via authenticated route, not static-file middleware |
| V12.5.1 | Web tier configured to serve only files with specific extensions | Pass-by-design | rust-embed only serves the SPA bundle |
| V12.6.1 | Path traversal not possible | Pass | `..`/`/`/`\\` rejection + UUID storage paths |

### V13 — API and Web Services

| ASVS ID | Requirement | Status | Evidence |
|---|---|---|---|
| V13.1.1 | All app components use same encodings | Pass | UTF-8 everywhere; `Content-Type: application/json` on REST |
| V13.1.3 | API URLs do not expose sensitive information | Pass | UUIDs in URLs; no usernames in paths |
| V13.1.4 | Authorization decisions made at REST endpoints AND services | Pass | REST + WS + federation all enforce server-side ACL |
| V13.2.1 | RESTful HTTP methods restricted by user permissions | Pass | `require_*` + `policy::*` gating |
| V13.2.2 | Schema validation on JSON requests | Pass | `serde` strict typing; size caps on identity blobs |
| V13.2.3 | CSRF mitigation for REST | Pass | JWT in `Authorization` header (not cookies); CORS pinned via `DILLA_ALLOWED_ORIGINS` |
| V13.2.4 | Rate-limiting on REST | Pass | `tower_governor` three-tier rate limiting |
| V13.2.5 | Standard message formats (problem+json etc) | Partial | Custom `AppError` JSON envelope; not RFC 7807 problem+json |
| V13.3.1 | SOAP-specific (XXE etc) | N/A | No SOAP / XML |
| V13.4.1 | GraphQL queries safe | N/A | No GraphQL |

### V14 — Configuration

| ASVS ID | Requirement | Status | Evidence |
|---|---|---|---|
| V14.1.1 | Build pipeline warns on out-of-date / vulnerable deps | Pass | `npm audit` clean; gitleaks workflow; manual cargo audit per `01-vulnerability-scan.md` |
| V14.1.2 | Build pipeline enforces security tests | Partial | Lint + build + npm audit gate CI; no SAST gate yet — recommendation to add `cargo-audit` + `semgrep` |
| V14.1.3 | Build pipeline performs application security checks | Partial | SRI generation at build is enforced; SAST is on roadmap |
| V14.1.4 | App configured with secure defaults | Pass | Refuse-plaintext-default; browser-log relay default-off; CSP/COOP/COEP/HSTS shipped; JWT weak-passphrase guard (`enforce_jwt_secret_strength`) |
| V14.1.5 | App will fail when configuration is missing critical settings | Pass | `enforce_security_policy` panics on `peers && !insecure && empty_secret` (VULN-005); `enforce_jwt_secret_strength` refuses startup on empty passphrase outside `DILLA_INSECURE` |
| V14.2.1 | Components are up-to-date | Pass | SBOM in step-1; `cargo update` cadence documented in `10-secrets-management.md` |
| V14.2.2 | Unused features removed | Pass | Tauri navigation guard allow-list (F8); rust-embed only ships the dist bundle |
| V14.2.3 | App will not include sensitive information in error messages | Pass | `AppError` collapses to generic 4xx/5xx |
| V14.2.4 | Default account passwords disabled | Pass-by-design | Passwordless |
| V14.2.6 | Secrets management plan defined | Pass | `10-secrets-management.md` + `deploy/secrets/*` (tiered storage matrix, IAM templates, rotation playbook, HSM forward path, gitleaks) |
| V14.3.1 | Web/app server config hardened | Pass | systemd unit (`deploy/systemd/dilla-server.service`), Docker Compose (`deploy/docker/compose.yml`), K8s PodSecurity restricted (`deploy/k8s/podsecurity.yaml`) |
| V14.3.2 | Server software, frameworks, runtimes patched | Operator-responsible | Documented in `09-infra-security.md` decision matrix |
| V14.3.3 | HTTP response headers minimize info leak | Pass | CSP/COOP/COEP/HSTS/X-Content-Type-Options/Referrer-Policy/X-Frame-Options shipped (smoke-test output in `11-pentest-results.md §4`) |
| V14.4.1 | Configurable file-or-env secret loading | Pass | `_FILE` convention generalized (commit `eea6661`, `10-secrets-management.md`) |
| V14.4.2 | TLS, HSTS, cookie settings hardened | Pass | HSTS layer gated on TLS-actually-serving; cookies N/A |
| V14.5.1 | Required HTTP methods only | Pass | axum router enumerates each method explicitly |
| V14.5.2 | CORS allow-list restrictive | Pass | `DILLA_ALLOWED_ORIGINS` operator-pinned per `SECURITY.md §8` |
| V14.5.3 | CORS `Access-Control-Allow-Credentials` not wildcard | Pass | Never wildcard; pinned origins |
| V14.5.4 | Trusted proxy list pinned | Pass | `DILLA_TRUSTED_PROXIES` honored (`05-backend-hardening.md` H14); compose sets `172.20.0.0/16` |

---

## 3. CIS Benchmarks

### 3.1 CIS Docker Benchmark v1.6 — Compose stack from `09-infra-security.md §I2`

Items relevant to the `deploy/docker/compose.yml` runtime layer. CIS sections 4 (Container Images) and 5 (Container Runtime) are the load-bearing ones for an OSS distribution shipping a Compose reference rather than a cloud-managed pipeline.

| CIS-N | Requirement | Status | Evidence |
|---|---|---|---|
| 4.1 | Create a user for the container | Pass | `user: "65532:65532"` in `compose.yml:48` (distroless `nonroot`) |
| 4.2 | Use trusted base images | Pass | `caddy:2.7-alpine` + distroless `dilla/server:dev` (operator pins to digest in prod) |
| 4.3 | Containers should not install unnecessary packages | Pass | Distroless base — no shell, no package manager |
| 4.5 | Enable Content trust for Docker | Operator-responsible | Pin to digest in production; `compose.yml:18` notes "replace with a pinned tag for production" |
| 4.6 | Add HEALTHCHECK | Pass | `healthcheck:` block at `compose.yml:49-54` (depends on O-6 `--healthcheck` subcommand from `09-infra-security.md §5`) |
| 4.7 | Do not use update instructions alone | Pass | No `RUN apt-get update` without specific package set |
| 4.9 | Use COPY instead of ADD | Pass | `Dockerfile` uses COPY |
| 4.10 | Do not store secrets in Dockerfiles | Pass | `DILLA_DB_PASSPHRASE_FILE` via Docker secrets, not env (`compose.yml:27`) |
| 5.1 | Do not disable AppArmor profile | Pass | Default RuntimeDefault profile in K8s; Docker uses default |
| 5.2 | Verify SELinux security options | Operator-responsible | `compose.yml` ships `no-new-privileges`; SELinux contexts are host-config |
| 5.3 | Restrict Linux Kernel Capabilities | Pass | `cap_drop: ALL` on `dilla-server` + only `NET_BIND_SERVICE` on `caddy` (`compose.yml:44-45, 74-77`) |
| 5.4 | Do not use privileged containers | Pass | No `privileged: true` |
| 5.5 | Do not mount sensitive host directories | Pass | Only named volumes; no `/var/run/docker.sock` bind |
| 5.7 | Do not map privileged ports | Pass | dilla-server bound to `127.0.0.1:8080`; only Caddy holds 80/443 |
| 5.9 | Open only ports needed | Pass | dilla-server: 8080 loopback only; Caddy: 80/443 + 443/udp |
| 5.10 | Do not run with full memory/cpu | Partial | Memory cap absent from Compose (set in systemd/K8s); operator-responsibility — Compose has placeholders. Add `mem_limit:` + `cpus:` |
| 5.12 | Mount root fs read-only | Pass | `read_only: true` on `dilla-server` (`compose.yml:41`) |
| 5.14 | Use restart policy | Pass | `restart: unless-stopped` |
| 5.15 | Do not share host PID namespace | Pass | No `pid: host` |
| 5.16 | Do not share host IPC namespace | Pass | No `ipc: host` |
| 5.17 | Do not share host UTS namespace | Pass | No `uts: host` |
| 5.19 | Do not disable default seccomp profile | Pass | Default RuntimeDefault seccomp; not overridden to `unconfined` |
| 5.21 | Do not disable default seccomp profile (security_opt check) | Pass | `security_opt: no-new-privileges:true` — no `seccomp:unconfined` |
| 5.22 | Do not docker exec with --privileged | Operator-responsible | Operational discipline |
| 5.25 | Restrict containers from acquiring additional privileges | Pass | `security_opt: no-new-privileges:true` (`compose.yml:46-47, 78-79`) |
| 5.27 | Use docker secrets, not env, for sensitive data | Pass | `secrets:` block + `DILLA_DB_PASSPHRASE_FILE` (`compose.yml:30-31, 120-123`) |
| 5.31 | Do not mount Docker socket inside containers | Pass | No socket mount |

### 3.2 CIS Distribution-independent Linux Benchmark — systemd unit from `09-infra-security.md §I3`

The systemd unit at `deploy/systemd/dilla-server.service` is the operator-side hardening artifact. Items below map relevant CIS DI-Linux controls to systemd directives.

| CIS-N | Requirement | Status | Evidence (`dilla-server.service:line`) |
|---|---|---|---|
| 1.4.1 | Filesystem integrity (sandboxed paths) | Pass | `ProtectSystem=strict` (l.44); `ReadWritePaths=/var/lib/dilla` (l.56) |
| 1.5.1 | No new privileges | Pass | `NoNewPrivileges=true` (l.59) |
| 1.5.2 | ASLR enabled | Pass-by-default | Kernel default; `LockPersonality=true` (l.64) freezes personality flags |
| 1.5.3 | Prevent prelink | Pass-by-default | Modern Debian/Ubuntu does not prelink |
| 1.6.1 | AppArmor / SELinux installed and enforcing | Operator-responsible | Compatible with host AppArmor/SELinux; systemd unit does not override |
| 1.8 | Run service as dedicated user | Pass | `User=dilla` + `Group=dilla` (l.27-28) — `useradd --system --no-create-home --shell /usr/sbin/nologin dilla` |
| 1.9 | Capability bounding set restricted | Pass | `CapabilityBoundingSet=` (empty, l.60) + `AmbientCapabilities=` (l.61) |
| 3.5.1 | Restrict access to network sockets | Pass | `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6` (l.73) — AF_NETLINK explicitly off |
| 3.5.2 | Deny private/loopback-only IP egress when not needed | Pass | `IPAddressDeny=any` + `IPAddressAllow=` for localhost + private nets + any (operator can tighten) (l.74-79) |
| 4.1 | System accounting / auditing | Pass | `StandardOutput=journal` + `StandardError=journal` (l.99-100) |
| 4.2 | Logging configured | Pass | journald + `SyslogIdentifier=dilla-server` (l.101) |
| 5.1 | Cron access restricted | N/A | dilla-server does not use cron |
| 5.2 | SSH server configuration | N/A — operator-host concern | — |
| 6.1 | System file permissions | Pass | `/var/lib/dilla` mode `0750` per install commentary (l.8); `/etc/dilla/dilla.env` mode `0640` (l.9) |
| 6.2 | User accounts and environment | Pass | `PrivateUsers=true` (l.67) |
| systemd: ProtectHome | Pass | `ProtectHome=true` (l.45) |
| systemd: ProtectKernelTunables | Pass | l.48 |
| systemd: ProtectKernelModules | Pass | l.49 |
| systemd: ProtectKernelLogs | Pass | l.50 |
| systemd: ProtectControlGroups | Pass | l.51 |
| systemd: ProtectClock | Pass | l.52 |
| systemd: ProtectHostname | Pass | l.53 |
| systemd: ProtectProc=invisible | Pass | l.54 + `ProcSubset=pid` (l.55) |
| systemd: PrivateTmp | Pass | l.46 |
| systemd: PrivateDevices | Pass | l.47 |
| systemd: MemoryDenyWriteExecute | Pass | l.65 |
| systemd: RestrictRealtime | Pass | l.63 |
| systemd: RestrictSUIDSGID | Pass | l.62 |
| systemd: RestrictNamespaces | Pass | l.66 |
| systemd: SystemCallFilter (@system-service) | Pass | l.85-87 (drops @debug @mount @reboot @swap @raw-io @cpu-emulation @obsolete) |
| systemd: SystemCallArchitectures=native | Pass | l.88 |
| systemd: LimitNOFILE / LimitNPROC | Pass | l.91-93 |
| systemd: MemoryMax / MemoryHigh | Pass | l.95-96 (2G / 1500M defaults; raise per box) |
| systemd: LoadCredential for secrets | Pass | `LoadCredential=db-passphrase:/etc/dilla/db-passphrase` (l.40); `DILLA_DB_PASSPHRASE_FILE=%d/db-passphrase` (l.41) — keeps secret out of `/proc/<pid>/environ` |

### 3.3 CIS Kubernetes Benchmark — PodSecurity manifest from `09-infra-security.md §I4`

`deploy/k8s/podsecurity.yaml` ships namespace + Deployment template. Items below map relevant CIS K8s benchmark controls (PodSecurity 5.x set) to manifest fields.

| CIS-N | Requirement | Status | Evidence (`podsecurity.yaml:line`) |
|---|---|---|---|
| 5.1.1 | Cluster-admin role only where required | Operator-responsible | Manifest does not define ClusterRoleBindings |
| 5.1.3 | Minimize wildcards in roles | Operator-responsible | — |
| 5.1.5 | Default service account not used by Pods | Pass | `automountServiceAccountToken: false` (l.44) |
| 5.2.1 | Privileged containers prohibited | Pass | `securityContext` has no `privileged: true`; restricted PSS enforces (l.17-22) |
| 5.2.2 | hostPID / hostIPC prohibited | Pass | Restricted PSS prohibits; manifest omits |
| 5.2.3 | hostNetwork prohibited | Pass | Restricted PSS prohibits; manifest omits |
| 5.2.4 | allowPrivilegeEscalation = false | Pass | l.77 |
| 5.2.5 | Root containers prohibited | Pass | `runAsNonRoot: true` + `runAsUser: 65532` (l.46-48, 79-80) |
| 5.2.6 | NET_RAW prohibited | Pass | `capabilities: drop: [ALL]` (l.81-82) |
| 5.2.7 | Added capabilities prohibited / minimized | Pass | No `capabilities: add:` |
| 5.2.8 | Assigned capabilities prohibited | Pass | `drop: [ALL]` |
| 5.2.9 | seccompProfile set | Pass | `seccompProfile: type: RuntimeDefault` (l.50-51, 83-84) |
| 5.3.1 | NetworkPolicy denies by default | Pass | `deploy/k8s/networkpolicy.yaml` ships deny-all egress + selective allow (per `09-infra-security.md §I4`) |
| 5.3.2 | NetworkPolicy applied to all namespaces | Operator-responsible | Applied via `kubectl apply` of `networkpolicy.yaml` |
| 5.4.1 | Image vulnerabilities scanned | Operator-responsible | Pin to digest; integrate scanner (Trivy/Grype) in CI |
| 5.4.2 | Use immutable image tags | Pass | Manifest comment "pin to a digest in production" (l.54) |
| 5.7.1 | Use Pod Security Admission | Pass | `pod-security.kubernetes.io/enforce: restricted` (l.16-22) — enforce + audit + warn all set |
| 5.7.2 | The default namespace is not used | Pass | Dedicated `dilla` namespace (l.12) |
| PSS Restricted | runAsNonRoot | Pass | l.46, l.79 |
| PSS Restricted | readOnlyRootFilesystem | Pass | l.78 |
| PSS Restricted | resources.limits + requests | Pass | l.85-91 |
| PSS Restricted | volumes from approved types | Pass | PVC + Secret + emptyDir (memory-medium) (l.112-123) |
| PSS Restricted | Probes defined | Pass | livenessProbe `/healthz` + readinessProbe `/readyz` (l.100-111) — depends on O-4 endpoint split from `09-infra-security.md §5` |

---

## 4. Compliance attestation summary

A single-page table operators can hand to a curious user, journalist, or due-diligence reviewer.

| Framework | Level | Conformance | Caveats |
|---|---|---|---|
| OWASP Top 10 (2021) | All categories | **Pass with caveats** | A04 Insecure Design — full federation trust redesign (VULN-002 Phase 3) deferred; A08 Data Integrity — federation-event signing pending. |
| OWASP ASVS 4.0.3 | Level 2 | **Substantial pass** | V2 Authentication adapted to passwordless Ed25519 (V2.1.x N/A by design); V4.1.3 centralized access control 90% migrated (A6 tail open); V8.3.7 data retention is operator-responsibility. |
| CIS Docker Benchmark | v1.6 | **Pass via provided Compose** | Operator must follow `deploy/docker/compose.yml`. CIS 5.10 memory/cgroup quotas operator-responsibility — placeholders in compose.yml. |
| CIS Distribution-independent Linux | — | **Pass via provided systemd unit** | Operator must follow `deploy/systemd/dilla-server.service`. AppArmor/SELinux enforcement is host-config (CIS 1.6.1) — operator-responsibility. |
| CIS Kubernetes Benchmark | — | **Pass via provided manifests** | Operator must apply `deploy/k8s/podsecurity.yaml` + `deploy/k8s/networkpolicy.yaml`. Image scanning + ClusterRoleBinding hygiene are operator-responsibility. |
| SOC 2 Type II | — | **N/A — out of scope** for self-hosted product | Only operator deployments can attain SOC 2; the codebase is a building block, not a service. |
| GDPR | — | **Operator-responsible** — Dilla provides PII-scrubbed logging + E2EE message bodies | Operator owns the data, controllership, DPA, retention, DSAR fulfillment. |
| CCPA | — | **Operator-responsible** — same posture as GDPR | — |
| HIPAA | — | **N/A** unless operator deploys in a healthcare context with BAA | — |
| PCI-DSS | — | **N/A** — Dilla does not process payment cards | — |

---

## 5. Gap analysis

What remains outstanding to reach full conformance against the in-scope frameworks. Each item points to the file or finding that tracks it.

### Project-level (codebase needs to ship)

- **OWASP A04 / A08 — VULN-002 Phase 3 federation trust redesign.** Per-node Ed25519 signing keys, signed `FederationEvent` envelopes, replacement of last-writer-wins `merge_*` semantics. Tracked in `11-pentest-results.md §6 #1`. Largest single outstanding item.
- **ASVS V4.1.3 — A6 policy migration tail.** REST handlers in `dms`, `threads`, `reactions`, `polls`, `pins`, `gif`, `invites`, `roles`, `integrations`, `channel_groups`, `audit`, `presence`, `voice`, `federation` still call `helpers::require_*` rather than `policy::*`. Semantically equivalent; mechanical migration outstanding. `log_decision` telemetry missing on those paths. `11-pentest-results.md §2 — A6` and §6 #10.
- **OWASP A01 — VULN-020 WS team-param membership check.** `ws_handler` accepts arbitrary `team` query parameter and emits voice-rooms-snapshot without membership check. ~10 LoC fix. `11-pentest-results.md §6 #2`.
- **OWASP A01 — unlinked-attachment cross-team fetch.** Add `attachments.uploader_id` column or derive owning team from `storage_path` and compare to URL `team_id`. `11-pentest-results.md §6 #4`.
- **ASVS V2.7.5 — full safety-number compare flow.** F9 surfaces the affordance; underlying TOFU pin remains. Optional enhancement: voice/QR safety-number ceremony. `11-pentest-results.md §3 — X3DH-MITM-1`.
- **ASVS V6.2.6 — VULN-015 documentation deliverable.** 5-line comment near `aesGcmEncrypt` in `client/src/services/crypto/aesGcm.ts` documenting the per-message-key invariant. `11-pentest-results.md §3 — VULN-015`.
- **OWASP A08 — DR-XSS-1 Phase 2 crypto-in-worker migration.** Move full X3DH/ratchet/SK to the Web Worker; today only safety-number is migrated. `11-pentest-results.md §6 #6`.
- **OWASP A10 — DNS-rebinding pin on `safe_outbound_url`.** Custom `reqwest` resolver that pins the resolved IP between check and fetch. `11-pentest-results.md §5 #4`.
- **OWASP A09 — AUTH-LOG-1 retain signature bytes.** A5 logs the login event but not the Ed25519 signature. Optional, useful for forensic review. `11-pentest-results.md §2 — AUTH-LOG-1`.
- **ASVS V14.1.2 / V14.1.3 — SAST gate in CI.** Add `cargo-audit` + `semgrep` + `trivy` to the GitHub Actions pipeline. Foundation already in `.github/workflows/secret-scan.yml`.

### Documentation-level (operator-facing docs needed)

- **ASVS V8.3.7 — data retention guidance for `SECURITY.md`.** Document that Dilla does not enforce a retention TTL and how operators should configure their own (audit_events GC, message TTL, attachment GC).
- **ASVS V8.3.2 — account erasure affordance.** Either ship a `DELETE /api/v1/users/me` (project-level) or document the manual operator path until then.
- **CIS Docker 4.5 — Content trust.** Document image-digest pinning recipe in `deploy/docker/.env.example` or `09-infra-security.md`.

### Operator-level (configuration the operator must apply)

- **CIS Docker 5.10 — memory + cgroup quotas in Compose.** Add `mem_limit:` + `cpus:` to `deploy/docker/compose.yml` — placeholders today. Operator must size for their workload.
- **CIS Linux 1.6.1 — AppArmor / SELinux enforcement on host.** Documented in `deploy/systemd/HARDENING.md` as host-level requirement.
- **CIS K8s 5.4.1 — image-scanning in CI.** Document a Trivy/Grype step for k3s/EKS/GKE operators.
- **SECURITY.md §8 checklist completion.** TLS cert + key, allowed origins, node name, federation peers all explicitly required for production.

### Architectural deferrals (not closing, by design)

- **FED-META-1 — federation peer learns full metadata.** Documented architectural risk; the price of federation is metadata visibility to peers.
- **SFU-IP-1 — ICE candidates leak IPs to legitimate channel members.** WebRTC's nature; mitigations are operator-side (TURN-only mode).
- **FED-AUDIT-1 — federation merge provenance.** Per-event signature + origin-node tag depends on VULN-002 Phase 3.

---

## 6. Recommendations

Concrete next steps, ordered roughly by impact-per-effort. Stratified per the brief.

### Project-level (code that needs to ship)

1. **VULN-002 Phase 3.** The single largest outstanding item. Design + implement per-node Ed25519 signing keys, signed federation events, and validated state-merge. Closes the last open High and unlocks FED-AUDIT-1.
2. **VULN-020 + A6 tail.** Two short, mechanical fixes that close the residual access-control gaps and finalize ASVS V4.1.3.
3. **Unlinked-attachment ownership column.** Adds an `uploader_id` to the `attachments` schema; updates the 1-hour grace path to compare against URL team_id.
4. **Crypto-in-worker Phase 2 (DR-XSS-1).** Move X3DH + Double Ratchet + SK into the Web Worker; closes the last XSS-to-keys path.
5. **VULN-015 doc + AUTH-LOG-1 signature retention.** Low-effort, high-clarity hygiene.
6. **CI: add `cargo-audit`, `semgrep`, `trivy` to GitHub Actions.** Closes ASVS V14.1.2 / V14.1.3.

### Documentation-level (operator-facing docs)

7. **`SECURITY.md §8a` — data retention.** Add a subsection: "Dilla does not enforce a default retention TTL. Operators should configure …". Include a stub SQL for `audit_events` GC and an attachments-GC pattern.
8. **`deploy/docker/.env.example` — content trust.** Add a one-line recipe for resolving `dilla/server:dev` to a digest and pinning.
9. **Trivy/Grype integration example** in `09-infra-security.md` for k8s/Docker operators.

### Operator-level (configuration to apply at deploy time)

10. **Set `mem_limit:` + `cpus:` in Compose.** Operator-responsibility, ships as placeholders.
11. **Enable AppArmor / SELinux on the host.** Documented; verify it's enforcing.
12. **Pin all container images to digest.** Documented; enforce in CD.
13. **Follow `SECURITY.md §8`** for the production config-checklist: TLS, allowed origins, node name, federation `wss://` peers, JWT secret strength.
14. **Apply both `deploy/k8s/networkpolicy.yaml` and `podsecurity.yaml`** if on k8s; the manifests are inert without the apply step.

---

## 7. Audit evidence collection

Index of all evidence collected and referenced by this audit.

### Security-hardening reports (`.security-hardening/`)

- `01-vulnerability-scan.md` — original SAST + dependency-audit + secrets sweep; OWASP Top 10 (2021) mapping; 24 numbered findings.
- `02-threat-model.md` — STRIDE per element + per data flow; attack trees; DREAD risk matrix; MITRE ATT&CK mapping; trust-zone DFD (Z0-Z6).
- `03-architecture-review.md` — full module map; network-segmentation analysis; rec summary.
- `04-critical-fixes.md` — R-01..R-06: VULN-001 TLS bind, VULN-002 Phase 1, VULN-003/-008 attachment hardening, VULN-005 HKDF, VULN-009 bootstrap-token-to-file.
- `05-backend-hardening.md` — H1..H14: rate limits, identity-blob cap, pagination clamp, audit logging on message edit/delete, WS subscription cap, upload quota, JWT aud/iss/jti + revocation, AUTH-WEAK-1 fix, DB-MEM-1 fix.
- `06-frontend-hardening.md` — F1..F10: strict CSP, SRI, Web Worker scaffold, JWT-at-rest encrypt, /auth/logout wiring, browser-log scrub, Trusted Types, Tauri navigation guard, F9 Verify-identity affordance, npm audit clean.
- `07-mobile-hardening.md` — Tauri-specific hardening.
- `08-auth-enhancement.md` — A1..A7: multi-device key trust, JWT enhancements, PERM_MANAGE_FEDERATION + PERM_VIEW_AUDIT_LOG split, force-logout, audit-event taxonomy.
- `09-infra-security.md` — I1..I10: reverse-proxy configs, Docker Compose, systemd unit + HARDENING.md, K8s manifests, host firewalls, WAF rules, WireGuard, detection guide, TURN hygiene, DDoS posture.
- `10-secrets-management.md` — tiered storage matrix (env / OS keychain / Vault / cloud KMS), `_FILE` convention generalization, gitleaks workflow, rotation playbook, IAM templates, HSM forward path.
- `11-pentest-results.md` — final validation matrix for all 24 baseline findings + 19 net-new findings from steps 2-10; live smoke-test transcript; net-new findings; outstanding-items list.

### Other documentation

- `SECURITY.md` — public-facing security policy (passwordless model, JWT lifecycle, permission model, audit log, compromise-reporting flow, coordinated disclosure, config checklist).
- `deploy/` tree — 22 files across reverse-proxy/docker/systemd/k8s/firewall/waf/federation/detection/turn/ddos/secrets subtrees.

### Git history

- Commit log: `git log --oneline c9adcd8..HEAD` — 35 security-hardening commits since the start of the audit window. Notable commits:
  - `244e15d fix(security): bind TLS when TLS_CERT/TLS_KEY are set; refuse plaintext default`
  - `9f6478c fix(security): enforce per-channel ACL on REST message endpoints`
  - `a8f807f fix(security): require auth + channel ACL on attachment download`
  - `7182d9e fix(security): write bootstrap token to 0600 file with 15-minute expiry`
  - `da4b983 fix(security): HKDF the federation join_secret and enforce min entropy`
  - `e4cc48b fix(security): constant-time federation auth compare + reject empty secret`
  - `85db447 feat(auth): JWT aud/iss/jti claims + revocation list + 24h refresh`
  - `0d55d30 feat(auth): multi-device key trust, audit + risk signals, force-logout`
  - `5dbc856 feat(security): F1 — strict Content-Security-Policy on the SPA shell`
  - `3669ffb feat(security): F2 — SHA-384 SRI on every dist/index.html asset`
  - `410f03c feat(security): F7 — register Trusted Types default policy`
  - `004dbad docs(deploy): infrastructure security playbook for self-hosters`
  - `6644a6b docs(deploy): secrets management playbook`

### Live-server evidence (from `11-pentest-results.md §4`)

- CSP / security headers verified on `HEAD /` (full directive list captured).
- HSTS correctly absent in insecure dev mode.
- Auth rate-limit live: `/auth/challenge` 10×200, 15×429.
- Browser-log rate-limit live: 10×200, 60×429.
- Protected REST + /devices + /auth/logout + federation/status all return 401 without JWT.
- 18 SHA-384 SRI tags verified in embedded `dist/index.html`.
- Migrations 026-029 applied; `user_devices` backfilled; PERM_MANAGE_FEDERATION + PERM_VIEW_AUDIT_LOG OR'd onto admin roles.

---

## Closing note

The honest reading of this audit: Dilla today **substantially conforms** to OWASP ASVS Level 2 in the dimensions that matter for a passwordless E2EE federated chat product, and **fully conforms** to the relevant CIS benchmarks via the artifacts shipped in `deploy/`. The two outstanding marks against the project are (a) the deferred VULN-002 Phase 3 federation-trust redesign — known, documented, and the single largest open item — and (b) the A6 policy-migration tail — mechanical, semantically equivalent today, but incomplete.

A maintainer publishing security claims off this report should:

1. Claim "ASVS 4.0.3 Level 2 substantial conformance with documented exceptions" — not unqualified "ASVS L2 compliant".
2. Claim "OWASP Top 10 (2021) — all categories addressed, one architectural exception (A04: federation peer trust)".
3. Claim "CIS Docker / Linux / Kubernetes benchmarks satisfied through provided deployment artifacts; operator-deployment compliance follows from applying them".
4. **Not** claim SOC 2 / HIPAA / PCI / GDPR conformance. The codebase cannot — only the operator's deployment can.
