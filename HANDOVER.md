# Dilla — Repo Handover (live document)

This is the **live source of truth** for everything outstanding
across the whole repo. When an item is finished, delete its block
**in the same commit that closes the item**. The commit message
should reference the item id (H-N). When this file is empty, no
in-flight work remains.

**How to use this:**
- **Tractable** — items an in-session contributor can knock out
  one-by-one. Each has a concrete "definition of done".
- **Integration tier** — release-coordinated work that touches the
  federation wire protocol or other multi-node concerns. Do NOT
  auto-apply these — they need explicit operator coordination and
  rolling-upgrade planning.
- **Product / UX follow-ups** — non-security work known to be
  in-flight or stubbed.
- **Architectural deferrals** — known limitations that are
  documented (in `SECURITY.md` §9 etc.) and tracked here for
  future revisits.

**Branch posture going into this handover:**
- On `feat/mesh-redesign`, 500+ commits ahead of `main`.
- Server builds clean (`cargo build --release`).
- Dev pattern `DILLA_INSECURE=true …` works.
- Client builds clean (`npm run build`).
- `npm audit` reports 0 vulnerabilities.
- `cargo test --release`: **803 passed, 0 failed** (H-4 closed).

---

## Tractable (in-session-friendly)

(none — H-4 closed)

---

## Integration tier (release-coordinated, NOT for autonomous patching)



---

## Product / UX follow-ups

### H-14b — Device-enrollment flow (remainder of H-14)

The device list + revoke UI shipped in Settings → Devices. The
"enroll a new device" flow is still open:

- QR code or short-string transfer of an enrollment payload from
  the new device to an authorizing device.
- The authorizing device signs the enroll-complete request
  (server endpoint `POST /api/v1/devices/enroll-complete`
  already exists).
- Recovery path when the user has only one device and wants to
  enroll a second — likely a recovery code / passphrase mechanism
  separate from the multi-device key trust model.

Real product UX work; should be planned alongside the
account-recovery story.

### H-22 — Stacked-modal z-index / focus trap blocks editing

In Settings → Roles & permissions → click `Edit` on a role: the
Edit Role sub-modal opens visually on top of the Team Settings
modal, but interaction is blocked — the underlying modal's
backdrop / focus trap appears to swallow events, so checkboxes
and inputs in the inner modal can't be clicked or typed into.

Need to either (a) hoist the sub-modal into its own portal at a
higher z-index with its own focus trap, or (b) push the
underlying Team Settings modal into a "behind" state (no focus
trap, inert) while the sub-modal is open. Probably impacts every
nested-modal flow (role editor, channel-settings sub-dialogs,
etc.) so fix is shared.

Repro: open Team Settings → Roles & permissions → Edit on any
role → try to toggle any permission checkbox or change the role
name.

### H-23 — Voice diagnostic log spam to /debug/browser-log

While in a voice channel, `[Voice/diag] outbound-rtp stream
breakdown` lines are POSTed to `/api/v1/debug/browser-log` on
every stats tick — multiple per second. The endpoint is intended
for opportunistic error capture, not a firehose, and the payloads
ship every outbound-rtp stat sample over the wire (and into the
server log). Server is rate-limiting them (`HTTP/3 429` confirmed
in browser network panel), so the data is being dropped anyway.

Fix: either drop the diag tick from the upload pipeline entirely
(keep it in the local console only), throttle to once per N
seconds, or gate behind a "verbose telemetry" user setting.

Repro: join any voice channel, watch Network → XHR or
`journalctl -u dilla.service -f`.

### H-24 — Voice ICE failure has no user-facing feedback

On `dilla.thim.dev` joining a voice channel produces:

```
WebRTC: ICE failed, add a TURN server and see about:webrtc
[Voice/diag] iceConnectionState → failed
[Voice/diag] connectionState → failed
```

Server-side, confirmed via journalctl:

```
GET /api/v1/voice/credentials → 404
webrtc_ice: could not get server reflexive address udp6 stun:stun.l.google.com:19302: Network is unreachable
webrtc_ice: pingAllCandidates called with no candidate pairs. Connection is not possible yet.
```

Root cause: in the reverse-proxied deployment topology
(Caddy / Cloudflare Tunnel terminates HTTPS → upstream Dilla
server on plain HTTP), WebRTC media UDP never traverses the
proxy. The SFU itself needs either a publicly reachable UDP
port or a TURN relay. Neither is configured by default, so the
SFU advertises only loopback / private candidates that no client
can reach, and the `/api/v1/voice/credentials` endpoint returns
404 because `CF_TURN_KEY_ID` / `CF_TURN_API_TOKEN` are unset.

Three fixes, in priority order:

1. **Install script should make TURN config mandatory or
   explicit-opt-out for the reverse-proxy install path**. Right
   now `scripts/install-proxmox-lxc.sh` doesn't even mention
   `CF_TURN_KEY_ID`. The post-install hint should walk the user
   through the Cloudflare Calls TURN setup (free up to ~1 TB/mo)
   and write the env vars into `/etc/dilla/dilla.env`.
2. **UX**: when `iceConnectionState` or `connectionState` reaches
   `failed`, the user should get a clear "call failed to connect
   — your server doesn't have a TURN relay configured" toast and
   the voice panel should drop them out of the channel
   automatically instead of staying stuck in a half-joined state.
3. **Server**: `/api/v1/voice/credentials` returning 404 when
   TURN isn't configured is misleading — should return 200 with
   an empty `iceServers: []` and a `reason: "turn_not_configured"`
   field so the client can show the right error instead of
   silently falling back to STUN-only.

Related: `startScreenShare: pre-bind never landed — screen will
not flow` appears in the same session — clicking screen-share
on a failed peer connection should be blocked (or at least show
an error), not silently fire a no-op.

### H-25 — CSP blocks an inline script on first load

```
Content-Security-Policy: blocked an inline script (script-src-elem)
"script-src 'self'"
Consider using a hash ('sha256-ieoeWczDHkReVBsRBqaal5AFMlBtNjMzgwKvLqi/tSU=')
sandbox eval code:17:34
```

Comes from `sandbox eval code` so possibly a browser-extension or
worker context rather than our bundle, but worth a one-pass audit:
grep the built assets for the offending sha256 to confirm it's not
something Vite is emitting inline (would block in stricter CSP
deployments).

---

## Architectural deferrals (documented; not for in-session work)


---

## Closed in earlier sessions (for the record)

Summarized — full details in `.security-hardening/`:

- Phase 1 assessment (24 numbered findings + threat model +
  architecture review).
- Phase 2 remediation: critical fixes (commits `c9adcd8`..`244e15d`),
  backend hardening (`8a52367`..`587ae67`), frontend hardening
  (`5dbc856`..`bb03b16`).
- Phase 3 controls: auth enhancement (`0d55d30`..`b7eb3cd`),
  infrastructure docs (`004dbad`), secrets management
  (`eea6661`, `6644a6b`).
- Phase 4 validation + compliance + SIEM playbook (`004dbad`..`c286dca`).
- Federation Phase 3 foundation: design doc (`55063cc`), identity
  + migrations (`d3ac12a`), peers (`f7e55df`), wire (`76885cd`),
  authority (`8225e43`), admin API (`7410d31`), team-owner hook
  (`677f403`).
- 8 net-new findings from validation closed: VULN-015 doc
  (`3be0633`), bootstrap expiry fail-closed (`372b5f6`),
  federation empty-secret rejection (`5dbf455`), WS team-param
  membership (`3f46be4`), unlinked-attachment cross-team
  (`0552035`), TOCTOU revoke (`aa7bc50`), DNS-rebind SSRF
  (`4470fe8`).
- A6 policy-migration tail across 11 REST handlers (`3b7828c`).
- SECURITY.md §9 federation known-limitations (`33b83ab`).
