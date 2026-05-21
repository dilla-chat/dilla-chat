# Playbook — bootstrap-token leak

Triggered by `correlation-rules.yaml` rule 8
`BootstrapTokenLateConsumption` (a `bootstrap.consumed` event fires
>15 min after server boot), or by an out-of-band report that the
`${DATA_DIR}/BOOTSTRAP_TOKEN` file is suspected exposed.

Per `04-critical-fixes.md` R-06, the bootstrap token is:
- File-mode `0600` in `${DATA_DIR}/BOOTSTRAP_TOKEN`.
- Single-use.
- 15-min expiring from process start.

A late-window consumption means **one** of:
- Server clock skew (most benign).
- The token was persisted somewhere (backup tarball, image snapshot, log
  scrape).
- The DB row holding the bootstrap state was tampered with to extend
  validity.

## 1. Confirm the alert

```logql
{job="dilla-audit", action="bootstrap.consumed"}
  | json | __error__ = ""
  | line_format "{{.created_at}}  team={{.team_id}}  by={{.actor_user_id}}  ip={{.details.ip}}"
```

There should be **exactly one** row, near the operator's first login.
Any extra row is the incident.

## 2. Revoke the consumed account immediately

The bootstrap path makes its consumer a team owner. Revoke that user:

```sh
# Find the bootstrap-promoted user
sqlite3 /var/lib/dilla/dilla.db <<'EOF'
SELECT actor_user_id, details, created_at
FROM audit_events
WHERE action = 'bootstrap.consumed'
ORDER BY created_at;
EOF

# Revoke all their devices (forces logout)
sqlite3 /var/lib/dilla/dilla.db \
  "UPDATE user_devices SET revoked_at = datetime('now')
    WHERE user_id = '<uid>';"

# Demote them
sqlite3 /var/lib/dilla/dilla.db \
  "DELETE FROM team_members
    WHERE user_id = '<uid>' AND team_id = '<team>';"
```

## 3. Confirm clock sanity

Rule out the benign cause:

```sh
timedatectl status
# Look for "System clock synchronized: yes" and a sane offset.
chronyc tracking   # or: ntpq -p
```

If the clock is off by >15 min, NTP is broken; fix that first and the
rule will re-arm correctly.

## 4. Rotate the SQLCipher passphrase

If the bootstrap token leaked via a backup or image snapshot, the
attacker likely has the DB passphrase too (same hosts, same backup
tarball). Rotate:

```sh
# 1. Stop the server
systemctl stop dilla-server

# 2. Rekey the DB (operator must already know the current passphrase)
sqlite3 /var/lib/dilla/dilla.db <<EOF
PRAGMA key = '<OLD_PASSPHRASE>';
PRAGMA rekey = '<NEW_PASSPHRASE>';
EOF

# 3. Update the env-file
echo "DILLA_DB_PASSPHRASE=<NEW_PASSPHRASE>" > /etc/dilla/db.env
chmod 0640 /etc/dilla/db.env
chown root:dilla /etc/dilla/db.env

# 4. Restart
systemctl start dilla-server
```

## 5. Audit the leak path

Where could the token have leaked?

| Path | Check |
|---|---|
| Backup tarball | `find /var/backups -name '*dilla*' -o -name '*BOOTSTRAP*' | xargs grep -l .` |
| Container image | `docker history <image>` — was `BOOTSTRAP_TOKEN` baked in? |
| journald | `journalctl -u dilla-server | grep -i bootstrap` |
| Shell history | `grep -r BOOTSTRAP /root/.bash_history /home/*/.bash_history` |
| Cloud-init logs | `grep -ri bootstrap /var/log/cloud-init*.log` |

The token file is created `0600` by the binary; any of the above
**reading** it implies a misconfiguration or a deliberate exfiltration.

## 6. Regenerate the bootstrap token (only if you need a new admin)

```sh
# Delete the consumed-bootstrap state and restart — the binary regenerates
# the token file on boot.
sqlite3 /var/lib/dilla/dilla.db \
  "DELETE FROM kv WHERE key = 'bootstrap_consumed';"
rm /var/lib/dilla/BOOTSTRAP_TOKEN
systemctl restart dilla-server

# The new token is in /var/lib/dilla/BOOTSTRAP_TOKEN — read it once,
# consume immediately, then move on.
```

## 7. Document

Insert a manual audit row:

```sql
INSERT INTO audit_events (id, team_id, actor_user_id, action,
  target_type, target_id, details, created_at)
VALUES (
  lower(hex(randomblob(16))),
  '_global', 'operator', 'incident.bootstrap_token_leak',
  'config', 'BOOTSTRAP_TOKEN',
  json_object('leak_path', '<discovered_path>', 'rotated_passphrase', true),
  datetime('now')
);
```

## 8. Post-mortem

This is the only Dilla incident where the **operator** (not a user, not
a peer) is the most likely root cause. Treat the post-mortem
non-judgmentally; the goal is to fix the operational gap.

Typical fixes:
- Stop backing up `${DATA_DIR}/BOOTSTRAP_TOKEN` (exclude in your backup
  script).
- Don't bake the data dir into a container image.
- Audit who has SSH to the host — bootstrap leaks reduce to "anyone who
  could `cat` that file".

## 9. References

- `.security-hardening/04-critical-fixes.md` R-06 — bootstrap token design.
- `.security-hardening/10-secrets-management.md` — secret storage patterns.
- `.security-hardening/09-infra-security.md §I3` — systemd hardening (file ACLs).
