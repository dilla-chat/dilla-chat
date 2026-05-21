# Playbook — DB growth anomaly

Triggered by `correlation-rules.yaml` rule 7 `DBGrowthAnomaly`
(`dilla.db` grew >1 GiB in 1h).

Three plausible root causes, in decreasing order of likelihood:
1. Attachment upload abuse / quota bypass.
2. Federation flood (related: rule 5).
3. Audit-log fanout (rare — only on misbehaving team-settings UI).

## 1. Confirm the spike is real (not a backup mid-flight)

```sh
# Current size
stat -c '%s' /var/lib/dilla/dilla.db | numfmt --to=iec

# Trend
journalctl -u dilla-server --since "2 hours ago" | grep 'db.size_bytes'
```

If the OTel metric `dilla_db_size_bytes` is in Prometheus:

```promql
dilla_db_size_bytes - dilla_db_size_bytes offset 2h
```

A 1 GiB jump in 1h is well above any benign workload for a sub-1000-user
team.

## 2. Identify the heavy table

```sh
sqlite3 /var/lib/dilla/dilla.db <<'EOF'
SELECT name, SUM("pgsize") / 1024 / 1024 AS mb
FROM dbstat
GROUP BY name
ORDER BY mb DESC
LIMIT 10;
EOF
```

The top row tells you the root cause:
- `attachments` or `uploads` → §3 (upload abuse)
- `messages` or `federation_*` → §4 (federation flood)
- `audit_events` → §5 (audit fanout)

## 3. Upload abuse / quota bypass

Find the heavy team:

```sql
SELECT team_id, SUM(size_bytes) / 1024 / 1024 AS mb, COUNT(*) AS n
FROM uploads
WHERE created_at > datetime('now', '-2 hours')
GROUP BY team_id
ORDER BY mb DESC
LIMIT 10;
```

Lower their per-team quota below the global default:

```sh
# DILLA_UPLOAD_QUOTA_PER_TEAM_GB is the global ceiling (H12).
# For per-team override, set in the teams.settings JSON:
sqlite3 /var/lib/dilla/dilla.db \
  "UPDATE teams SET settings = json_set(settings,
    '$.upload_quota_gb', 5) WHERE id='<team>';"
```

If a single user is the culprit, suspend them via the team admin UI and
file an abuse report.

## 4. Federation flood

Cross-check rule 5 (`FederationPeerFlood`) — if it fired in the same
window, this is a federation issue, not a DB issue. Follow
`federation-peer-compromise.md`.

If rule 5 did **not** fire but federation tables are heavy:

```sql
SELECT origin_peer_id, COUNT(*) AS n
FROM federation_events
WHERE created_at > datetime('now', '-2 hours')
GROUP BY origin_peer_id
ORDER BY n DESC;
```

The top peer is replicating too aggressively — tighten the per-peer
rate limit in `federation_peers.settings`.

## 5. Audit-log fanout

If `audit_events` is the heavy table, someone is doing a script that
re-applies the same team setting in a loop, or a rogue admin is
deliberately filling the table to push older incident rows past your
retention window.

```sql
SELECT actor_user_id, action, COUNT(*) AS n
FROM audit_events
WHERE created_at > datetime('now', '-2 hours')
GROUP BY actor_user_id, action
ORDER BY n DESC LIMIT 10;
```

Suspend the actor; consider lowering `audit_events` retention; file an
internal review.

## 6. Disk-quota response

If the host disk is also nearing capacity:

```sh
# Identify rate
df -h /var/lib/dilla

# Emergency: enable load-shed mode (see deploy/ddos/README.md)
systemctl set-environment DILLA_OVERLOAD_BANNER="Storage maintenance — degraded mode" \
  DILLA_RATELIMIT_PER_SECOND=1 \
  DILLA_RATELIMIT_BURST=5
systemctl reload dilla-server
```

(`DILLA_OVERLOAD_BANNER` is open item O-1 from `09-infra-security.md` — if it
hasn't shipped yet, drop a static banner in the reverse-proxy template
instead.)

Then:
- Run the periodic GC: attachments GC, message TTL if configured.
- If desperate: temporarily mount additional volume at
  `/var/lib/dilla/uploads-overflow` and update `DILLA_UPLOADS_DIR`.

## 7. Post-incident

- Confirm `dilla_db_size_bytes` slope returns to baseline within 6h.
- File a follow-up if the offending team/peer needs a permanent quota.
- If §5 was the cause, escalate to a co-operator review — audit log
  poisoning is a bad-faith insider action and the team owner needs to
  know.

## 8. References

- `.security-hardening/05-backend-hardening.md H12` — per-team upload quota.
- `.security-hardening/09-infra-security.md §I10` — load-shed ladder.
