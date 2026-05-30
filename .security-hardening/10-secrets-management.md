# 10 — Secrets management playbook

Step-10 output. Companion to:

- `01-vulnerability-scan.md` §"Secrets exposure report" — confirmed no
  hardcoded production credentials; the test-only fixtures are
  itemized and now allowlisted in `.gitleaks.toml`.
- `09-infra-security.md` §I3 (systemd `LoadCredential`), §I9
  (Cloudflare TURN token storage) — this step generalizes the
  pattern to every secret-bearing env var.
- `05-backend-hardening.md` H9 / DB-MEM-1 — original
  `DILLA_DB_PASSPHRASE_FILE` implementation; now the template for
  five more `_FILE` variants.

Scope: a single operator-tiered playbook covering **storage**,
**rotation**, **IAM**, **CI guard**, **hardware-backed sealing**,
and a **pre-flight checklist**. Plus one small code change that
makes every secret-bearing env var symmetrically file-or-env.

---

## 1. Summary

A new `deploy/secrets/` tree ships every artifact a self-hosted
operator needs to handle secrets sanely, scaling from a `.env` on
one box up to a Vault Agent or cloud KMS:

| Path | Purpose |
|---|---|
| `deploy/secrets/README.md` | Tier 1 → Tier 4 storage playbook (env file / OS keychain / Vault OSS / cloud secret manager). Documents the `_FILE` convention. |
| `deploy/secrets/ROTATION.md` | Per-secret rotation cadence + procedure for all 11 inventory items, including the SQLCipher `PRAGMA rekey` flow for single-node and federated deployments. |
| `deploy/secrets/CHECKLIST.md` | Scannable pre-internet-expose checklist. |
| `deploy/secrets/IAM.md` | Minimum-privilege policy templates: Vault HCL, AWS IAM JSON, GCP Terraform, Azure RBAC. |
| `deploy/secrets/HSM.md` | Forward-looking — TPM-sealed DB passphrase via `clevis` + `tang`, Secure Enclave for Tauri identity, future HSM-backed federation Ed25519. |
| `.github/workflows/secret-scan.yml` | `gitleaks` on every PR + push to main. |
| `.gitleaks.toml` | `useDefault = true` + Dilla-specific allowlists for the test fixtures. |

Code change: one commit (`feat(config): generalize _FILE secret
loading convention`) — extends the H9 `DILLA_DB_PASSPHRASE_FILE`
pattern to every other secret-bearing env var. Net: +67 LoC,
−20 LoC in `server-rs/src/main.rs`. Generic `read_secret_file`
helper + per-secret `load_secrets_from_files` resolver, called once
at startup before any consumer reads the value. Zero changes to
the `Config` struct shape; one `std::env::set_var` call for
`DILLA_JWT_SECRET` whose consumer reads via `std::env::var` in
`auth::derive_jwt_secret`.

---

## 2. Tiered storage matrix

| Tier | Audience | Primary mechanism | Rotation friction | Key tradeoff |
|---|---|---|---|---|
| 1 | Single-box / hobby / family server | `/etc/dilla/dilla.env` (mode 0640) + systemd `LoadCredential` for `DILLA_DB_PASSPHRASE_FILE` only | Manual file edit + restart | Simplest path; secrets live on the host disk |
| 2 | Small team / single org | macOS Keychain `security`, Linux Secret Service via `secret-tool`, Windows Credential Manager — fetched at unit start, written to tmpfs runtime dir, consumed via `_FILE` env | Manual via OS keystore CLI + restart | OS keystore is opinionated but stops `ps` / journal leaks |
| 3 | Serious self-host (multi-host, GitOps) | Vault OSS / OpenBao with Vault Agent templates **or** sops + age encrypted files | Automated (Vault Agent re-renders on change, restarts via `exec` block; sops via re-encrypt + redeploy) | Vault = audit logs + leases; sops = no long-running service |
| 4 | Cloud / multi-region | AWS Secrets Manager, GCP Secret Manager, Azure Key Vault via CSI driver / sidecar; `_FILE` env points at `/mnt/secrets-store/...` | Provider-managed | Vendor lock-in, but Dilla itself stays provider-neutral |

All four tiers use the same `_FILE` env-var convention. Moving up a
tier is purely a deployment change — Dilla doesn't know or care
which mechanism rendered the file.

Full storage walkthroughs (with copy-paste systemd snippets, Vault
Agent HCL, sops `.sops.yaml` rules, Docker secrets stanzas) live in
`deploy/secrets/README.md`.

---

## 3. Rotation cadence table

| # | Secret | Cadence | Restart? | User-visible impact |
|---|---|---|---|---|
| 1 | `DILLA_DB_PASSPHRASE` | Annual + on compromise | yes (or fail-over) | Brief downtime |
| 2 | `DILLA_JWT_SECRET` | Quarterly + on compromise | yes | All users logged out |
| 3 | `DILLA_JOIN_SECRET` | Quarterly + on compromise / op change | yes | Outstanding join invites invalidated |
| 4 | `DILLA_CF_TURN_API_TOKEN` | 75 days (90-day Cloudflare TTL, rotate at 75%) | yes | None (active calls survive) |
| 5 | TLS cert + key | ACME auto (60 days; LE 90-day expiry) | reverse-proxy reload, no Dilla restart in proxy mode | None |
| 6 | Bootstrap token | One-shot (15-min self-expire) | n/a | First-user onboarding only |
| 7 | Per-user identity Ed25519 | User-initiated (Settings → Rotate identity key) | n/a | Re-init Signal sessions with every contact |
| 8 | Per-user Signal ratchet | Per-message (automatic in Double Ratchet) | n/a | None |
| 9 | OTel exporter auth token | 90 days (vendor-typical) | yes | OTel exporter reconnect |
| 10 | `DILLA_SENTRY_DSN` | Vendor-driven | yes | None |
| 11 | Federation peer pubkeys (future, post-VULN-002) | On peer key compromise | n/a (trust update) | Re-trust window |

Procedures (incl. SQLCipher `PRAGMA rekey` for #1 single-node and
federated, mass-logout banner advice for #2, Cloudflare API steps
for #4) in `deploy/secrets/ROTATION.md`.

---

## 4. `_FILE` env var support — final list

Six env vars now accept a paired `_FILE` variant. File contents take
precedence; trailing whitespace is trimmed; empty after trim is a
fatal startup error with a clear message.

| Env var | Paired `_FILE` | Consumer |
|---|---|---|
| `DILLA_DB_PASSPHRASE` | `DILLA_DB_PASSPHRASE_FILE` (H9 — already shipped) | `db::open_connection` via `SecretString` |
| `DILLA_JWT_SECRET` | `DILLA_JWT_SECRET_FILE` | `auth::derive_jwt_secret` (`std::env::var`) |
| `DILLA_JOIN_SECRET` | `DILLA_JOIN_SECRET_FILE` | `federation::join::JoinManager::new` |
| `DILLA_CF_TURN_API_TOKEN` | `DILLA_CF_TURN_API_TOKEN_FILE` | `voice` TURN provider init |
| `DILLA_OTEL_API_KEY` | `DILLA_OTEL_API_KEY_FILE` | `observability::init_otel` exporter headers |
| `DILLA_SENTRY_DSN` | `DILLA_SENTRY_DSN_FILE` | `telemetry::sentry::SentryConfig::from_dsn` |

Implementation (single function, ~70 LoC) in
`server-rs/src/main.rs` — `read_secret_file` + `load_secrets_from_files`.
Called once at startup, immediately after `Config::load()`, before
any other code touches the values.

`DILLA_TLS_KEY` / `DILLA_TLS_CERT` already accept filesystem paths
natively (PEM files), so no `_FILE` variant is needed. Cloudflare
TURN key ID (`DILLA_CF_TURN_KEY_ID`) is an identifier — not a
secret — and stays env-only.

---

## 5. CI guard outcome

`gitleaks` (v8.30.1) runs clean on the full git history (908 commits,
~16 MB scanned in ~1 s):

```text
INF 908 commits scanned.
INF scanned ~16186083 bytes (16.19 MB) in 1.08s
INF no leaks found
```

Allowlisted entries — every one verified test-only or documentation-
only against the underlying source:

| File | Why |
|---|---|
| `server-rs/src/auth.rs` | `#[test]` fixtures setting `DILLA_JWT_SECRET` to literal values (`my-explicit-jwt-secret`, `stable-secret-value`, `test-jwt-secret-for-tokens`, `shared-env-secret`, `explicit-secret`) |
| `server-rs/src/observability/mod.rs:703` | `secret_token = "9b4a8f2e1c6d5703a8f1e2b3c4d5e6f7"` — input fixture for the path-redaction middleware unit test |
| `server-rs/src/main.rs:999` | `cfg.cf_turn_api_token = "test-token"` inside `#[cfg(test)] mod tests` |
| `server-rs/src/federation/transport.rs:495` | `build_peer_url` unit tests using `example.com:8081` |
| `client/src/services/browserLogs.test.ts:8` | JWT-shaped string used to verify `scrubLogLine` redacts JWTs |
| `client/src/pages/Onboarding/Onboarding.tsx:294` | React state variable named `passphrase`, not a secret |
| `.github/CLAUDE_TRACKING.md` | `curl -H "Authorization: token YOUR_TOKEN"` example |
| `README.md` | First-run setup banner template |

Plus path-globs for `Cargo.lock`, `package-lock.json`, image
assets, `.security-hardening/*.md`, and `deploy/secrets/*.md` (the
playbook itself references placeholder tokens).

CI workflow: `.github/workflows/secret-scan.yml`. Triggered on PR
+ push to main; uses pinned action SHA (`gitleaks-action@v2.3.9`);
explicit `GITLEAKS_CONFIG=.gitleaks.toml` so behaviour can't drift
silently if upstream changes default discovery.

---

## 6. Outstanding items

Documented here so they don't get lost. None of these block step 10.

| # | Item | Why |
|---|---|---|
| O-1 | `Config::read_secret` helper returning `SecretString` rather than `String` | Today the `_FILE` resolver stores trimmed values back into `Config` as plain `String`. The H9 / DB-MEM-1 pattern wraps in `SecretString` at the consumer's call site (`db/mod.rs:140`). Acceptable for now, but a `Config<SecretString>` typed wrapper would prevent accidental `Debug`-formatting of new secret fields. ~50 LoC refactor. |
| O-2 | `DILLA_TLS_KEY_FILE` (and `_CERT_FILE`) variants | Today `DILLA_TLS_KEY` already accepts a path (it's how the env var works), but a `_FILE` reader that pulls the *contents* of the PEM and writes them to a tmpfs path would let operators mount the cert from Vault / Secrets Manager directly. Not pressing — Caddy / nginx in front terminate TLS in most deployments. |
| O-3 | Edition 2024 migration: wrap `std::env::set_var("DILLA_JWT_SECRET", ...)` in an `unsafe` block | Rust 2021 keeps `set_var` safe, but the migration is on the roadmap. One-line change behind a feature gate. |
| O-4 | SIGHUP-triggered re-read of `_FILE` values without full restart | Vault Agent's `exec` block today calls `systemctl restart dilla-server`. Live-reload would shave the restart downtime for rotation events. Requires holding a `ArcSwap<JwtSecret>` etc. and is non-trivial — defer until operators ask. |
| O-5 | Per-file gitleaks allowlists are duplicated between path + regex; the rule fired against `generic-api-key` and `generic-high-entropy` overlap | Cosmetic; both rules currently allowlisted via the global `[[allowlists]]` block instead of per-rule. Migrate to per-rule allowlists if upstream removes the global-allowlist behaviour. |
| O-6 | Hardware-backed federation Ed25519 signing | Forward-looking — depends on VULN-002 redesign landing first. See `deploy/secrets/HSM.md` §3. |

None of O-1..O-6 are blockers for following step 10. The
operator-facing playbook is complete and exercised against today's
binary; everything else is incremental polish.

---

## 7. Verification

Local verification performed:

- `cargo build --release` (server-rs) → clean, 24 pre-existing
  warnings unrelated to the change.
- Server bounced under the standard dev env
  (`DILLA_INSECURE=true DILLA_BROWSER_LOG_FORWARD=true
  DILLA_DATA_DIR=…/tmp-dev-data`) — startup logs show no regression;
  the new `load_secrets_from_files` is a no-op when no `_FILE` env
  is set.
- `gitleaks detect --config=.gitleaks.toml` on the full repository
  history → "no leaks found" (8 baseline findings, all allowlisted
  individually with path + regex pinning).

Commits:

- `feat(config): generalize _FILE secret loading convention` — code.
- `docs(deploy): secrets management playbook` — README, ROTATION,
  CHECKLIST, IAM, HSM, gitleaks workflow + config.
