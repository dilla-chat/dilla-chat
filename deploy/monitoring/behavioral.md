# Dilla — behavioral analytics (threat-hunting catalog)

These are **ad-hoc queries** for an analyst sitting at Grafana, not
firing alert-rules. They complement the prescriptive rules in
`correlation-rules.yaml` by letting you go fishing.

Assumes the Loki + Prometheus pipeline from `ARCHITECTURE.md` is in place.

---

## 1. Repeat offenders: users with >5 risk events in 7 days

LogQL:

```logql
topk(20,
  sum by (user_id) (
    count_over_time(
      {job="dilla-audit", action="device.risk_event"}
        | json | __error__ = "" [7d]
    )
  ) > 5
)
```

**Why it matters.** A user with many risk-events is either being targeted
or has lost a device they didn't revoke. Cross-check against
`auth.token_refresh` from unexpected IPs (query 2).

---

## 2. Refresh-token-rotation outliers (stolen refresh-token detector)

Per-device `auth.token_refresh` rate. Healthy clients refresh ~once every
~12-24h (sliding window per `08-auth-enhancement.md §3`); an outlier with
>10/day suggests two clients sharing a refresh token.

LogQL:

```logql
topk(20,
  sum by (device_id) (
    count_over_time(
      {job="dilla-audit", action="auth.token_refresh"}
        | json | __error__ = "" [24h]
    )
  )
)
```

Render as a Grafana stat panel with `> 10` threshold red.

---

## 3. Top 20 IPs by 401 in the last hour

LogQL (Caddy access log):

```logql
topk(20,
  sum by (remote_ip) (
    count_over_time(
      {job="caddy"}
        | json | status = "401" | __error__ = "" [1h]
    )
  )
)
```

**Hunt:** any IP showing > ~50 401s without an obvious user-agent
profile is probably a scanner. Cross-check against rule 9
(`RateLimitClusterPerIP`); if both fire, ban at the edge.

---

## 4. Federation peer message-volume heatmap (hour of day)

PromQL (assumes `dilla_fed_sync_total` counter exists; see follow-up
FU-1 in `13-monitoring-siem.md`):

```promql
sum by (peer_id) (
  increase(dilla_fed_sync_total[1h])
)
```

Display in Grafana as a heatmap panel with `peer_id` on Y and hour-of-day
on X. The bands tell you each peer's normal load envelope; bright cells
outside the envelope are the hunt target.

Until the metric ships, the Loki fallback:

```logql
sum by (peer_id) (
  count_over_time(
    {job="dilla-server"} |~ "state_sync_received"
      | json | __error__ = "" [1h]
  )
)
```

---

## 5. Channel-join denied bursts (recon attempt)

A `channel.join_denied` log line is emitted by the `policy::can_subscribe_channel`
path (see `05-backend-hardening.md` policy migration). High counts
per-user-per-day suggest someone systematically probing the channel
namespace.

LogQL:

```logql
topk(20,
  sum by (user_id) (
    count_over_time(
      {job="dilla-server"}
        |~ "channel:join denied"
        | json | __error__ = "" [24h]
    )
  ) > 50
)
```

---

## 6. Attachment-download outliers (exfiltration hunt)

PromQL (assumes per-team `dilla_uploads_bytes_downloaded_total` counter —
follow-up FU-1):

```promql
topk(10,
  sum by (team_id) (
    increase(dilla_uploads_bytes_downloaded_total[1h])
  )
)
```

Until the metric ships, lean on Caddy access logs for `/api/v1/teams/*/uploads/*`:

```logql
topk(10,
  sum by (team_id) (
    rate(
      {job="caddy"}
        |~ "/api/v1/teams/[^/]+/uploads/"
        | json | status = "200" | __error__ = "" [1h]
    )
  )
)
```

**Hunt threshold:** any team transferring >10× its 7-day median deserves
a look. Use Grafana's `quantile_over_time` on a 7-day window for the
baseline.

---

## 7. Per-device session count (lost-device hunt)

Distinct active `device_id`s per `user_id` in the last 24h:

```logql
sum by (user_id) (
  count(
    count by (user_id, device_id) (
      count_over_time(
        {job="dilla-audit"}
          | json | __error__ = "" [24h]
      )
    )
  )
)
```

Users with >5 devices may have forgotten to revoke an old phone.

---

## 8. OTPK consumption sources (deanon hunt)

Distinct `actor_user_id` who consumed >10 OTPKs targeting *different*
users in 1h — combines two signals:

```logql
count by (user_id) (
  count by (user_id, target_id) (
    count_over_time(
      {job="dilla-audit", action="prekey.consume"}
        | json | __error__ = "" [1h]
    )
  )
) > 10
```

A normal client consumes OTPKs for the people they DM. >10 distinct
targets in an hour is reconnaissance — pair with rule 6 for paging
behavior.

---

## 9. Bootstrap-consumption audit (post-install)

Run this **once per install** and after any bootstrap-token rotation:

```logql
{job="dilla-audit", action="bootstrap.consumed"}
  | json | line_format "{{.created_at}}  team={{.team_id}}  by={{.actor_user_id}}  ip={{.details.ip}}"
```

There should be exactly one row, from the operator's known IP. Anything
else triggers `playbooks/bootstrap-token-leak.md`.

---

## 10. Voice-room duration outliers

PromQL (assumes `dilla_voice_room_duration_seconds` histogram —
follow-up FU-1):

```promql
histogram_quantile(0.99,
  sum by (le, team_id) (
    rate(dilla_voice_room_duration_seconds_bucket[1h])
  )
)
```

p99 voice-room durations spiking past 8h usually means a runaway client
keeping a room hot — abuse vector for SFU bandwidth.

---

## 11. Token-revocation rate

PromQL (assumes `dilla_jwt_revoked_total`):

```promql
rate(dilla_jwt_revoked_total[5m]) * 300
```

A sudden spike means either an admin is doing role-rotation, or a force-
logout campaign is in progress, or somebody hit the panic button.

---

## 12. New-device-per-hour by team

LogQL:

```logql
sum by (team_id) (
  count_over_time(
    {job="dilla-audit", action="device.enrolled"}
      | json | __error__ = "" [1h]
  )
)
```

For a 50-user team you'd expect ~0-2 per hour. Sustained >5 on a small
team is a sign of either an onboarding event or a token leak inside the
team.
