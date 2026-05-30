# Dilla — DDoS posture and surge handling

Dilla is single-binary, not a load-balanced fleet. A small surge is handled
by the in-process rate limiters; a large surge needs an upstream CDN /
anycast layer to absorb traffic.

## Layered defense

```
Internet
   │
   ▼
┌──────────────────────────────────┐
│ L1: Cloudflare (anycast + WAF)    │  ← UDP/TCP flood absorbed at the edge
└──────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────┐
│ L2: Reverse proxy (Caddy/nginx)   │  ← TLS termination + buffer limits +
│   per-IP connection caps          │     `client_max_body_size`
└──────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────┐
│ L3: dilla-server                  │  ← tower_governor (R-09 / H1),
│   tower_governor + WS quotas      │     WS subscription cap (H4),
│                                   │     pong-miss reaper (H?), upload
│                                   │     quota per team (H12)
└──────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────┐
│ L4: SQLCipher (single writer)     │  ← natural choke-point; surge here
│                                   │     manifests as 5xx, not corruption
└──────────────────────────────────┘
```

## L1 — Edge (Cloudflare or equivalent)

If you can put Cloudflare in front of your domain, do it. Even the Free
tier:
- absorbs SYN floods, UDP amplification, common L7 brute-force.
- gives you the Custom Rules in `deploy/waf/cloudflare-waf.json`.
- adds a `cf-ray` header that gets logged by your reverse proxy — handy for
  correlating an abuse report with a request.

Non-Cloudflare anycast options: bunny.net, Vercel/Netlify edge, Fastly. All
work as long as they proxy WebSockets.

**Trade-off:** Cloudflare sees plaintext after TLS termination at their
edge. If your threat model excludes Cloudflare being trusted (e.g. journalist
deployment), skip L1 and lean harder on L2/L3.

## L2 — Reverse proxy

The reference configs in `deploy/reverse-proxy/` already include:

- **Caddy:** `request_body { max_size 50MB }` (matches `DILLA_MAX_UPLOAD_SIZE`).
- **nginx:** `client_max_body_size 50m`, `limit_req_zone` for auth + general
  API.
- **Traefik:** `dilla-rate-limit` middleware at 100r/s average / 200 burst.

Additional knobs worth setting if you see sustained pressure:

- **Caddy:** `servers { max_header_size 16KB }` to drop slow-loris.
- **nginx:** `large_client_header_buffers 4 8k`, `client_header_timeout 10s`,
  `client_body_timeout 10s`.
- **All:** keepalive timeout 60-75s. Connections idle longer get reaped.

## L3 — Application layer

Already implemented:

| Control | Env var | Default | Notes |
|---|---|---|---|
| Global rate limit (auth surface) | `DILLA_RATELIMIT_PER_SECOND` | 30 | tower_governor (H1) |
| Burst allowance | `DILLA_RATELIMIT_BURST` | 60 | bucket capacity |
| Legacy rate limit | `DILLA_RATE_LIMIT` | 100.0 | rps, kept for compat |
| Burst legacy | `DILLA_RATE_BURST` | 200 | |
| Max upload size | `DILLA_MAX_UPLOAD_SIZE` | 25 MiB | enforced server-side |
| Upload quota / team | `DILLA_UPLOAD_QUOTA_PER_TEAM_GB` | 10 | H12 |

Things to add behind a feature flag (not yet implemented — see Open Items in
`09-infra-security.md` §5):

- `DILLA_OVERLOAD_BANNER=true` — when set, the server returns a "service
  degraded" banner in the SPA's `/api/v1/health` payload, the SPA renders a
  yellow banner across the top. Useful during planned drains.
- WS-per-IP subscription cap (currently per-user; per-IP is stricter).

## L4 — Storage / DB

SQLCipher is the choke-point. Under heavy concurrent write load you'll see
`SQLITE_BUSY` and the app surfaces `503`. That's by design; load shedding at
the storage tier means you don't corrupt the DB.

**Monitoring:** alert on > 1% of API responses being 503 over a 5-min window.

```promql
rate(http_responses_total{status="503"}[5m])
  / rate(http_responses_total[5m]) > 0.01
```

(Requires `DILLA_OTEL_ENABLED=true` and Prometheus scraping the OTel
collector.)

## Load shedding strategy

When the box is overloaded:

1. **First** — turn on `DILLA_OVERLOAD_BANNER=true` (when implemented). The
   client sees a banner; new sessions self-back-off.
2. **Then** — tighten `DILLA_RATELIMIT_PER_SECOND` to 10 with
   `systemctl set-environment` + reload. tower_governor picks up the new
   value immediately.
3. **Then** — flip the WAF rule in
   `deploy/waf/cloudflare-waf.json` rule #2 to `block` action instead of
   `challenge`. Edge starts dropping auth requests.
4. **Last resort** — `systemctl stop dilla-server` and serve a static
   maintenance page from the reverse proxy. Caddy:
   ```caddyfile
   ${DILLA_DOMAIN} {
       respond "Dilla is currently undergoing maintenance. Back soon." 503
   }
   ```

## What this guide does NOT promise

- **Anti-DDoS appliance protection.** That requires anycast at the network
  layer — Cloudflare / AWS Shield Advanced / equivalent. Self-hosters on a
  single VPS cannot defeat a determined volumetric attacker on their own;
  the upstream provider matters.
- **Survival of state-actor-scale attacks.** Out of scope for a self-hosted
  product.
- **Zero data loss during overload.** Load shedding returns 503; clients
  retry. Messages in flight may be dropped — clients should re-send.
