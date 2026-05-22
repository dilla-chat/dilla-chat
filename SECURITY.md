# Security policy

Dilla is a federated, end-to-end encrypted Discord alternative. This
document describes the authentication / authorization design, the
threat model assumptions, and how to report a compromise.

For the broader hardening history see `.security-hardening/` —
each numbered report covers one phase (vulnerability scan, threat
model, architecture review, critical fixes, backend / frontend /
mobile hardening, and this auth-enhancement work in `08-`).

## 1. The passwordless Ed25519 model

Dilla does not use passwords. A user's identity *is* an Ed25519
keypair generated client-side at first install:

1. **Challenge.** The client posts the user's public key to
   `POST /api/v1/auth/challenge`. The server returns a 256-bit random
   nonce + a single-use `challenge_id` with a 5-minute expiry.
2. **Sign.** The client signs the nonce with the private key and posts
   `{challenge_id, public_key, signature}` to
   `POST /api/v1/auth/verify`.
3. **Verify.** The server consumes the challenge, verifies the
   Ed25519 signature in constant time (`ed25519-dalek`), looks up the
   user, and — on success — mints an access JWT (1 h) + a refresh JWT
   (24 h).

Failure modes (bad signature, unknown user, revoked device) all
return the same `401 invalid signature` response so the endpoint
cannot be used to enumerate registered public keys
(H3 / AUTH-ENUM-1).

## 2. Multi-factor without "MFA"

A passwordless model already eliminates the password-as-factor
class of attacks. Dilla pairs that with **multi-device key trust**
(see `.security-hardening/08-auth-enhancement.md` § A1):

- A user can hold N enrolled devices, each with its own Ed25519
  keypair stored client-side (Tauri keychain on desktop,
  IndexedDB-backed encrypted storage in the browser).
- Enrolling a new device requires an *already-trusted* device on the
  user's other machine to sign the new device's public key. The
  server verifies that signature against the trusted device's
  stored pubkey before inserting the row.
- Any trusted device can revoke any other device. Revocation is
  immediate for new JWT issuance and propagates to in-flight JWTs
  via the per-device `tokens_invalidated_after` cutoff.

That is the analog of MFA in a passwordless setting — every new
device must be authorized by an existing one, no SMS / TOTP /
hardware-key step required.

## 3. JWT lifecycle

| Claim | Source | Purpose |
|---|---|---|
| `sub` | user_id | Standard subject |
| `iat` | unix seconds | Issued-at; force-logout uses this |
| `exp` | unix seconds | Natural expiry (1 h access / 24 h refresh) |
| `jti` | UUID v4 | Per-token id used by the revocation list (H2) |
| `aud` | `node_name` | Audience pinning — only this node accepts the token |
| `iss` | `node_name` | Same value as `aud` |
| `did` | device_id | Multi-device binding (A1); empty for legacy tokens |

**Sliding refresh.** `POST /api/v1/auth/refresh` always mints a
fresh access token, and rotates the refresh token when it's past
half its lifetime (≤ 12 h remaining out of 24). Rotation revokes
the old jti, so a stolen refresh token has at most a 12 h blast
radius before its replacement supersedes it.

**Revocation.** `POST /api/v1/auth/logout` revokes the bearer
token by jti. The same revocation table backs refresh rotation.
The hourly GC task drops expired rows.

**Force-logout on permission change.** When a user's role is
updated server-side, every device row's `tokens_invalidated_after`
is bumped to "now". `validate_jwt` rejects any token with
`iat < tokens_invalidated_after` — in-flight access tokens
immediately stop honoring stale permissions.

**Cookie + bearer dual pathway (H-13).** Server issues an
httpOnly `__dilla_jwt` cookie on `/auth/verify` and
`/auth/refresh`, and clears it on `/auth/logout`:

```
Set-Cookie: __dilla_jwt=<jwt>; HttpOnly; SameSite=Strict;
            Secure; Path=/api/v1; Max-Age=3600
```

`Secure` is dropped only when `DILLA_INSECURE=true` (dev pattern
over plaintext HTTP). The client always sends the bearer header
AND `credentials: 'include'` so the cookie travels alongside.
`auth_middleware` prefers the header when both are present.

**Threat-model effect:** an XSS in the SPA can read the bearer
token from the encrypted-at-rest sessionStorage (F4 wrap key is
also reachable from JS), but it cannot read the cookie at all.
Future H-13c will drop the bearer header entirely so the cookie
becomes the only credential — at which point an XSS post-init has
no way to extract or replay the JWT.

**Cross-origin support (H-13c).** Operators who set
`DILLA_ALLOWED_ORIGINS` get a CORS layer that emits
`Access-Control-Allow-Credentials: true` against explicit method
and header allow-lists. Cross-origin clients can now ride the
cookie too; the bearer header isn't required just because the
client lives on a different origin.

**Client bearer drop (H-13d).** The client now decides per-call:
when the request's `baseUrl` matches the page's own origin AND
the page isn't on a Tauri custom protocol, the
`Authorization: Bearer` header is dropped and the cookie alone
authenticates the call. For cross-team flows (different
baseUrls) and Tauri desktop (where the SPA origin is
`tauri://localhost` etc. and doesn't share a cookie jar with the
https:// API), the bearer header still ships alongside.

**Threat-model effect after H-13d:** an XSS in the same-origin
SPA can no longer read the bearer token off the fetch surface —
the cookie isn't reachable from JS (HttpOnly), and the header
is no longer attached. XSS still can't replay the cookie from
a different origin (SameSite=Strict). The encrypted-at-rest
sessionStorage layer (F4) remains useful for the refresh token
and for cross-team / Tauri flows that still attach the bearer.

## 4. Permission model

Dilla uses a bitmask per role. PERM_ADMIN (1<<0) short-circuits to
"every bit set" — a future split would scope this down further.

| Bit | Constant | Default Owner | Default everyone | Notes |
|---|---|---|---|---|
| 0 | `PERM_ADMIN` | yes | no | All other bits implied |
| 1 | `PERM_MANAGE_CHANNELS` | via admin | no | |
| 2 | `PERM_MANAGE_MEMBERS` | via admin | no | |
| 3 | `PERM_MANAGE_ROLES` | via admin | no | |
| 4 | `PERM_SEND_MESSAGES` | via admin | yes | |
| 5 | `PERM_MANAGE_MESSAGES` | via admin | no | Delete / edit anyone's |
| 6 | `PERM_CREATE_INVITES` | via admin | yes | |
| 7 | `PERM_MANAGE_TEAM` | via admin | no | |
| 8 | `PERM_BYPASS_SLOW_MODE` | via admin | no | |
| 9 | `PERM_MUTE_VOICE` | via admin | no | |
| 10 | `PERM_MANAGE_FEDERATION` | yes (explicit) | no | A3: mint join tokens, manage peers |
| 11 | `PERM_VIEW_AUDIT_LOG` | yes (explicit) | no | A3: read `audit_events` |

Bits 10 and 11 are explicitly granted to the Owner role on team
creation in addition to being implied by `PERM_ADMIN`. The 029
migration backfills these bits onto every existing role that holds
`PERM_ADMIN` so the in-place upgrade is transparent.

## 5. Audit log

Every team-settings mutation and every authentication event writes
a row to `audit_events`. Schema: `(id, team_id, actor_user_id,
action, target_type, target_id, details, created_at)`.

The full action taxonomy is documented in
`.security-hardening/08-auth-enhancement.md` § Audit-event
taxonomy. Notable additions in this round:

- `auth.login` / `auth.login_failed`
- `auth.logout` / `auth.token_refresh`
- `device.enrolled` / `device.revoked` / `device.risk_event`
- `bootstrap.consumed`

Read access is gated by `PERM_VIEW_AUDIT_LOG` via
`GET /api/v1/teams/{team_id}/audit`.

## 6. Reporting a compromised device

If you suspect a device has been compromised:

1. From any other trusted device, open Settings → Devices and
   click **Revoke** on the compromised row. The server marks the
   device revoked; new JWT issuance fails immediately for that
   device_id.
2. Call `POST /api/v1/auth/logout` from the affected device if you
   can — it adds the current JWT's jti to the revocation list so
   the in-flight token dies before its natural exp.
3. If you can no longer access *any* of your devices, contact your
   team owner. They can mint a new bootstrap token via the
   operator-side CLI; you re-bootstrap on a fresh device.

## 7. Coordinated disclosure

Email security@dilla.chat (PGP key on the public website).

Please include reproduction steps and a clear severity assessment
in your initial report. We commit to:

- **24 hours**: acknowledgement.
- **7 days**: initial triage + proposed timeline.
- **90 days or sooner**: fix shipped and disclosure published.

We will credit reporters in the release notes unless you ask not
to be named.

## 8. Configuration security checklist

For production deployments:

- [ ] `DILLA_INSECURE=false` (the default).
- [ ] `DILLA_DB_PASSPHRASE` set to ≥ 32 raw bytes — load from file
      via `DILLA_DB_PASSPHRASE_FILE` to keep it out of `/proc`.
- [ ] `DILLA_TLS_CERT` + `DILLA_TLS_KEY` present (HTTPS only).
- [ ] `DILLA_ALLOWED_ORIGINS` pinned to the actual frontend
      origin(s).
- [ ] `DILLA_NODE_NAME` set so JWT `aud`/`iss` pinning has a
      stable identity.
- [ ] Federation peers configured with `wss://` URLs; the
      transport refuses `ws://` outside `DILLA_INSECURE=true`
      (H7 / VULN-014).

## 9. Federation trust model — known limitations

Dilla nodes federate over WebSocket. The current implementation
delivers **Phase 1** of the federation security model — enough to
defeat anonymous attackers and on-path MITM, but **not** enough to
defeat a malicious *authenticated* peer. Operators must understand
this trade-off before federating with peers they don't fully trust.

### What today's controls cover

- **Transport.** Plaintext `ws://` peers are refused outside
  `DILLA_INSECURE=true`. `wss://` peers ride TLS with the system
  trust store.
- **Peer authentication.** A shared `DILLA_JOIN_SECRET` (HKDF-SHA256
  derived, ≥32 bytes enforced) gates inbound peer auth. Empty
  secret is refused at startup unless `DILLA_INSECURE=true`. The
  auth comparison is constant-time.
- **Rate limiting.** Per-peer state-sync volume is bounded; floods
  trigger alert rule 5 in `deploy/monitoring/correlation-rules.yaml`.

### What today's controls do NOT cover

Once a peer authenticates, it is treated as fully trusted on state
merge. A peer that holds the `join_secret` — or that you federate
with intentionally — can:

- **Forge channels, roles, members, messages** on every other node
  via last-writer-wins merge. Tracked as DILLA-VULN-002. The full
  fix (per-node Ed25519 signed `FederationEvent` envelopes with
  authority validation) is **Phase 3** architectural work and not
  yet shipped. See `.security-hardening/03-architecture-review.md`
  §7 for the redesign sketch.
- **Read all replicated metadata** — ciphertext, sender IDs,
  timing, reply graph, attachment IDs, reaction counts. Message
  *bodies* remain end-to-end encrypted (Signal Protocol), but the
  full social graph is inherent to a federated chat. Tracked as
  FED-META-1 in `.security-hardening/02-threat-model.md`.
- **Replicate without provenance.** Audit rows for federation-merged
  state don't carry the originating peer ID. Tracked as FED-AUDIT-1;
  depends on the Phase 3 redesign.

### Voice IP leakage (SFU-IP-1)

WebRTC ICE candidates exchanged in voice channels include each
speaker's real IP. The pre-existing fix for VULN-004 (WS subscribe
ACL) closed the cross-channel leak path — only legitimate channel
members see ICE candidates today — but a member who joins a voice
channel will see every other speaker's IP. Operators who need IP
privacy should configure clients to force TURN-only mode; the
relay strips peer-to-peer candidates.

### Operator guidance

- **Federate only with peers you'd trust as a co-administrator.**
  The shared `join_secret` is currently a single point of full
  federation compromise.
- **Rotate `DILLA_JOIN_SECRET` whenever a peer leaves the
  federation.** Outstanding join JWTs become invalid by design
  after HKDF rotation.
- **Don't federate across organizational trust boundaries** until
  the Phase 3 redesign ships. Run separate Dilla deployments
  bridged at the user level instead.
- **Monitor federation peer message volume** via the alert rules
  shipped in `deploy/monitoring/`. A peer flooding state-sync is
  the visible signal of either a bug or a malicious peer.

This section will shrink as the Phase 3 redesign lands. Track
progress against DILLA-VULN-002 / FED-META-1 / FED-AUDIT-1 /
SFU-IP-1 in `.security-hardening/`.

## 10. Cross-references

- Architecture review (current + target): `.security-hardening/03-architecture-review.md`
- Critical fixes: `.security-hardening/04-critical-fixes.md`
- Backend hardening (H1–H12): `.security-hardening/05-backend-hardening.md`
- Frontend hardening (F1–F5): `.security-hardening/06-frontend-hardening.md`
- Mobile hardening: `.security-hardening/07-mobile-hardening.md`
- Auth enhancement (A1–A7, this round): `.security-hardening/08-auth-enhancement.md`
