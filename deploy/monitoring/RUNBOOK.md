# Dilla — monitoring operator runbook

You installed Dilla and wired up `deploy/monitoring/*`. Now what?

This page is the single source of truth for **what to look at and when**.
Print it, pin it, glance at it daily.

---

## Daily (~5 min over coffee)

Open Grafana → **Dilla / auth-overview** dashboard.

1. **Login outcomes** panel — failures should be < 5% of total logins.
   A sustained 10%+ failure rate means either a brute-force attempt in
   progress (check `correlation-rules.yaml` rule 1/2 status in
   Alertmanager) or a client bug post a release.
2. **Token refresh / min** — should track the active-user count. A
   spike past ~3× baseline is the leading indicator of a stolen refresh
   token (see `playbooks/stolen-jwt.md`).
3. **Device risk-event score timeline** — every dot above the
   y = 50 line deserves an eyeball; every dot ≥ 80 should already have
   paged you. If you see one without a page, your Alertmanager
   integration is broken.
4. **Alertmanager** silence list — anything you silenced yesterday that
   isn't fixed?

---

## Weekly (~30 min, Monday)

Open Grafana → **Dilla / federation-health** dashboard.

1. **Per-peer message volume** — chart of last 7 days. Each peer should
   have a stable envelope; expanding bands are an early warning before
   rule 5 (`FederationPeerFlood`) actually fires.
2. **Per-peer auth failures** — every peer should be at zero. Anything
   non-zero implies a misconfigured peer or a credential-rotation event.
3. **Cross-check with `behavioral.md` query 1** ("users with >5 risk
   events in 7 days") — if anyone's listed, schedule a chat.
4. **OTPK consumption drift** (`behavioral.md` query 8). New conversation
   patterns show up here first; verify nothing crosses the rule-6
   threshold by Wednesday.
5. Skim the Alertmanager history for low-severity events. If the same
   `RateLimitClusterPerIP` source has fired 5 days running, ban it.

---

## Monthly (~1-2 h, first Monday of the month)

1. **Rotate `DILLA_JWT_SECRET`** if the operator-team membership has
   changed in the past month (someone left → rotate). Re-issued JWTs
   are valid; old ones get a force-logout on next request.
2. **Multi-org operators: rotate `DILLA_JOIN_SECRET`** if a peer left
   the federation. Re-enroll surviving peers using
   `deploy/federation/wireguard.example.conf`.
3. **Per-user device list audit** — for each high-privilege user
   (PERM_MANAGE_FEDERATION, PERM_VIEW_AUDIT_LOG holders), open the
   Account → Devices panel and confirm every device is current and
   recognized. Revoke stale ones.
4. **Storage trend review** — Grafana stat panel: `dilla_db_size_bytes`
   over 30 days. Sanity-check against `DILLA_UPLOAD_QUOTA_PER_TEAM_GB`
   per-team usage.
5. **Backup restore drill (cheap version)** — restore last week's
   `dilla.db` snapshot into a scratch directory, start a `dilla-server`
   bound to a non-prod port, verify it boots and you can log in. ~10
   minutes of effort, catches the silent-corruption case before disaster.
6. **Alertmanager: silence-list review** — anything silenced > 30 days
   should be either fixed (delete silence) or accepted (move to inhibit
   rule).

---

## Quarterly

1. **Dependency audit** —
   ```sh
   cd server-rs && cargo audit
   cd client && npm audit --omit=dev
   ```
   File a ticket per finding rated ≥ "medium".
2. **Log rotation review** — `/var/log/dilla-audit.jsonl` should not be
   the same file forever. Confirm logrotate is rotating + the rotated
   files still ship to Loki (the `__path__` glob should include
   `*.jsonl*`).
3. **Backup restore drill (full version)** — restore to a fresh VM, run
   the binary, federate it with a co-test node, confirm message replay
   works.
4. **Threat-model refresh** — open
   `.security-hardening/02-threat-model.md`, walk through the assumptions,
   ask "is anything materially different from 90 days ago?" If yes,
   re-run the relevant pentest scenarios.
5. **OS package upgrades** — `apt full-upgrade` or equivalent; reboot;
   confirm services come back. Pick a 1h window where you can rollback.

---

## What to do when an alert fires

1. **Page**? Drop into the relevant `deploy/monitoring/playbooks/*.md`
   in this directory. Each playbook is self-contained.
2. **Slack/email**? Confirm it's not a known false positive. If new,
   open the runbook URL from the alert annotation.
3. **Low-severity (log only)**? It's in your Alertmanager UI history.
   Review during the weekly pass.

---

## Sanity-checking the stack itself

If you suspect Loki/Prometheus/Tempo aren't seeing data:

```sh
# Loki has recent dilla-audit lines?
curl -s 'http://loki:3100/loki/api/v1/labels' | jq

# Prometheus has dilla metrics?
curl -s 'http://prometheus:9090/api/v1/query?query=up{job="dilla-server"}' | jq

# Tempo has recent traces?
curl -s 'http://tempo:3200/api/search?tags=service.name%3Ddilla-server&limit=10' | jq
```

If any of the three is empty, the pipeline broke at that leg —
`ARCHITECTURE.md` §2 has the topology to walk from source to sink.

---

## Index

- `ARCHITECTURE.md` — how signals get from `dilla-server` into the SIEM.
- `correlation-rules.yaml` — the 10 alert rules.
- `behavioral.md` — threat-hunting query catalog.
- `playbooks/*.md` — one per incident type.
- `grafana-dashboards/*.json` — three reference dashboards.
- `alertmanager.yml` — routing config.
- `../detection/README.md` — the original detection guide (audit-event taxonomy + SQL/LogQL primer).
