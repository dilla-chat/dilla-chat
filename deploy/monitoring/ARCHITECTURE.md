# Dilla — security monitoring & SIEM ingestion architecture

Companion to `deploy/detection/README.md` (which lists *what* to alert on).
This file documents the **plumbing**: where signals come from, how they reach
the SIEM, and which labels stitch them together.

OSS stack is the default. Managed-service swaps are listed inline as
commented-out alternatives so an operator who already pays for one can slot
it in without rewriting the topology.

---

## 1. Signal sources

| # | Source | Format | Transport |
|---|---|---|---|
| S1 | `dilla-server` stdout/stderr | JSON lines (`tracing_subscriber::fmt().json()` — see `server-rs/src/observability/mod.rs:43`) | journald |
| S2 | `dilla-server` OTel traces | OTLP/HTTP | direct push (operator-provided endpoint) |
| S3 | `dilla-server` OTel metrics | OTLP/HTTP, periodic | direct push (operator-provided endpoint) |
| S4 | `audit_events` SQLite table | rows (id, team_id, actor_user_id, action, target_type, target_id, details, created_at) | exporter → JSONL file → Promtail |
| S5 | Reverse-proxy access log | JSON (Caddy default, or nginx `log_format json`) | journald (Caddy) / file (nginx) |
| S6 | Host kernel / firewall | journald (`kern.*`) | journald |

> Note on S3: today the binary pushes metrics **outbound** via OTLP/HTTP only
> (see `server-rs/src/observability/mod.rs:214-231`). A Prometheus pull-mode
> `/metrics` endpoint is a follow-up — see `.security-hardening/13-monitoring-siem.md §6`.
> Until it exists, configure the OTLP exporter to point at an OTel collector
> that fronts both Prometheus (remote-write) and Tempo (traces).

---

## 2. Pipeline diagram (OSS default)

```mermaid
flowchart LR
  subgraph DILLA["dilla-server (single binary)"]
    LOGS[stdout/stderr<br/>JSON lines]
    OTLP[OTel SDK<br/>traces + metrics]
    DB[(audit_events<br/>SQLite/SQLCipher)]
  end

  subgraph HOST["Host"]
    JD[journald]
    SHIPPER[dilla-audit-shipper<br/>systemd-timer / cron<br/>tail-by-id → JSONL]
    AUDLOG[/var/log/dilla-audit.jsonl]
    PT[Promtail<br/>scrape: journald + audit JSONL]
    OTC[OTel Collector<br/>OTLP receiver]
  end

  subgraph SIEM["SIEM stack"]
    LOKI[(Loki<br/>logs + LogQL)]
    PROM[(Prometheus<br/>remote-write target)]
    TEMPO[(Tempo<br/>trace store)]
    AM[Alertmanager]
    GRAF[Grafana<br/>dashboards + alerts]
  end

  LOGS --> JD
  DB --> SHIPPER --> AUDLOG
  JD --> PT
  AUDLOG --> PT
  OTLP --> OTC
  OTC -->|loki exporter| LOKI
  OTC -->|prometheusremotewrite| PROM
  OTC -->|otlp| TEMPO
  PT --> LOKI

  LOKI --> GRAF
  PROM --> GRAF
  TEMPO --> GRAF
  GRAF -->|alert rules| AM
  LOKI -->|ruler| AM
  PROM -->|alert rules| AM

  %% --- Escalation paths (optional, drop-in replacements) -----------------
  %% PT -.-> SPLUNK[Splunk HEC]
  %% PT -.-> DATADOG[Datadog Logs HTTP intake]
  %% PT -.-> CWL[CloudWatch Logs Insights]
  %% OTC -.-> NEWRELIC[New Relic OTLP]
  %% OTC -.-> HONEYCOMB[Honeycomb OTLP]
```

### Why an OTel Collector in front of Prometheus?

Three reasons:

1. Dilla pushes metrics today; Prometheus pulls. The collector terminates the
   OTLP push and exposes a `remote_write` target Prometheus can consume.
2. It lets you swap the trace backend (Tempo → Jaeger → Honeycomb) without
   touching `dilla-server` config.
3. It can attach environment-derived resource attributes (`deployment.env`,
   `node.region`) before fan-out.

### Why not just journald → Loki + skip the audit shipper?

The `audit_events` table is the source-of-truth for security-critical actions
(see `.security-hardening/08-auth-enhancement.md §7`). Logging the same events
to stdout would duplicate them, risk PII leakage through unstructured fields,
and lose the row id (which is what makes the shipper idempotent — see §5).

---

## 3. Shared labels (the join keys)

Every signal MUST carry these labels by the time it lands in Loki/Prom/Tempo.
This is what makes "show me every signal for `user_id=u_abc` in the last hour"
work as a single Grafana query.

| Label | Source | Notes |
|---|---|---|
| `service` | static (`dilla-server`) | distinguishes from co-tenant logs |
| `node` | env (`DILLA_NODE_NAME`) | federation identity |
| `env` | env (`DILLA_ENV` = `prod` \| `staging` \| `dev`) | filter prod vs. dev dashboards |
| `team_id` | log field / audit row | tenant scope; nullable on global events |
| `user_id` | log field / audit row (`actor_user_id`) | nullable on `auth.login_failed` |
| `device_id` | JWT `did` claim / audit row | per A1 multi-device |
| `action` | audit row (`action`) | filter by audit taxonomy |
| `peer_id` | federation log field | per-peer rate / volume |
| `severity` | alert rule label | routing key for Alertmanager |
| `category` | alert rule label | `auth` \| `federation` \| `data` \| `voice` |

**Promtail relabeling rule (excerpt)** — applied in the journald scrape
config; mirror the same for the audit-shipper file scrape:

```yaml
relabel_configs:
  - source_labels: [__journal__systemd_unit]
    regex: 'dilla-server\.service'
    target_label: service
    replacement: dilla-server
  - source_labels: [__journal__hostname]
    target_label: node
  - source_labels: [__journal__priority]
    target_label: severity
```

Inside `dilla-server` JSON log lines, `team_id` / `user_id` / `device_id` /
`action` already appear as fields on the relevant events (audit-event helper
emits them; see `server-rs/src/api/auth_handlers.rs`). Use Loki's `| json`
pipeline stage to promote them to labels at query time.

---

## 4. Promtail scrape config (reference)

`/etc/promtail/config.yml` (excerpt):

```yaml
clients:
  - url: http://loki:3100/loki/api/v1/push

scrape_configs:
  # ---- S1: dilla-server stdout via journald ------------------------------
  - job_name: dilla-server-journal
    journal:
      max_age: 24h
      labels:
        job: dilla-server
        service: dilla-server
    relabel_configs:
      - source_labels: [__journal__systemd_unit]
        regex: 'dilla-server\.service'
        action: keep
      - source_labels: [__journal__hostname]
        target_label: node
    pipeline_stages:
      - json:
          expressions:
            level: level
            action: fields.action
            team_id: fields.team_id
            user_id: fields.user_id
            device_id: fields.device_id
            peer_id: fields.peer_id
      - labels:
          level:
          action:

  # ---- S4: audit_events shipper output -----------------------------------
  - job_name: dilla-audit
    static_configs:
      - targets: [localhost]
        labels:
          job: dilla-audit
          service: dilla-server
          source: audit_events
          __path__: /var/log/dilla-audit.jsonl
    pipeline_stages:
      - json:
          expressions:
            action: action
            team_id: team_id
            user_id: actor_user_id
            target_type: target_type
            target_id: target_id
            ip: details.ip
            risk_score: details.risk_score
      - labels:
          action:
          team_id:
          target_type:

  # ---- S5: Caddy access log (already JSON by default) --------------------
  - job_name: caddy
    journal:
      labels:
        job: caddy
        service: caddy
    relabel_configs:
      - source_labels: [__journal__systemd_unit]
        regex: 'caddy\.service'
        action: keep
    pipeline_stages:
      - json:
          expressions:
            status: status
            remote_ip: request.remote_ip
            method: request.method
            uri: request.uri
      - labels:
          status:
          method:
```

---

## 5. `audit_events` shipper

The shipper tails the SQLite table by primary-key cursor and writes new rows
as JSONL. Promtail then scrapes that file (see §4).

### systemd timer (recommended over cron — survives reboot, has its own
journal lane)

`/etc/systemd/system/dilla-audit-shipper.service`:

```ini
[Unit]
Description=Dilla audit-events shipper
After=dilla-server.service
Wants=dilla-server.service

[Service]
Type=oneshot
User=dilla
Group=dilla
ExecStart=/usr/local/bin/dilla-audit-shipper
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/dilla /var/log
```

`/etc/systemd/system/dilla-audit-shipper.timer`:

```ini
[Unit]
Description=Run dilla-audit-shipper every 30s

[Timer]
OnBootSec=30s
OnUnitActiveSec=30s
AccuracySec=1s
Unit=dilla-audit-shipper.service

[Install]
WantedBy=timers.target
```

### Shipper script (`/usr/local/bin/dilla-audit-shipper`)

```sh
#!/bin/sh
set -eu
DB=/var/lib/dilla/dilla.db
CURSOR_FILE=/var/lib/dilla/audit-cursor
OUT=/var/log/dilla-audit.jsonl
CURSOR=$(cat "$CURSOR_FILE" 2>/dev/null || echo "")
QUERY="SELECT json_object(
  'id', id, 'team_id', team_id, 'actor_user_id', actor_user_id,
  'action', action, 'target_type', target_type, 'target_id', target_id,
  'details', json(details), 'created_at', created_at
) FROM audit_events
WHERE ${CURSOR:+id > '$CURSOR' AND} 1=1
ORDER BY id LIMIT 1000;"
ROWS=$(sqlite3 -readonly "$DB" "$QUERY")
[ -z "$ROWS" ] && exit 0
echo "$ROWS" >> "$OUT"
echo "$ROWS" | tail -n1 | sqlite3 -readonly "$DB" \
  "SELECT json_extract(?, '\$.id');" > "$CURSOR_FILE"
```

> SQLCipher note: if the DB is encrypted (the default), the shipper needs
> `DILLA_DB_PASSPHRASE` exported. Source it via `EnvironmentFile=` pointing at
> the same `/etc/dilla/db.env` the main service uses (mode 0640, owner
> root:dilla — see `deploy/systemd/HARDENING.md`). **Never** put it inline.

### Tamper resilience

The shipper writes append-only JSONL. Pair it with Loki's WORM retention
config (`compactor.retention_enabled: true` + immutable object-store backend
like S3 with Object Lock) for an audit-trail that survives a node compromise.
This satisfies ASVS V1.7.1 (operator-responsible per
`.security-hardening/12-compliance-report.md`).

---

## 6. OTel collector config (reference)

`/etc/otel/collector.yml`:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    timeout: 5s
  attributes/dilla:
    actions:
      - key: service.name
        value: dilla-server
        action: upsert
      - key: deployment.environment
        from_attribute: env
        action: upsert

exporters:
  prometheusremotewrite:
    endpoint: http://prometheus:9090/api/v1/write
  otlp/tempo:
    endpoint: tempo:4317
    tls: { insecure: true }
  # Optional escalation:
  # otlp/honeycomb:
  #   endpoint: api.honeycomb.io:443
  #   headers: { x-honeycomb-team: $HONEYCOMB_API_KEY }

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch, attributes/dilla]
      exporters: [otlp/tempo]
    metrics:
      receivers: [otlp]
      processors: [batch, attributes/dilla]
      exporters: [prometheusremotewrite]
```

---

## 7. Escalation paths (commented-out alternatives)

Operators with an existing investment can swap any single leg without
rewriting the rest of the topology:

| Default OSS leg | Managed swap | How |
|---|---|---|
| Promtail → Loki | Splunk HEC | Replace Promtail with the Splunk Universal Forwarder; point at HEC. Audit-shipper JSONL is HEC-compatible. |
| Promtail → Loki | Datadog Logs HTTP intake | Use the `datadog_logs` sink in Vector instead of Promtail. |
| Promtail → Loki | CloudWatch Logs Insights | Add a `cloudwatch_logs` sink in Vector; keep audit-shipper unchanged. |
| Prometheus | Datadog Metrics | OTel collector `datadog` exporter swap. |
| Tempo | Honeycomb / New Relic / Jaeger SaaS | OTel collector `otlp/<vendor>` exporter swap. |
| Alertmanager | PagerDuty Events API v2 | Configure the `pagerduty_configs:` receiver in Alertmanager (see `alertmanager.yml`). |

The Dilla side does not change. All swaps are exporter-level.
