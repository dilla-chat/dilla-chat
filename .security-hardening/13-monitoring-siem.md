# 13 — Security monitoring & SIEM playbook

Step-13 output. Companion to:
- `09-infra-security.md §I8` — what to alert on (the seed list).
- `08-auth-enhancement.md §7` — audit-event taxonomy this step keys off.
- `12-compliance-report.md` ASVS V7.x — logging requirements this step satisfies.

Scope: turn the `deploy/detection/README.md` seed list into an **operator-ready
SIEM rollout** — architecture, correlation rules, threat-hunting recipes,
incident-response playbooks, Grafana dashboards, Alertmanager routing, and a
one-page runbook. OSS stack only; managed escalations marked as drop-ins.

---

## 1. Summary

A new `deploy/monitoring/` tree ships everything an operator needs to go from
"binary running" to "I'd notice a brute-force attack within 5 min" in about
30 minutes of setup. Built on the OSS Grafana stack (Promtail / Loki /
Prometheus / Tempo / Grafana / Alertmanager).

### File index

| Path | Purpose |
|---|---|
| `deploy/monitoring/ARCHITECTURE.md` | Pipeline diagram, signal sources, Promtail + OTel collector reference configs, shared-label scheme, audit-events shipper recipe (with systemd-timer). |
| `deploy/monitoring/correlation-rules.yaml` | 10 alert rules in Loki-ruler / Prometheus syntax (interchangeable). Each carries `severity`, `category`, `runbook_url`. |
| `deploy/monitoring/behavioral.md` | 12 threat-hunting LogQL/PromQL queries for ad-hoc analysis (not alert rules). |
| `deploy/monitoring/playbooks/auth-brute-force.md` | IR response to rules 1, 2, 9. |
| `deploy/monitoring/playbooks/federation-peer-compromise.md` | IR response to rule 5. |
| `deploy/monitoring/playbooks/stolen-jwt.md` | IR response to rules 3, 4, 6 and user reports. |
| `deploy/monitoring/playbooks/db-growth-spike.md` | IR response to rule 7. |
| `deploy/monitoring/playbooks/bootstrap-token-leak.md` | IR response to rule 8. |
| `deploy/monitoring/grafana-dashboards/auth-overview.json` | Login/refresh/enroll/risk-score panels. |
| `deploy/monitoring/grafana-dashboards/federation-health.json` | Per-peer volume/auth/RTT panels. |
| `deploy/monitoring/grafana-dashboards/voice-quality.json` | SFU latency, PLI, ICE-fail panels. |
| `deploy/monitoring/alertmanager.yml` | Routing tree, severity tiers, inhibit rules, group-by team_id. |
| `deploy/monitoring/RUNBOOK.md` | Daily/weekly/monthly/quarterly operator checklist. |

Total new files: 13. Zero Rust/TypeScript source changes. Docs and configs only.

---

## 2. SIEM stack recommendation

### Default: the OSS Grafana stack

| Role | Component | Why |
|---|---|---|
| Log shipping | **Promtail** | journald native, simple config, well-maintained. |
| Log store | **Loki** | LogQL, label-based indexing, S3-backed retention, supports a ruler for alert rules — single binary in monolithic mode. |
| Metrics scrape | **Prometheus** | OTel collector pushes via `prometheusremotewrite`; Prometheus also fires alert rules. |
| Traces | **Tempo** | OTLP-native sink for the existing exporter. |
| Trace + log + metric stitch | **OTel Collector** | Decouples Dilla from any single backend; lets you swap Tempo/Honeycomb/Jaeger without restarting Dilla. |
| Visualization | **Grafana** | Single pane for Loki + Prometheus + Tempo. Dashboards in this step target Grafana 10.x. |
| Routing | **Alertmanager** | Standard receiver for both the Prometheus and Loki rulers. |

For a single-VPS operator everything except Prometheus fits in `docker
compose up` against a 6 GB host. Three nodes (logs/metrics/trace), one
collector, one Grafana, one Alertmanager.

### Escalation paths (drop-in swaps)

Each leg of the topology can be replaced independently:

| Default | Managed swap | Effort |
|---|---|---|
| Promtail → Loki | Splunk HEC (via Universal Forwarder) | Replace Promtail; JSON shape is compatible. |
| Promtail → Loki | Datadog Logs intake | Use Vector with `datadog_logs` sink. |
| Promtail → Loki | CloudWatch Logs Insights | Use Vector with `cloudwatch_logs` sink. |
| Prometheus | Datadog / Grafana Cloud Metrics / New Relic | OTel collector exporter swap. |
| Tempo | Honeycomb / Jaeger / Lightstep | OTel collector exporter swap. |
| Alertmanager | PagerDuty / Opsgenie / matrix-bot | Receiver swap in `alertmanager.yml`. |

> Explicit anti-recommendation: Splunk Enterprise and Datadog as
> defaults. Their seat-cost is multiples of a typical single-VPS install
> and they don't get value from Dilla's tenant scale. Recommended only
> for operators who already pay for them as part of a larger estate.

---

## 3. Final correlation-rule list

10 rules, all in `deploy/monitoring/correlation-rules.yaml`. Severity column
maps to the Alertmanager routing tree (`alertmanager.yml`).

| # | Rule | Severity | Trigger |
|---|---|---|---|
| 1 | `AuthBruteForceFromIP` | high | `auth.login_failed` >10/5m from one IP |
| 2 | `AuthCredentialStuffing` | critical | `auth.login_failed` from >30 distinct IPs/5m |
| 3 | `DeviceEnrollmentBurst` | medium | `device.enrolled` >3/user/hour |
| 4 | `DeviceRiskScoreCritical` | critical | `device.risk_event` with score ≥80 |
| 5 | `FederationPeerFlood` | critical | peer >1000 `state_sync_received`/min for >2m |
| 6 | `OneTimePrekeyDrain` | critical | `prekey.consume` >100/user-target/hour |
| 7 | `DBGrowthAnomaly` | high | `dilla_db_size_bytes` Δ >1 GiB / 1h |
| 8 | `BootstrapTokenLateConsumption` | critical | `bootstrap.consumed` >15m after server boot |
| 9 | `RateLimitClusterPerIP` | low | >100×429/min from one IP at the reverse proxy |
| 10 | `WSSubscriptionCapExceededRepeatedly` | low | WS sub-cap log >5/user/hour |

Every rule has a `runbook_url` annotation pointing at the matching
`deploy/monitoring/playbooks/*.md`. Inhibit rules suppress derivative
alerts (e.g. flood → DB-growth on same team).

---

## 4. Behavioral-query catalog

12 ad-hoc threat-hunting recipes in `deploy/monitoring/behavioral.md`.
Not alert-firing — designed for an analyst at a Grafana console.

1. Users with >5 `device.risk_event`s in 7 days.
2. Per-device `auth.token_refresh` rate outliers (stolen refresh).
3. Top 20 IPs by 401 rate in last hour.
4. Federation peer message-volume heatmap by hour-of-day.
5. Channel-join denied bursts per user (recon).
6. Attachment-download outliers per team (exfil).
7. Active distinct devices per user (lost-device hunt).
8. OTPK consumption sources with >10 distinct targets/h.
9. Bootstrap-consumption post-install audit.
10. Voice-room duration p99 outliers per team.
11. JWT revocation rate trend.
12. New-device-per-hour by team.

Each lists a LogQL query plus a PromQL fallback where the relevant metric
exists; queries reference fields the audit-event taxonomy already emits.

---

## 5. Incident-response playbook index

Five playbooks under `deploy/monitoring/playbooks/`, indexed by which
correlation rule (or out-of-band trigger) fires them:

| Trigger | Playbook |
|---|---|
| Rules 1, 2, 9 | `auth-brute-force.md` |
| Rule 5 | `federation-peer-compromise.md` |
| Rules 3, 4, 6 + user report | `stolen-jwt.md` |
| Rule 7 | `db-growth-spike.md` |
| Rule 8 + suspected file leak | `bootstrap-token-leak.md` |

Each playbook has the same structure: triage query, immediate stop-the-
bleeding action, forensic preservation, recovery steps, audit-trail
insertion, post-mortem checklist, cross-references back to earlier
hardening steps (especially `08-auth-enhancement.md` for auth flows and
`09-infra-security.md` for firewall/peer controls).

---

## 6. Code follow-ups required

The monitoring story is complete with the binary as it stands today, but
three changes would sharpen it materially. **Documented only — not
implemented in this step.** The user will decide which to ship.

### FU-1 — Prometheus `/metrics` scrape endpoint

**Why.** Today the binary pushes metrics via OTLP only
(`server-rs/src/observability/mod.rs:214-231`). Operators who already run
Prometheus prefer the pull model. Several rules + dashboards reference
metric names (`dilla_db_size_bytes`, `dilla_fed_*`, `dilla_voice_*`)
that exist in the SDK but aren't exposed for scrape.

**What to add.** A `/metrics` axum route serving the OTel SDK's
metric snapshot in Prometheus text format. Crate
`opentelemetry-prometheus` provides the bridge in ~30 LoC.

**Without it.** Operators run the OTel collector as a middleman (this
step's `ARCHITECTURE.md §6` documents this). Slightly more moving parts,
but works.

### FU-2 — `POST /api/v1/auth/logout-all`

**Why.** `playbooks/stolen-jwt.md §3` (nuclear option) currently loops
over `POST /api/v1/devices/{did}/revoke` per device. That works but is
non-atomic — between calls the attacker can re-enroll. A single endpoint
that revokes every device in one transaction is the safe answer.

**What to add.** New handler in `server-rs/src/api/auth_handlers.rs`:
revokes every `user_devices` row for the caller, bumps
`tokens_invalidated_after` in the same transaction, audit-logs
`auth.logout_all`. ~40 LoC + route wiring.

**Without it.** The playbook loop works in the common case; the race
window is small in practice because the attacker would have to be
actively re-enrolling at the same second.

### FU-3 — `details.origin_peer_id` on federation-sourced audit rows

**Why.** Multiple playbooks (`federation-peer-compromise.md §3`) and
behavioral query 4 want to filter `audit_events` by the peer that
originated the event. Per `12-compliance-report.md` FED-AUDIT-1, this
is already on the deferred list (depends on VULN-002 Phase 3 — per-node
Ed25519 signing).

**What to add.** When the federation worker applies a remote event,
include `origin_peer_id` in the `details` JSON of any audit row it
writes.

**Without it.** The playbook falls back to time-window + author cross-
reference, which is messier but workable.

### Nice-to-haves (lower priority)

- Add a `dilla_server_start_time_seconds` gauge (used by rule 8 to
  distinguish the legitimate first-boot bootstrap consumption from a
  later one). ~5 LoC in `observability/mod.rs`.
- Promote `team_id`, `user_id`, `device_id`, `peer_id` to top-level
  `tracing` fields (today some are emitted as event fields, some as
  span attributes — inconsistent). Makes Promtail relabeling simpler.

None of FU-1..FU-3 block following step 13. They sharpen what's
documented.

---

## 7. Operator quickstart — 30 minutes from install to monitored

Assumes a single-VPS install per `09-infra-security.md` decision matrix
(b) — Caddy out front, Compose-managed Dilla, native Loki/Prometheus
stack on the same host. Times are wall-clock for a familiar operator.

### t+0 → t+5 min — pre-flight

```sh
# 1. Confirm Dilla is logging JSON
journalctl -u dilla-server -o json --since "5 min ago" | head -1 | jq

# 2. Confirm OTel is enabled (the SDK push exporter)
grep DILLA_OTEL /etc/dilla/dilla.env
# Expect: DILLA_OTEL_ENABLED=true ; DILLA_OTEL_HTTP_ENDPOINT=http://localhost:4318
```

### t+5 → t+15 min — bring up the stack

Use any of the published `docker compose` templates for Grafana + Loki
+ Prometheus + Tempo + OTel Collector + Alertmanager (grafana.com ships
a working starter). Drop the configs from this step into the right
places:

```sh
sudo mkdir -p /etc/{promtail,otel,prometheus,alertmanager,loki/rules}
sudo install -m 0644 deploy/monitoring/correlation-rules.yaml \
  /etc/loki/rules/dilla.yaml
sudo install -m 0644 deploy/monitoring/alertmanager.yml \
  /etc/alertmanager/alertmanager.yml

# Promtail + OTel collector configs are inline in
# deploy/monitoring/ARCHITECTURE.md §4 and §6; copy + edit endpoints.

docker compose -f stack.yml up -d
```

### t+15 → t+20 min — audit-events shipper

```sh
sudo install -m 0755 deploy/monitoring/dilla-audit-shipper.sh \
  /usr/local/bin/dilla-audit-shipper
# (script body is in deploy/monitoring/ARCHITECTURE.md §5)
sudo install -m 0644 dilla-audit-shipper.service \
  /etc/systemd/system/dilla-audit-shipper.service
sudo install -m 0644 dilla-audit-shipper.timer \
  /etc/systemd/system/dilla-audit-shipper.timer
sudo systemctl daemon-reload
sudo systemctl enable --now dilla-audit-shipper.timer
```

### t+20 → t+25 min — import dashboards

In Grafana UI → Dashboards → Import → drop each
`deploy/monitoring/grafana-dashboards/*.json` and point its datasource
variables (`ds_loki`, `ds_prom`) at the actual datasource UIDs in your
install.

### t+25 → t+30 min — verify end-to-end

```sh
# Fire a synthetic failed login from a scratch box
curl -X POST https://<dilla>/api/v1/auth/verify \
  -d '{"challenge_id":"deadbeef","public_key":"fake","signature":"fake"}'

# Within ~30 sec the dilla-audit-shipper picks up the row; within
# ~1 min Promtail ships it to Loki; within ~30 sec after that the
# Loki ruler evaluates rule 1.

# Trigger rule 1 deliberately by repeating the above 11 times:
for i in $(seq 1 12); do
  curl -X POST https://<dilla>/api/v1/auth/verify \
    -d '{"challenge_id":"x","public_key":"x","signature":"x"}'
done

# Check Alertmanager
curl -s http://localhost:9093/api/v2/alerts | jq '.[] | .labels.alertname'
# Expect: AuthBruteForceFromIP within ~2 min.
```

You're done. Open `RUNBOOK.md` and pin it.

---

## 8. Cross-references

| Step | What it gives | How step 13 uses it |
|---|---|---|
| Step 5 H1 | `tower_governor` rate limiter + `DILLA_RATELIMIT_*` env | Rule 9 (`RateLimitClusterPerIP`) keys off the 429 response the limiter emits. |
| Step 5 H2 | JWT `jti` + revocation list | Playbook `stolen-jwt.md` and behavioral query 11 both rely on this. |
| Step 5 H4 | WS subscription cap | Rule 10 keys off the cap-exceeded log line. |
| Step 5 H12 | Per-team upload quota | Playbook `db-growth-spike.md` references the env var as the response lever. |
| Step 8 §3 | Device risk-score heuristic | Rule 4 + behavioral query 1 + dashboard `auth-overview.json`. |
| Step 8 §7 | Audit-event taxonomy | Every alert rule and behavioral query keys off these action strings. |
| Step 9 §I8 | Original detection seed list | Step 13 promotes the six bullets to firing rules + playbooks. |
| Step 12 V7.x | ASVS logging coverage | Step 13 closes the "operator-responsible" gap by giving them a turnkey stack. |
| Step 12 FED-AUDIT-1 | Deferred origin-peer tag | Documented as FU-3 above. |

Operators who follow step 13 inherit a working SIEM with realistic
defaults and a clear escalation path. The defaults are tight enough
to catch the OWASP A07 + A09 scenarios documented in
`12-compliance-report.md`, and loose enough not to page on noise from
a 10-user home server.
