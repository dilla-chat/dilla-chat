# Dilla — Cloudflare TURN configuration hardening

Dilla relays voice/video media through Cloudflare's TURN service. This doc
covers the operational hygiene around the TURN integration — separate from
the SFU work itself.

## Configuration

Dilla picks up the TURN credentials via env vars (see `server-rs/src/config.rs`):

| Env var | Purpose |
|---|---|
| `DILLA_CF_TURN_KEY_ID`   | Cloudflare TURN key ID (public-ish) |
| `DILLA_CF_TURN_API_TOKEN`| Cloudflare API token, scoped to TURN only |
| `DILLA_TURN_MODE`        | `cloudflare` (default), `static`, or `none` |
| `DILLA_TURN_TTL`         | Credential TTL in seconds (default 86400) |
| `DILLA_TURN_SHARED_SECRET` | only for `static` mode (coturn fallback) |
| `DILLA_TURN_URLS`        | only for `static` mode |

### Credential lifecycle

1. Client requests `/api/v1/turn/credentials` (authenticated).
2. dilla-server calls Cloudflare's TURN API with the operator's API token.
3. Cloudflare returns a short-lived TURN username + password.
4. dilla-server forwards those to the client.
5. Client uses them to authenticate with the TURN edge for one call.

**Short-lived is the security property.** A leaked TURN credential expires
within `DILLA_TURN_TTL` (24h max — recommended: 1h for production).

## Operator hardening checklist

### 1. Token scope

The Cloudflare API token used by `DILLA_CF_TURN_API_TOKEN` MUST be scoped to
**Calls API → Edit** only. NOT a global API key. Create it via:

> Cloudflare dashboard → My Profile → API Tokens → Create Token →
> "Custom token" → permissions: `Account → Cloudflare Calls → Edit`,
> resources: `Include → Specific account → <your account>`.

If the token leaks, the blast radius is "an attacker can mint TURN
credentials" — annoying, not catastrophic. Rotate within 24h of discovery.

### 2. Secret storage

`DILLA_CF_TURN_API_TOKEN` is sensitive. Prefer one of:

- **systemd:** load via `LoadCredential` (same pattern as the DB passphrase
  in `deploy/systemd/dilla-server.service`).
- **Docker Compose:** use the `secrets:` section, mount at
  `/run/secrets/dilla-cf-turn-token`, set
  `DILLA_CF_TURN_API_TOKEN_FILE=/run/secrets/dilla-cf-turn-token`.
  (TODO: add `*_FILE` support to the config loader — currently only the DB
  passphrase has the `_FILE` fallback. Open follow-up.)
- **Kubernetes:** standard `Secret` object, mount as a projected volume.

NEVER bake the token into a container image.

### 3. Don't expose the TURN endpoint unauthenticated

The `/api/v1/turn/credentials` endpoint MUST require a valid JWT. Without
auth, an attacker can mint credentials forever and ride your TURN bandwidth
for free.

Verify in the running server:

```sh
curl -sS https://${DILLA_DOMAIN}/api/v1/turn/credentials | jq
# Expect: {"error":"unauthorized"} or HTTP 401.
```

If this returns credentials, that's a bug — file an issue, then rotate the
token.

### 4. Per-team abuse monitoring

Cloudflare's TURN dashboard shows bandwidth + session counts per API token.
Check it monthly. A single team consuming > 90% of your usage is either
running a large public call (legitimate) or being used to relay non-Dilla
traffic (abuse).

For per-team usage tracking, watch:

- `audit_events.action = 'voice.session_started'` (target_id = team_id).
- The `voice_sessions` DB table for active session counts.

### 5. Abuse response playbook

If a single user / team is exhausting bandwidth:

```sh
# 1. Identify the offending team:
sqlite3 /var/lib/dilla/dilla.db \
  "SELECT team_id, COUNT(*) FROM voice_sessions
   WHERE started_at > datetime('now','-1 hour')
   GROUP BY team_id ORDER BY 2 DESC LIMIT 5;"

# 2. Disable voice for that team (DB hot-update, no restart):
sqlite3 /var/lib/dilla/dilla.db \
  "UPDATE teams SET voice_disabled = 1 WHERE id = '<team_id>';"
# (NOTE: voice_disabled flag is a recommended future addition — see Open Items.)

# 3. As an emergency hammer: rotate the Cloudflare token. This invalidates
#    ALL in-flight TURN sessions globally. Avoid unless really under attack.
```

### 6. Cost ceiling

Set a Cloudflare billing alert at ~150% of expected monthly TURN spend.
Cloudflare's TURN pricing is per-GB; a misbehaving client can rack up cost
fast.

## What this doc does NOT cover

- Setting up your own **coturn** install. The `DILLA_TURN_MODE=static`
  branch supports it but it's outside the scope of this hardening guide.
  See coturn's own docs.
- ICE candidate filtering to hide internal IPs. That's an SFU-level concern
  tracked by R-31 / SFU-IP-1.
- DTLS-SRTP key management. End-to-end media encryption is implemented by
  the WebRTC stack itself; the TURN relay never sees plaintext.
