# Playbook — auth brute force / credential stuffing

Triggered by `correlation-rules.yaml`:
- `AuthBruteForceFromIP` (rule 1) — >10 failures/5m from one IP
- `AuthCredentialStuffing` (rule 2) — failures from >30 distinct IPs/5m
- `RateLimitClusterPerIP` (rule 9) — same IP eating 429s

## 1. Identify the source

Pull the offending IP(s) and their target(s):

```logql
{job="dilla-audit", action="auth.login_failed"}
  | json | __error__ = ""
  | line_format "{{.created_at}}  ip={{.details.ip}}  ua={{.details.user_agent}}  reason={{.details.reason}}"
```

Restrict the time window to the 10 min ending at the alert timestamp.

## 2. Mass scan vs. targeted

- **Mass scan** signature: `details.user_agent` is from a known scanner
  family (`zgrab`, `Mozilla/5.0 (compatible; ...)` with no JS engine),
  high distinct `target_public_key` count, low overlap with real users.
- **Targeted** signature: `target_public_key` clusters on 1-3 real user
  rows. This is the dangerous case — the attacker has narrowed down to
  a real identity.

If targeted, also pull `device.risk_event` for the same `user_id`:

```logql
{job="dilla-audit", action="device.risk_event", user_id="<uid>"}
```

A score spike that aligns with the failure burst is corroborating
evidence that this is the same actor as the brute-force.

## 3. Shadowban at the edge

In priority order (pick the layer that's available):

```sh
# (a) Cloudflare WAF (if proxied) — preferred, no host load
# Add to deploy/waf/cloudflare-waf.json "block by IP" rule and redeploy.

# (b) UFW (Debian/Ubuntu)
ufw insert 1 deny from <ip> to any

# (c) nftables
nft add element inet filter blackhole '{ <ip> }'

# (d) pf (BSD/macOS)
echo "<ip>" >> /etc/pf.blocklist && pfctl -t blocklist -T load -f /etc/pf.blocklist
```

For credential-stuffing (rule 2), prefer the WAF route — banning 30+
distinct IPs by hand is operationally painful. Cloudflare "challenge
suspicious traffic" mode is the right hammer.

## 4. Audit-log the response

Operators making firewall changes should leave a trail:

```sh
logger -t dilla-incident "shadowban added: <ip> reason=brute-force ticket=<id>"
```

For multi-operator teams, follow up with a notes entry in the team's
incident-tracker (matrix-bot / shared doc). The shadowban itself is
**not** in `audit_events` (it's at the host firewall layer, not the
Dilla layer); the matrix-bot post is the canonical record.

## 5. Notify the targeted user (if any)

If §2 identified a real user as the target:

1. From an admin device, force-revoke that user's open sessions:

   ```sh
   # Until POST /api/v1/auth/logout-all exists (follow-up FU-2),
   # use the device-revoke path per known device:
   curl -X POST -H "Authorization: Bearer <admin-jwt>" \
     https://<dilla>/api/v1/devices/<did>/revoke
   ```
2. Send a DM via the in-app system-account explaining the timing.
3. If the user is the team owner, also rotate their JWT secret and
   force a fresh device-enrollment flow.

## 6. Post-incident

- Confirm the alert clears within 10 min of the firewall change.
- File a 1-paragraph post-mortem if the burst exceeded 1 hour total or
  if a real user was targeted.
- Tune the rule threshold only after **two** false positives — once is
  noise, twice is a pattern.
