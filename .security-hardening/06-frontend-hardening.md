# Dilla — Frontend Hardening (Step 6)

**Scope:** `/Users/thim/Repositories/dilla-chat/` — `client/` (React 19 + TS + Vite), `client/src-tauri/` (Tauri 2 desktop shell), `server-rs/src/webapp/mod.rs` (SPA shell handler).
**Branch:** `feat/mesh-redesign`
**Date applied:** 2026-05-21
**Inputs:** `.security-hardening/03-architecture-review.md` (sections 7, 8.4, 9), `.security-hardening/05-backend-hardening.md` (JWT aud/iss, /auth/logout endpoint, browser-log defaults).

Ten conventional commits, no `Co-Authored-By` lines per the user's global instructions. Server rebuilt and restarted at the end of the run with the new embedded `dist/` so the live CSP / SRI / TT policy combination is observable on `http://localhost:8080/`.

---

## 1. Summary table

| # | What | Files | Commit | Closes |
|---|---|---|---|---|
| F1 | Dynamic CSP on SPA shell (wss-only in prod, ws/http in DILLA_INSECURE) + COOP/COEP/nosniff/Referrer-Policy/X-Frame-Options | `server-rs/src/webapp/mod.rs`, `server-rs/src/api/mod.rs` | `5dbc856` | DR-XSS-1, EMB-INTEG-1, VULN-001 (transport), VULN-014 |
| F7 | Trusted Types `default` policy registered before any DOM access — rejects string-to-script eval and javascript:/data:text/html script URLs | `client/src/services/trustedTypes.ts` (new), `client/src/main.tsx` | `410f03c` | DR-XSS-1 (defence in depth) |
| F2 | Post-build SHA-384 SRI on every script / link rel="stylesheet"|"modulepreload" in `dist/index.html` (custom script, no new dep). Fails build if any inline script appears. | `client/scripts/sri.cjs` (new), `client/package.json` | `3669ffb` | DR-SUPPLY-1, EMB-INTEG-1 |
| F3 | Web Worker scaffolding for Signal Protocol crypto + first migrated op (safety-number computation: public-input only, ~SHA-256 × 5200 off main thread) | `client/src/services/crypto/worker.ts` (new), `client/src/services/crypto/workerClient.ts` (new), `client/src/services/crypto/cryptoManager.ts` | `13eea15` | DR-XSS-1 (partial), DR-SUPPLY-1 (partial) |
| F4 | Encrypt JWT/team-tokens at rest in sessionStorage with the existing non-extractable AES-GCM wrap key + audit (no token logging anywhere) | `client/src/stores/authStore.ts`, `client/src/hooks/useCryptoRestore.ts` | `f3fd854` | OWASP A07 (insecure auth storage) |
| F5 | Wire client to new `POST /api/v1/auth/logout` (per server H2). Revokes per-server (not per-team) on Settings → Sign out, falls back with in-app warning if server unreachable | `client/src/services/api.ts`, `client/src/shell/Settings.tsx` | `a7d9e15` | (server H2 follow-up) |
| F6 | PII scrubbing in browser-log relay: JWT triples, Authorization Bearer headers, base64-ish ≥40-char blobs → [REDACTED]. 2 KiB per-line cap. | `client/src/services/browserLogs.ts`, `client/src/services/browserLogs.test.ts` (new) | `e196382` | VULN-010 (client side) |
| F8 | Tauri navigation guard (allow tauri://, *.tauri.localhost, debug-only dev ports, 127.0.0.1:65530..65534) + tighten Tauri CSP + commit `Cargo.lock` (TAU-SUPPLY-1) | `client/src-tauri/src/main.rs`, `client/src-tauri/tauri.conf.json`, `client/src-tauri/Cargo.lock` (new), `.gitignore` | `68193fb` | TAU-SUPPLY-1, TAU-NAV-1 |
| F9 | "Verified ✓" / "Verify identity" affordance in UserProfile popover wired into existing verifiedContactsStore + SafetyCompare modal | `client/src/components/UserProfile/UserProfile.tsx`, `client/src/components/UserProfile/UserProfile.css` | `bb03b16` | X3DH-MITM-1 (partial) |
| F10 | `npm audit` rerun | n/a | n/a | 0 vulnerabilities reported; no carryforward needed |

`npm run build` is clean after every commit. `cargo build --release` is clean after F1. `cargo test --bin dilla-client tests::` passes the 6 new navigation-guard tests at F8. Six new vitest unit tests for `scrubLogLine` at F6 all pass. UserProfile.test.tsx's 16 existing tests still pass at F9.

---

## 2. Per-item detail

### F1 — Strict CSP (commit `5dbc856`)

The webapp router now emits a CSP that:

- starts from `default-src 'self'`,
- forbids inline scripts entirely (`script-src 'self'`),
- allows the React 19 + OTel auto-instrumentation inline style tags (`style-src 'self' 'unsafe-inline'`; audited — no inline script remains),
- restricts `connect-src` to `wss:`/`https:` in production and additionally allows `ws:`/`http:` when `cfg.insecure=true` so the dev pattern (`DILLA_INSECURE=true` + Vite proxy to `http://localhost:8080`) keeps working,
- allows blob: workers (`worker-src 'self' blob:`) for F3's crypto worker + voice worklets,
- forbids `object-src`, `frame-ancestors`, refuses base/form action redirection (`object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`),
- emits `upgrade-insecure-requests` so any rogue `http://` reference is auto-rewritten,
- emits `require-trusted-types-for 'script'; trusted-types default` — F7 (the client-side policy registration) is the matching pair.

The `WebappSecurity { insecure: bool }` struct is the propagation point — `api::mod::create_router` reads `state.config.insecure` and threads it into `webapp_fallback(security)`. Tests cover both the secure-mode + insecure-mode branches.

Defence-in-depth headers added at the same layer:
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- (existing) `Cross-Origin-Opener-Policy: same-origin`
- (existing) `Cross-Origin-Embedder-Policy: require-corp`

### F7 — Trusted Types `default` policy (commit `410f03c`)

The CSP from F1 includes `require-trusted-types-for 'script'; trusted-types default` — without a matching client-side policy, every DOM string sink (innerHTML, script.src, Worker(url), setTimeout(string), …) throws a TypeError in Chromium-based browsers.

`installTrustedTypesPolicy()` registers a `default` policy at the very top of `main.tsx` (before `installBrowserLogRelay`) that:

- passes HTML through (react-markdown's `skipHtml: true` already blocks the raw-HTML branch) but strips script tags as a second line of defence,
- refuses string-to-script eval outright,
- refuses `javascript:` / `data:text/html` script URLs.

Idempotent — safe under Vite HMR.

### F2 — SHA-384 SRI on every shipped chunk (commit `3669ffb`)

`scripts/sri.cjs` runs after `vite build`. It:

1. asserts no inline script exists in `dist/index.html` (would violate F1's CSP) — exits non-zero if it finds one,
2. walks every `<script src=...>` and `<link rel="stylesheet|modulepreload|preload" href=...>` whose URL resolves to a local file under `dist/`,
3. computes SHA-384 base64 of the file, rewrites the tag to add `integrity="sha384-..."` + `crossorigin="anonymous"`,
4. is idempotent (skips tags that already carry `integrity=`).

A tiny script (~100 lines) instead of `vite-plugin-sri4` to limit transitive supply-chain creep — see architecture review section 8.4 bullet 3.

After `npm run build`, dist/index.html is rewritten with 18 tags (1 stylesheet + 1 script + 16 modulepreloads on the current build). Sample line from the live `dist/index.html`:

```
<link rel="stylesheet" href="/fonts/fonts.css" integrity="sha384-DaBYpgEMFa2P8UyJdHNR0j6LGbMHfHDXhq/zEHBKM7WexxJuK0q8avozTJKN1a5V" crossorigin="anonymous">
```

### F3 — Crypto Worker scaffolding + one migrated op (commit `13eea15`)

Per the brief's explicit scope-down ("scaffolding + ONE operation … if 2+ days of work"), this commit:

- introduces `client/src/services/crypto/worker.ts` — Web Worker entry point with command-dispatch + structured request/response,
- introduces `client/src/services/crypto/workerClient.ts` — main-thread RPC client (id-correlated, 10s timeout, error-isolated) with a `CRYPTO_BACKEND` toggle (default `worker`, tests force `main`),
- migrates **safety-number computation** as the first op. Specifically chosen because:
  - inputs are PUBLIC (identity public keys + stable IDs) — no secret material crosses postMessage,
  - it's the most CPU-bound op (SHA-256 ×5200) so moving it off-thread also helps responsiveness in the Settings → Identity reveal panel,
  - it has no in-memory state to coordinate (vs. ratchet/group sessions, which would need the IndexedDB handle to move too).

`cryptoManager.getSafetyNumber()` now calls `safetyNumberInWorker()` with a fallthrough to the in-thread impl on Worker-spawn failure (jsdom, hostile iframe). All existing tests still pass without modification.

**TODO (follow-up tickets, each its own PR):**

- X3DH initiate / respond inside the worker (needs prekey-secret access in worker scope).
- Double Ratchet encrypt / decrypt inside the worker (needs ratchet state in worker, plus moving the IndexedDB handle off the main thread).
- Group sender-key derivation / rotation inside the worker.
- OPFS-backed encrypted state blob commit pattern (the "worker writes encrypted blob → main thread persists to IndexedDB" loop the brief sketches).

### F4 — Encrypted-at-rest token storage (commit `f3fd854`)

JWTs already live in `sessionStorage` (per-tab, cleared on close — done before this step). This commit adds the client-side encryption-at-rest layer requested in F4(b):

- New encrypted sessionStorage keys `dilla_teams:enc` and `dilla_servers:enc`. Encrypted with the existing non-extractable session wrap key (AES-GCM-256, stored in IndexedDB, per-tab).
- Plaintext keys `dilla_teams` / `dilla_servers` still get a sync best-effort write so a tab close mid-encryption doesn't drop teams; the async path then overwrites with the encrypted copy and removes the plaintext key on success.
- `restoreEncryptedAuthData()` + `restoreEncryptedAuthDataIntoStore()` for the async restore path, wired into `useCryptoRestore` so the encrypted blob is decrypted-and-applied before crypto init.
- `logout()` clears both legacy and encrypted keys.

**Audited:** no `console.log` of a JWT or refresh token value anywhere in `client/src/services/`. No Sentry / breadcrumb path exists today, so there's nothing to scrub there.

**Out of scope (documented):** full httpOnly-cookie migration. Would need server-side cookie issuance + a separate token-cookie domain story; tracked as a follow-up ticket. The challenge-response auth model (Ed25519 signature → JWT, no traditional refresh token) means a stolen sessionStorage blob is less catastrophic than in a refresh-token system — the attacker still needs the passkey or passphrase to obtain a fresh token once the current one expires.

### F5 — Wire `/auth/logout` from the client (commit `a7d9e15`)

- New `api.logoutServer(baseUrl, token)` — single POST, swallows network errors, returns boolean so the call site can react without a thrown promise.
- Settings → "Sign out" calls `logoutServer` once per server (deduplicated by baseUrl — every team on a server shares a token) BEFORE clearing local state.
- On any failed call (no server reachable), the user gets an in-app dialog notification (`dilla:notify` event, no browser alert per project conventions) explaining the server-side revocation may have failed.
- Local cleanup happens unconditionally — sign-out cannot leave the tab in a half-logged-in state even if every server is unreachable.

### F6 — PII scrubbing in browser-log forwarder (commit `e196382`)

`scrubLogLine` runs on every queued entry before flush, in order:

1. JWT-shaped triples `eyJ…header.payload.signature` → `[REDACTED-JWT]` (caught before the dot-splitting `LONG_TOKEN_RE` would split them).
2. `Authorization: Bearer xxx` → keeps `Bearer ` literal, replaces value with `[REDACTED]`.
3. Any base64-ish ≥40-char blob → `[REDACTED]`. Catches Ed25519 sigs (88 b64 chars), AES-GCM ciphertext, refresh tokens, identity blobs.

Plus a 2 KiB per-line cap so runaway error stacks don't inflate the relay payload to multi-MB.

Six unit tests cover JWT, Bearer, long-blob, short-id passthrough, truncation, and empty-string edge cases. All pass.

### F8 — Tauri navigation guard + Cargo.lock (commit `68193fb`)

Three changes wrapped together because they all sit on the same Tauri surface:

1. **Navigation allow-list.** A small Tauri 2 plugin (`navigation_guard_plugin`) hooks `on_navigation` and returns `false` for any URL that isn't `tauri://`, `*.tauri.localhost`, an allow-listed Vite dev port (`localhost:{5173,8888,8080}`, debug-only), or the WebAuthn auth-server loopback range (`127.0.0.1:65530..65534`). Refusals are logged to stderr. Six unit tests cover allow/block matrix.

2. **CSP + window security tightened in `tauri.conf.json`** — added `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`, `freezePrototype: true`. The CSP now mirrors the server-side CSP from F1 (modulo `wss:`-only — Tauri's WebView IS the SPA shell, no plain in-app `ws:`).

3. **`Cargo.lock` committed for the Tauri client (TAU-SUPPLY-1).** `.gitignore` now explicitly includes `client/src-tauri/Cargo.lock` so the resolved dependency tree is pinned and a hostile crates.io publish can't sneak in on the next CI build.

**Tauri devtools toggle:** the existing `cfg!(debug_assertions)` gate baked into `tauri::generate_context!()` already excludes devtools from release builds. Documented escape hatch: `cargo tauri dev` keeps devtools available because it builds in debug mode.

### F9 — "Verified ✓" / "Verify identity" affordance (commit `bb03b16`)

The full SafetyCompare modal + verifiedContactsStore already existed in the codebase (`client/src/components/SafetyCompare/`, `client/src/stores/verifiedContactsStore.ts`). What was missing was the at-a-glance affordance at the surface where users most often see a contact's identity — the profile popover.

The `UserProfile` popover now shows:

- **unverified:** subtle "Verify identity" ghost button (mono-uppercase, hairline border).
- **verified:** accent-tinted "Verified ✓" badge.
- **changed:** warning-tinted "Re-verify identity" prompt (their key rotated since last compare).

Click fires the existing `dilla:verify-safety` window event so SafetyCompare handles the actual SAS comparison UX — single source of truth for the compare flow.

### F10 — npm audit (no commit)

`npm audit` reports **0 vulnerabilities** at the current `client/package-lock.json`. No carryforward changes needed.

---

## 3. CSP — final live value

Verified live on the running server (`curl -sI http://localhost:8080/`) on 2026-05-21 with `DILLA_INSECURE=true`:

```
content-security-policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' ws: wss: http: https:; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests; require-trusted-types-for 'script'; trusted-types default
```

With `DILLA_INSECURE=false` (production), `connect-src` collapses to `'self' wss: https:` only — verified by unit test `webapp_routes_have_strict_csp_in_secure_mode`.

---

## 4. SRI — sample line from `dist/index.html`

After `npm run build`:

```html
<link rel="stylesheet" href="/fonts/fonts.css"
      integrity="sha384-DaBYpgEMFa2P8UyJdHNR0j6LGbMHfHDXhq/zEHBKM7WexxJuK0q8avozTJKN1a5V"
      crossorigin="anonymous">
```

Every script src=... and link rel="stylesheet|modulepreload|preload" href=... whose URL resolves under `dist/` carries the same shape. 18 tags rewritten in the current build (1 stylesheet, 1 script, 16 modulepreloads).

---

## 5. Worker scaffolding — what's moved, what's pending

**Moved into the worker (`client/src/services/crypto/worker.ts`):**

- `safetyNumber.compute` — wraps `generateSafetyNumber(ourIdentityKey, ourId, theirIdentityKey, theirId)`. Returns the 60-digit decimal string. Both inputs are PUBLIC identity keys; no secret state crosses postMessage. CPU cost: ~10k SHA-256 hashes, was previously blocking the main thread.

**Wired but not migrated yet (still in-thread):**

- `CryptoManager.encryptDM` / `encryptChannel`
- `CryptoManager.decryptDM` / `decryptChannel`
- `CryptoManager.initSessionWithBundle` (X3DH initiate)
- `CryptoManager.processSenderKey`, `getSenderKeyDistribution`, `rotateChannelKey`
- `CryptoManager.generatePrekeyBundle` (prekey secrets — main blocker for full migration)
- `CryptoManager.wrapForPeer` / `unwrapFromPeer`
- All session persistence (IndexedDB handle currently lives on main thread)

**RPC plumbing built out (ready for next migration):**

- id-correlated request/response with 10s timeout per call
- single shared worker instance lazy-spawned on first call
- error-isolated: a worker crash fails every pending call and resets the worker
- `CRYPTO_BACKEND` flag for forcing main-thread execution (tests, fallback when `Worker` is undefined)

**Next-step ticket(s) the maintainer should file:**

1. Move IndexedDB session-store access into the worker. Specifically: `client/src/services/crypto/sessionStore.ts` + `client/src/services/keyStore.ts` should be loaded by `worker.ts` and never imported on the main thread. This is the structural blocker for all remaining migrations.
2. Migrate `getSenderKeyDistribution` + `rotateChannelKey` into the worker (good second op — read-mostly, no peer-bundle fetch needed).
3. Migrate `initSessionWithBundle` + `processSenderKey` — these are write-once-per-peer/-channel, low contention.
4. Migrate `encryptDM`/`encryptChannel`/`decryptDM`/`decryptChannel` last — hot path, needs careful benchmark before/after.

---

## 6. Outstanding items / follow-up tickets

- **Full crypto-in-worker migration** (per section 5). Largest remaining piece of architecture review section 8.4 bullet 1. Track as `DR-XSS-1 phase 2`.
- **Timeline banner on identity-key rotation** (section 8.4 bullet 5, the "safety number with @alice changed — review?" banner). Today the rotation is detectable via `verifiedContactsStore.isVerified() === 'changed'` but only surfaces in the profile popover and the SafetyCompare modal — not on the message timeline.
- **httpOnly cookie issuance** (out of scope per brief). The client-side encryption layer added in F4 is a stopgap; long-term JWTs should live in an httpOnly Secure SameSite=Strict cookie set by the server, with CSRF-token routing for state-changing requests. Server-side change required.
- **Sentry / breadcrumb scrubbing** — non-issue today (no Sentry in the bundle) but if it lands, F6's `scrubLogLine` should be reused on the breadcrumb feed before send.
- **WAF rules on the reverse proxy.** Recommended in section 9 bullet 1 of the architecture review. Not a code change in this repo, but Caddy/nginx examples should land in the deploy docs.
- **DILLA_BROWSER_LOG_FORWARD documentation in CLAUDE.md.** Step 5 H8 changed the default from "follows INSECURE" to "always-off". The dev pattern in CLAUDE.md sets it explicitly, so the dev loop is unaffected, but the wider docs/changelog should reflect the default flip. (Same outstanding item the H8 commit listed.)
- **Tauri devtools toggle in non-debug builds.** Tauri 2's `tauri::generate_context!()` already excludes devtools from release builds by default — verified at compile time. No new code needed; the documented escape hatch is `cargo tauri dev`.

---

## 7. Regression notes

- **CSP `script-src 'self'`** — if a future PR introduces an inline script in `client/index.html` (e.g. an analytics snippet), the F2 SRI script's inline-script assertion will fail the build, and at runtime the CSP will refuse the script. The remediation is to move the script into a `.ts` file under `src/` so Vite bundles it as a hashed module.
- **Trusted Types policy refuses string-to-script eval** — code that calls `setTimeout(stringLiteral, ms)` or builds runtime Function objects from strings will throw in Chromium. The CSP already blocks the same surface; F7's policy makes the failure earlier and more locally diagnosable.
- **SessionStorage encrypted blobs** — after F4, opening DevTools Storage → Session Storage will show `dilla_teams:enc` / `dilla_servers:enc` as base64 ciphertext instead of plain JSON. This is intentional. The plaintext keys may briefly appear and then disappear during a tab boot — that's the legacy migration path.
- **Tauri nav guard logs to stderr** — any blocked navigation prints `[security] refused in-window navigation to <url> (F8 nav guard)`. Don't filter this out of CI / dev logs without first understanding what's being refused.
- **`/auth/logout` failure path** — when a server is unreachable at sign-out time, the user sees a `dilla:notify` toast (NOT a browser alert). Local state is cleared regardless. The server-side token is still valid until natural expiry; if you actually need an offline kill switch, the server's TTL (24 h in step 5 H2) is the upper bound.
- **`Cargo.lock` for Tauri now in git.** Future Tauri-side dep bumps must `git add Cargo.lock` along with `Cargo.toml`. The Tauri build no longer floats to "latest semver-compatible" on every machine.

---

## 8. Verification commands

```bash
# Lint (passes for every file this step touched):
cd client && npx eslint src/services/trustedTypes.ts src/main.tsx \
  src/services/crypto/worker.ts src/services/crypto/workerClient.ts \
  src/services/crypto/cryptoManager.ts src/stores/authStore.ts \
  src/hooks/useCryptoRestore.ts src/services/api.ts src/shell/Settings.tsx \
  src/services/browserLogs.ts src/services/browserLogs.test.ts \
  src/components/UserProfile/

# Client build (lint + tsc + Vite + SRI rewrite):
cd client && npm run build

# Server build:
cd server-rs && cargo build --release

# Tauri nav-guard tests:
cd client/src-tauri && cargo test --bin dilla-client tests::

# Browser-log scrub tests:
cd client && npx vitest run src/services/browserLogs.test.ts

# Live CSP check:
curl -sI http://localhost:8080/ | grep -i content-security-policy

# Live SRI check (run after npm run build):
grep -c 'integrity="sha384-' client/dist/index.html
# Expected: 18 (or whatever the current Vite chunk count is)
```
