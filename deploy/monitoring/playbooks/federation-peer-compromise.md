# Playbook — federation peer compromise

Triggered by `correlation-rules.yaml` rule 5 `FederationPeerFlood`
(peer >1000 sync msg/min for >2 min).

Federation poisoning is a high-blast-radius event: a malicious peer can
forge messages, lock channels, or alter audit rows on every node that
syncs from it. Move fast.

## 1. Disable the peer (first thing — stops the bleeding)

```sh
# Until a CLI subcommand exists, edit the federation peer state in the DB:
sqlite3 /var/lib/dilla/dilla.db \
  "UPDATE federation_peers SET status='disabled' WHERE peer_id='<peer>';"

# Then bounce the federation worker (graceful):
systemctl reload dilla-server
```

(If `deploy/detection/README.md` already references
`dilla-server federation peer disable <node>` as an open item, prefer
the CLI when it lands.)

## 2. Snapshot state for forensics

Before anything else writes to `dilla.db`, take a hot-snapshot:

```sh
INCIDENT_DIR=/var/log/dilla-incidents/$(date +%Y%m%d-%H%M%S)-peer-<peer>
mkdir -p "$INCIDENT_DIR"
sqlite3 /var/lib/dilla/dilla.db ".backup $INCIDENT_DIR/dilla.db"
journalctl -u dilla-server --since "1 hour ago" \
  > "$INCIDENT_DIR/journal.log"
cp /var/log/dilla-audit.jsonl "$INCIDENT_DIR/audit.jsonl"
```

The snapshot is the **only** way to reconstruct what the peer told us
before we cut it off. Keep it for at least 90 days.

## 3. Identify the damage radius

Query for events from this peer in the last 24h:

```sql
SELECT created_at, action, target_type, target_id, details
FROM audit_events
WHERE json_extract(details, '$.origin_peer_id') = '<peer>'
ORDER BY created_at DESC
LIMIT 1000;
```

(Per `12-compliance-report.md` FED-AUDIT-1, the origin tag may not yet be
written on every event — see follow-up. Until then, cross-reference the
peer's `peer_id` against `messages.author_id` and `messages.created_at`
ranges that match the flood window.)

## 4. Replay from a known-good peer

If the peer is one of N≥3 nodes in the mesh, the other peers' state is
canonical:

1. Pick the peer with the smallest `last_lamport_clock` skew.
2. From that peer's node, export the affected channels' messages:

   ```sh
   sqlite3 /var/lib/dilla/dilla.db \
     "SELECT * FROM messages WHERE channel_id='<cid>' \
        AND created_at > '<flood_start>';" \
     > messages.export.csv
   ```
3. Apply on the recovering node after wiping the suspect rows.

For 2-node meshes, you cannot self-recover — escalate to the team owner
and accept the data loss window.

## 5. Rotate `DILLA_JOIN_SECRET`

The flood proves either the peer's credentials are compromised or the
join-secret was leaked. Rotate it:

```sh
# Generate
new_secret=$(openssl rand -base64 48)

# Update each node's env-file (per deploy/docker/.env.example):
sed -i "s|^DILLA_JOIN_SECRET=.*|DILLA_JOIN_SECRET=$new_secret|" /etc/dilla/dilla.env

# Restart each node in sequence (rolling — the mesh tolerates one down):
systemctl restart dilla-server
```

Re-enroll surviving peers using the new secret per
`deploy/federation/wireguard.example.conf`.

## 6. Audit-log

Insert a manual operator-action row:

```sql
INSERT INTO audit_events (id, team_id, actor_user_id, action,
  target_type, target_id, details, created_at)
VALUES (
  lower(hex(randomblob(16))),
  '_global',
  'operator',
  'federation.peer.disabled',
  'peer', '<peer>',
  json_object('reason', 'flood_alert', 'replayed_from', '<good_peer>'),
  datetime('now')
);
```

## 7. Post-mortem (within 48h)

- Timeline (alert → disable → snapshot → rotate → re-enable).
- Damage radius (rows touched, users impacted).
- Root cause (peer key leak? bug in peer's `state_sync` loop? targeted compromise?).
- Recommendation: either re-admit the peer with rotated credentials, or
  permanently revoke + announce to the federation.

## 8. References

- `.security-hardening/03-architecture-review.md §9` — federation isolation.
- `.security-hardening/09-infra-security.md §3` — WG mesh topology.
- `.security-hardening/12-compliance-report.md` FED-AUDIT-1 — origin-tag follow-up.
