# Dilla — secret rotation playbook

Per-secret rotation cadence, procedure, and blast radius. Sister doc
to `README.md` (storage) and `CHECKLIST.md` (pre-deploy hygiene).

---

## Rotation matrix

| # | Secret | Cadence | Method | Blast radius if leaked | Service impact on rotate |
|---|---|---|---|---|---|
| 1 | `DILLA_DB_PASSPHRASE` | Annual + on compromise | `PRAGMA rekey` (offline) | Full DB readable; all metadata exposed; identity blobs decryptable (PII risk) | Brief downtime (single-node); fail-over window (federated) |
| 2 | `DILLA_JWT_SECRET` | Quarterly + on compromise | Replace secret, restart | All issued JWTs forgeable | All users logged out |
| 3 | `DILLA_JOIN_SECRET` | Quarterly + on compromise or operator change | Replace secret, restart | Federation peer impersonation, state injection (until VULN-002 redesign ships) | Outstanding join invites invalidated |
| 4 | `DILLA_CF_TURN_API_TOKEN` | 90 days (Cloudflare default) + on compromise | Cloudflare API: revoke + reissue | Attacker can mint TURN creds → relay quota burn | Active voice calls continue; new credentials use new token |
| 5 | `DILLA_TLS_CERT` / `DILLA_TLS_KEY` | ACME auto (90 days for Let's Encrypt) | `caddy reload` / `certbot renew` | MITM of HTTPS sessions | Reverse-proxy reload, no Dilla restart |
| 6 | Bootstrap token | Once (self-expires 15 min) | Re-bootstrap | First-user account takeover | One-shot — N/A after first use |
| 7 | Per-user Ed25519 identity private key | User-initiated (key rotation flow) | New X3DH bundle + re-publish | Identity compromise → impersonation only after key compromise; past messages forward-secret via ratchet | Per-user; ratchet re-init with all peers |
| 8 | Per-user Signal ratchet state | Per-message (built into Double Ratchet) | Automatic | Single-message-key compromise | None |
| 9 | OTel exporter token | Per provider (typically 90 days) | Vendor dashboard rotate | Attacker can poison or mute observability | OTel exporter reconnect |
| 10 | `DILLA_SENTRY_DSN` | Per provider | Sentry dashboard regenerate | Attacker can inject events → noise / cost | None (graceful) |
| 11 | Federation peer pubkeys (future) | On peer key compromise | Peer re-publishes; trust-on-first-use update | Single peer impersonation | Re-trust window |

---

## 1. DB passphrase (`DILLA_DB_PASSPHRASE`)

This is the master key for the SQLCipher DB. SQLCipher supports
in-place re-keying with `PRAGMA rekey`; you do not have to dump and
reimport.

### Single-node (downtime acceptable)

```sh
# 1. Stop the server.
sudo systemctl stop dilla-server

# 2. Verify you can open the DB with the current passphrase.
OLD_PASS="$(sudo cat /etc/dilla/secrets/db_passphrase)"
sudo -u dilla sqlite3 /var/lib/dilla/dilla.db <<SQL
  PRAGMA key = '${OLD_PASS}';
  SELECT count(*) FROM users;  -- must succeed
SQL

# 3. Re-key with a fresh passphrase.
NEW_PASS="$(openssl rand -base64 48)"
sudo -u dilla sqlite3 /var/lib/dilla/dilla.db <<SQL
  PRAGMA key = '${OLD_PASS}';
  PRAGMA rekey = '${NEW_PASS}';
SQL

# 4. Write the new passphrase to the secret store.
printf '%s' "$NEW_PASS" | sudo install -m 0400 /dev/stdin /etc/dilla/secrets/db_passphrase

# 5. Restart.
sudo systemctl start dilla-server
sudo journalctl -u dilla-server -n 50 --no-pager
# Confirm: "database opened with connection pool" with no decryption error.
```

> [!CAUTION]
> Keep `$OLD_PASS` around until you've confirmed the new value
> works end-to-end (login + history pagination + WS join). If
> something is wrong, you re-key back: `PRAGMA key=NEW; PRAGMA
> rekey=OLD`.

### Federated (zero-downtime)

When you run multiple federated peers, drain one node, re-key it,
and fail back. Per-peer DBs are independent — they hold the same
*content* but separately encrypted SQLCipher files.

```text
1. Pick peer A. Mark it draining (remove from reverse-proxy upstream pool).
2. Wait until all clients have reconnected to peer B / peer C.
3. Stop A. Re-key A's DB as above. Restart A.
4. Add A back to the upstream pool.
5. Repeat for B, then C.
```

The federation protocol carries no secrets that depend on the DB
passphrase; the JWT-signing key changes (see §2) only when you also
rotate `DILLA_JWT_SECRET`. If you've left `DILLA_JWT_SECRET` unset
(default — HKDF-derived from the DB passphrase), then re-keying the
DB *also* invalidates every JWT on that peer. To avoid the
mass-logout side effect, set `DILLA_JWT_SECRET_FILE` explicitly so
the JWT-signing key has its own rotation lifecycle.

---

## 2. JWT secret (`DILLA_JWT_SECRET`)

```sh
NEW_SECRET="$(openssl rand -base64 48)"
printf '%s' "$NEW_SECRET" | sudo install -m 0400 /dev/stdin /etc/dilla/secrets/jwt_secret
sudo systemctl restart dilla-server
```

Effect: every issued JWT (access + refresh) becomes invalid
immediately. All users see a 401 on the next API call and are
redirected to the auth flow. WS tickets are ephemeral so existing
sockets remain — but their next reconnect will fail until they
re-auth. There's no graceful "previous-secret accepted for grace
period" mode; rotation is hard cut.

For a graceful rollout, consider:

- Scheduling rotation during a low-traffic window.
- Announcing the disruption in-app via a banner (the operator can use
  the `DILLA_THEME_FILE` mechanism today; once `DILLA_OVERLOAD_BANNER`
  ships per §I10 O-1, use that instead).

---

## 3. Federation join secret (`DILLA_JOIN_SECRET`)

```sh
NEW_SECRET="$(openssl rand -base64 48)"
printf '%s' "$NEW_SECRET" | sudo install -m 0400 /dev/stdin /etc/dilla/secrets/join_secret
sudo systemctl restart dilla-server
```

Effect: outstanding **join JWTs** (the tokens emitted by `/api/v1/
federation/join` and consumed by a joining peer) become invalid. The
peer's federation state already persisted — established peers don't
need to re-join.

If you're rotating *because* a peer is suspected compromised, also:

1. Remove the peer from `DILLA_PEERS` on every other node.
2. Restart each node.
3. After re-issuing keys at the compromised peer, distribute a fresh
   join token via a side channel.

Until VULN-002's per-peer Ed25519 signing redesign ships, the
join_secret is the only authentication barrier between peers; treat
its compromise as equivalent to full mesh compromise.

---

## 4. Cloudflare TURN API token

The Cloudflare Calls token is operator-supplied and Cloudflare-side
expiry is your responsibility. The TURN README in
`deploy/turn/README.md` documents the scope (Calls API → Edit only)
and the monitoring story; rotation:

```sh
# 1. In the Cloudflare dashboard or via the API, create a NEW token
#    with the same scope (Calls → Edit, restricted to your account).

# 2. Write it to the secret store.
printf '%s' "$NEW_CF_TURN_API_TOKEN" \
  | sudo install -m 0400 /dev/stdin /etc/dilla/secrets/cf_turn_api_token

# 3. Restart Dilla. New TURN credentials are minted with the new token.
sudo systemctl restart dilla-server

# 4. Revoke the OLD token in the Cloudflare dashboard.
#    Verify by checking dashboard "Last used" stops advancing for
#    the old token (~10 minutes after restart).
```

Monitoring: alert when token age >75 days (Cloudflare default expiry
is 90; rotate at 75% lifetime). Cloudflare emits an email warning at
85% — too late to operate calmly without a window.

If the token is **leaked** (e.g. accidentally committed and pushed),
do *not* just rotate. Also:

1. Inspect Cloudflare Calls usage in the dashboard for the rogue
   period — look for `getUserMedia` quota burn from unknown app keys.
2. Revoke any app keys created via the leaked token.
3. File a Cloudflare abuse ticket if billing impact is non-trivial.

---

## 5. TLS cert + key (`DILLA_TLS_CERT` / `DILLA_TLS_KEY`)

If you use Caddy / nginx / Traefik in front of Dilla (recommended —
see `deploy/reverse-proxy/`), TLS lives there and rotates automatically
via ACME. **Dilla doesn't need the cert + key at all in that mode.**

If you're running Dilla as the public-facing TLS terminator (rare),
ACME-based rotation through `lego` or `certbot` writes new files at
the path Dilla already knows; reload Dilla to pick them up:

```sh
sudo systemctl reload dilla-server   # SIGHUP not yet implemented; restart for now.
```

Rotation cadence is determined by your ACME provider. Let's Encrypt
defaults to 90 days; renew at 60 days.

---

## 6. Bootstrap token

Generated on first run; lifetime 15 minutes; one-shot consume. If you
miss the window, you can re-emit it manually:

```sh
sudo systemctl stop dilla-server
sudo -u dilla sqlite3 /var/lib/dilla/dilla.db "DELETE FROM bootstrap_tokens"
sudo systemctl start dilla-server
# The new token is written to ${DATA_DIR}/BOOTSTRAP_TOKEN mode 0600.
sudo cat /var/lib/dilla/BOOTSTRAP_TOKEN
```

After consumption, delete the file:

```sh
sudo shred -u /var/lib/dilla/BOOTSTRAP_TOKEN
```

CHECKLIST §7 enforces this pre-internet-expose.

---

## 7. Per-user Ed25519 identity keys

Driven by the client. The user generates a new identity key, publishes
a new X3DH bundle via `POST /api/v1/prekeys`, marks the old bundle
revoked, and re-initiates Signal sessions with every contact. The
server has no role beyond accepting the new bundle.

Trigger conditions:

- Device compromise (the user opts in via Settings → Security → Rotate
  identity key).
- Multi-device add (each device has its own identity keypair).

---

## 8. Per-user Signal ratchet state

Rotated **per message** by the Double Ratchet. No operator action.

---

## 9. OTel exporter auth token

Provider-specific. For Grafana Cloud / Honeycomb / Lightstep:

1. Generate a new API key in the vendor dashboard.
2. Write to `/etc/dilla/secrets/otel_api_key` mode 0400.
3. Restart Dilla.
4. Revoke the old key in the vendor dashboard.

Cadence: match the vendor's recommendation (90 days is typical). The
OTel exporter doesn't expire keys server-side, so set a calendar
reminder.

---

## 10. Sentry DSN

The DSN embeds the project's ingest key. Rotate by:

1. Sentry dashboard → Project Settings → Client Keys (DSN) →
   "Generate New Key".
2. Update `DILLA_SENTRY_DSN_FILE` to the new DSN.
3. Restart Dilla.
4. Disable the old client key.

No service impact — telemetry is fire-and-forget.

---

## 11. Federation peer pubkeys (future)

After VULN-002 is fixed, each federation peer publishes an Ed25519
verifying key. Rotation procedure (proposed, pending the redesign):

1. Peer generates new keypair.
2. Peer announces new pubkey via signed `peer:key:rotate` event,
   signed by the old key (or out-of-band trust update for the
   first-time case).
3. Receiving peers update their pinned key after grace period
   (e.g. 24h overlap with both keys accepted).

---

## Rotation hygiene rules of thumb

1. **Random ≥ 32 bytes.** `openssl rand -base64 48` produces 64 chars
   of base64 ≈ 384 bits. Don't use passphrase-style values for any of
   secrets 1-4 — they're machine keys, not human secrets.
2. **One operator generates, the IaC distributes.** Don't email
   secrets. Don't paste them into Slack. Use the storage tier from
   `README.md`.
3. **Audit log every rotation.** The `audit_events` table records
   server-side state changes; add an out-of-band `ROTATION.log` for
   each manual rotation event (date, operator, reason).
4. **Test the restore path** every quarter — restore from backup,
   open with current passphrase, confirm `users` table reads cleanly.
   A passphrase you can't use is the same as no passphrase at all.
