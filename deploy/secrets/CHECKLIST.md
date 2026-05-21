# Dilla — pre-deployment secret-hygiene checklist

Tick before you open a port to the internet. One scannable list;
deeper rationale lives in `README.md`, `ROTATION.md`, and
`.security-hardening/`.

---

## Server secrets

- [ ] `DILLA_DB_PASSPHRASE` (or `DILLA_DB_PASSPHRASE_FILE`) is set to a
      **≥ 32-byte random** value. Not `changeme`, not your domain name,
      not the example value from `.env.example`. Generate with
      `openssl rand -base64 48`.
- [ ] If using `DILLA_DB_PASSPHRASE_FILE`: file is mode **0400**, owner
      `dilla` (or `root` when consumed via systemd `LoadCredential`),
      and either mounted from tmpfs (`/run/...`) or outside any backup
      that uses the same passphrase.
- [ ] `DILLA_JOIN_SECRET` (or `_FILE`) set if **any** federation peer
      is configured. `openssl rand -base64 48`. Server refuses to start
      with empty `DILLA_JOIN_SECRET` and non-empty `DILLA_PEERS`
      (VULN-021 fix).
- [ ] `DILLA_JWT_SECRET` (or `_FILE`) set explicitly **OR** you've
      acknowledged that JWT keys are HKDF-derived from the DB
      passphrase and will roll on every DB re-key.
- [ ] `DILLA_CF_TURN_API_TOKEN` (or `_FILE`) set only via
      `_FILE` for Tier 2+ deployments. The token is operator-supplied
      and should be scoped to **Calls API → Edit only** in the
      Cloudflare dashboard.

## Source control

- [ ] No secret values in `.env` files committed to git. Run
      `gitleaks detect --no-banner` locally; CI runs this on every PR
      (see `.github/workflows/secret-scan.yml`).
- [ ] `.env.example` only contains placeholders (`changeme`,
      `your-secret-here`). Verify before each release.
- [ ] `.env`, `.env.local`, `secrets.enc.yaml`, `keys.txt`, `*.pem`
      are all in `.gitignore` at the repo root.
- [ ] Encrypted secret files (sops-encrypted, ansible-vault-encrypted)
      are fine to commit, but only after a second operator has
      verified the encryption is intact.

## Insecure overrides

- [ ] `DILLA_INSECURE=true` removed from production env. The flag
      bypasses the empty-DB-passphrase guard, allows `ws://` federation
      peers, opens CORS, and disables the TLS pre-flight check.
      Production must have it unset or `false`.
- [ ] `DILLA_BROWSER_LOG_FORWARD` is unset or `false` in production.
      The endpoint accepts unauthenticated POSTs (VULN-010) until a
      JWT requirement ships; only enable in dev.

## First-run hygiene

- [ ] Bootstrap token file `${DATA_DIR}/BOOTSTRAP_TOKEN` is **deleted**
      after first-user signup:
      ```sh
      sudo shred -u /var/lib/dilla/BOOTSTRAP_TOKEN
      ```
      The token self-expires in 15 minutes, but the file should still
      not be left lying around (CHECKLIST §7 hardening).
- [ ] The first user account created via the bootstrap is the admin /
      ops user — not a "team member" account that will later be
      demoted.

## TLS / cert hygiene

- [ ] If terminating TLS at Dilla (uncommon — most operators terminate
      at Caddy/nginx/Traefik): `DILLA_TLS_CERT` and `DILLA_TLS_KEY`
      both set; key file is mode 0400, owner `dilla`.
- [ ] If terminating TLS upstream: `DILLA_INSECURE=true` (acknowledges
      Dilla itself runs plaintext on loopback) is documented in your
      runbook so the warning in startup logs isn't surprising.
- [ ] HSTS is enabled at the reverse proxy (it's in all three example
      configs at `deploy/reverse-proxy/`).
- [ ] Certificate auto-renewal works — test with `acme.sh --renew
      --force` or `certbot renew --dry-run`.

## TURN / voice

- [ ] Cloudflare TURN API token scope verified: **Calls → Edit only**,
      no other permissions. See `deploy/turn/README.md` §scope.
- [ ] Cost ceiling configured in Cloudflare dashboard (monthly TURN
      bytes alert at e.g. 100 GB).
- [ ] Token rotation calendar reminder set for ≤ 75 days from creation.

## Backups

- [ ] `${DATA_DIR}` (which contains `dilla.db` plus uploads) is included
      in your backup tool's path list.
- [ ] Backups are **encrypted with a different key** than
      `DILLA_DB_PASSPHRASE`. Recommendation: `restic` with its own
      repository password, or `borg` with `repokey-blake2`.
- [ ] At least one offline copy of `DILLA_DB_PASSPHRASE` exists
      (printed paper, hardware token, sealed envelope) outside any
      backup that's encrypted with it. Losing the passphrase = losing
      the DB permanently.
- [ ] Restore tested end-to-end in the last quarter. A backup you
      can't restore is the same as no backup.

## Telemetry

- [ ] If `DILLA_TELEMETRY_ADAPTER=sentry`: `DILLA_SENTRY_DSN_FILE`
      points at a file containing only the DSN, mode 0400.
- [ ] If `DILLA_OTEL_ENABLED=true`: `DILLA_OTEL_API_KEY_FILE` set the
      same way.
- [ ] **No PII in OTel attributes or Sentry breadcrumbs.** Step 6 F6
      added a redaction pipeline; double-check by triggering a known
      error in staging and inspecting what arrives at the collector.

## Network

- [ ] Reverse proxy is the only host listening on 80/443. Dilla binds
      to 127.0.0.1.
- [ ] If federating: federation listener bound to WireGuard interface
      only (see `deploy/firewall/`, `deploy/federation/wireguard.example.conf`).
- [ ] UFW / nftables / pf rules in place from `deploy/firewall/`.
      Default-deny both directions.

## Final smoke

- [ ] `curl -fsS https://${DILLA_DOMAIN}/api/v1/health` returns 200.
- [ ] `curl -fsS https://${DILLA_DOMAIN}/api/v1/config | jq` reports
      `tls_enabled: true` and `db_encrypted: true`. If either is
      false, you're missing a control — go back to the relevant
      checklist item before opening the firewall.
- [ ] `journalctl -u dilla-server | grep -E 'SECURITY|ERROR'` is empty
      (or only contains acknowledged warnings).

Once every box is ticked, you may open 443/tcp on the public
interface.
