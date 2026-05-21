# Dilla — runtime detection guide

Not a full IDS deployment — Dilla is a small self-hosted product and a full
ELK / Splunk install is overkill. This guide tells you what to alert on and
how to query the data you already have.

## Data sources you have

1. **`audit_events` table** in the SQLCipher DB. Action vocabulary in
   `.security-hardening/08-auth-enhancement.md §7`. Every state mutation
   touched by the auth-enhancement work writes a row here.
2. **`journalctl -u dilla-server`** (if running under systemd, per
   `deploy/systemd/dilla-server.service`). Free-text log lines, RFC3164
   timestamps.
3. **Reverse proxy access logs** (Caddy/nginx/Traefik). Method, path, status,
   source IP, user-agent.
4. **OpenTelemetry traces / metrics** if `DILLA_OTEL_ENABLED=true`. The
   recommended sink for self-hosters is Grafana + Prometheus + Loki + Tempo
   (all open-source).

## What to alert on

### 1. Failed-auth bursts

**Signal:** `audit_events.action = 'auth.login_failed'` clustered on a
single IP or username within 5 min.

**Threshold:** ≥ 10 events / 5 min from one IP.

**SQL:**
```sql
SELECT json_extract(details, '$.ip') AS ip, COUNT(*)
FROM audit_events
WHERE action = 'auth.login_failed'
  AND created_at > datetime('now', '-5 minutes')
GROUP BY ip HAVING COUNT(*) >= 10
ORDER BY COUNT(*) DESC;
```

**LogQL (Loki, journald source):**
```logql
sum by (remote_addr) (
  count_over_time({unit="dilla-server.service"}
    |= "auth.login_failed" [5m])
) > 10
```

**Response:** ban the IP at the firewall (`ufw insert 1 deny from <ip>`) or
add it to the Cloudflare WAF "block" list. The rate limit in
`deploy/waf/cloudflare-waf.json` rule #2 normally handles this preemptively.

### 2. Unusual federation peer volume

**Signal:** a single peer sends >> events than its baseline. Cross-team
poisoning or a runaway sync loop.

**Threshold:** > 3σ above the peer's 1-hour rolling baseline.

**SQL (rough):**
```sql
SELECT actor_id AS peer, COUNT(*) AS events
FROM audit_events
WHERE actor_type = 'federation_peer'
  AND created_at > datetime('now', '-1 hour')
GROUP BY peer
ORDER BY events DESC LIMIT 10;
```

**Response:** disable the peer (`dilla-server federation peer disable <node>`)
pending investigation. The peer-pinning work (R-02) makes mutual revocation
cheap.

### 3. Sudden DB size jump

**Signal:** `dilla.db` grows by > 100 MiB in 1 hour. Almost always means
either an upload-quota bug or message-fanout amplification.

**Detection (cron, every 15 min):**
```sh
STAT=$(stat -c '%s' /var/lib/dilla/dilla.db)
echo "$(date +%s) $STAT" >> /var/lib/dilla/db-size.log
# Trigger alert if delta > 100 MiB / hour.
```

**Response:** check `audit_events` for the offending team-id, enforce a
per-team quota lower than the global one in `DILLA_UPLOAD_QUOTA_PER_TEAM_GB`.

### 4. One-time-prekey drain (`OTPK`) bursts

**Signal:** a single requester pulls > 50 prekeys in 5 min from distinct
users. Combined with R-07's per-IP rate limit, this is the smoking gun for
a user-deanonymization attempt.

**SQL:**
```sql
SELECT actor_id, COUNT(DISTINCT json_extract(details,'$.target_user_id')) AS users
FROM audit_events
WHERE action = 'prekey.consume'
  AND created_at > datetime('now','-5 minutes')
GROUP BY actor_id HAVING users >= 50;
```

**LogQL:** filter on `prekey.consume` action lines.

**Response:** suspend the requesting user, escalate to the team owners.

### 5. Repeated rate-limit hits per IP

**Signal:** the proxy serves 429s to the same IP across multiple endpoints,
indicating a distributed scrape.

**LogQL (Caddy access logs in JSON):**
```logql
sum by (remote_ip) (
  count_over_time({job="caddy"} | json | status="429" [15m])
) > 50
```

**Response:** add the IP to the Cloudflare WAF block list (preferable —
filters at the edge).

### 6. Bootstrap token misuse

**Signal:** `audit_events.action = 'bootstrap.consumed'` from an IP outside
your operator network. Per R-06 the token is single-use and 15-min expiring,
but if it gets consumed by an unexpected IP, someone with log access
escalated.

**Query:** simple `SELECT * FROM audit_events WHERE action = 'bootstrap.consumed';`
after every install.

**Response:** revoke the bootstrap user, rotate the SQLCipher passphrase, and
audit the journal for the leak path.

## Where to ship logs

### Recommended OSS stack

| Component | Role |
|---|---|
| **Promtail** | tails journald + `audit_events` → ships to Loki |
| **Loki** | log store, LogQL queries |
| **Prometheus** | metrics scrape (dilla-server exposes `/metrics` when OTel is on) |
| **Tempo** | trace store (if you enable OTel traces) |
| **Grafana** | unified dashboards + Alertmanager rules |

Skip the enterprise SIEMs (Splunk, Datadog, Sumo). They cost more than the
VPS and a single-operator install doesn't get value from them.

### audit_events shipper (recipe)

Use a sidecar that polls the table and ships to Loki:

```sh
# /etc/cron.d/dilla-audit-shipper — runs every 30s.
* * * * * dilla /usr/local/bin/dilla-audit-shipper >> /var/log/dilla-audit-shipper.log 2>&1
```

A 50-line shell script is enough: `sqlite3 dilla.db "SELECT ... WHERE id > $CURSOR ORDER BY id LIMIT 1000"` → write to a JSONL file under `/var/log/`
→ Promtail tails that. Persist `$CURSOR` in `/var/lib/dilla/audit-cursor`.

## Things NOT to alert on

- Single 401s on `/auth/verify`. Real users mistype.
- Single 429s. The rate limiter is doing its job.
- WS reconnects. The mobile clients reconnect aggressively on network change.
- `audit_events.action = 'auth.token_refresh'`. Routine.
- Anything below DEBUG level in `journalctl`.
