# Running Dilla as a Tor Hidden Service

H-18. Step-by-step guide for operators who want to run Dilla as a
`.onion` service — bridging operator anonymity with the federated
end-to-end encrypted chat surface.

## Threat model

A Tor hidden service hides:
- The operator's server IP from federation peers and clients.
- The server's network location from anyone eavesdropping on the
  Tor circuit (the .onion is reachable only via Tor).

A Tor hidden service does NOT hide:
- **Federation metadata** between peers — see [`SECURITY.md`](../../SECURITY.md)
  §9 / FED-META-1. A federation peer still sees every replicated
  channel, message ciphertext, and the full social graph.
- **Voice ICE candidates** — see SFU-IP-1 + H-3. Even with the
  whole control plane on .onion, voice RTP runs over WebRTC + TURN
  and ICE candidates carry the speaker's IP. For high-privacy voice
  set `teams.force_turn_relay = 1` (H-3) and ensure clients honor
  it.
- Your operating system, browser fingerprint, or any compromise in
  the WebView itself.

Operating a hidden service is harder than a clearnet one. Read
[Tor's Onion Services guide](https://community.torproject.org/onion-services/)
before deploying for users you care about.

---

## Option A — Docker Compose (recommended)

`/Users/thim/Repositories/dilla-chat/deploy/docker/compose.yml`
already ships a commented-out `tor:` service. Enable it:

1. Uncomment the `tor:` service block (lines ~93-105 in compose.yml).
2. Uncomment the `tor-data:` volume entry (line ~111).
3. Drop a `torrc` next to the compose file with hidden-service
   directives (see [Torrc template](#torrc-template) below).
4. `docker compose up -d tor` — the first run generates the .onion
   address inside `tor-data:/var/lib/tor/dilla/hostname`.
5. Bind the reverse proxy (Caddy / nginx / Traefik) to the Tor
   service so it forwards `:80` on the .onion to the dilla-server
   internal port.

### Torrc template

`/etc/tor/torrc` inside the `dperson/torproxy` container:

```
SocksPort 0
HiddenServiceDir /var/lib/tor/dilla
HiddenServiceVersion 3
HiddenServicePort 80 caddy:80
# HiddenServicePort 443 caddy:443   # if you also want HTTPS over .onion

# Federation peer connectivity over Tor: enable a SOCKS5 proxy that
# dilla-server can use to reach OTHER nodes' .onion addresses. Pair
# with DILLA_OUTBOUND_SOCKS5 (operator-side; not yet wired in the
# binary — track as a follow-up if you need it).
# SocksPort 9050
```

Restrict the file ownership: `chown -R debian-tor:debian-tor /var/lib/tor/dilla && chmod 700 /var/lib/tor/dilla`.

---

## Option B — systemd-managed Tor on the host

For non-Docker deployments where `tor.service` is already running:

1. Install Tor: `apt install tor` (Debian/Ubuntu) or your distro's
   equivalent.
2. Edit `/etc/tor/torrc` to add:
   ```
   HiddenServiceDir /var/lib/tor/dilla
   HiddenServiceVersion 3
   HiddenServicePort 80 127.0.0.1:443
   ```
   (Where `127.0.0.1:443` is wherever your reverse proxy binds for
   the Dilla upstream.)
3. `systemctl reload tor`.
4. Read the .onion address: `cat /var/lib/tor/dilla/hostname`.
5. Verify the connection: `torify curl http://<your-onion>.onion/api/v1/health`.

---

## Federation over .onion

Federating two `.onion`-hosted Dilla nodes works the same as
federating clearnet nodes, with two caveats:

1. **TLS still applies.** `DILLA_INSECURE=false` (the default) +
   `DILLA_TLS_CERT` / `DILLA_TLS_KEY` set — Tor's circuit
   encryption doesn't replace end-to-end TLS, it adds another
   layer. Use a self-signed cert + the operator-side pinning from
   H-9 / H-10 v3 handshake. Or rely on the Tor circuit alone if
   you set `DILLA_INSECURE=true` (federation transport refuses
   `ws://` outside insecure mode per VULN-014).
2. **Outbound SOCKS5 isn't wired yet.** `DILLA_PEERS=ws://abc.onion:80/federation`
   won't go through Tor automatically — the binary speaks
   straight TCP. If you need .onion-to-.onion federation today,
   run Dilla behind a forward-proxy container that bridges the
   network namespace.

This is documented as a follow-up: `DILLA_OUTBOUND_SOCKS5` env that
plugs into the reqwest client. Not security-critical for normal
operators; only relevant if you want both endpoints over Tor.

---

## Verification checklist

- [ ] `cat /var/lib/tor/dilla/hostname` returns a valid v3 .onion
      (56 chars + ".onion").
- [ ] `torify curl http://<onion>.onion/api/v1/health` returns 200.
- [ ] The .onion descriptor isn't accessible without Tor (use a
      clearnet browser to confirm timeout).
- [ ] `journalctl -u tor` (or the container logs) shows the
      hidden-service descriptor being published.
- [ ] Reverse proxy is bound to the Tor-internal network ONLY —
      not exposed on a clearnet port. Otherwise the IP leaks.
- [ ] Backup the contents of `/var/lib/tor/dilla/` somewhere
      encrypted. The `hs_ed25519_secret_key` IS your hidden
      service identity. Lose it and you lose the .onion address.

---

## Operator hygiene

- Don't run a clearnet listener at the same time unless you really
  understand what you're doing. The dual-bind defeats the whole
  point.
- Don't leak the server's clearnet IP via outbound DNS or
  telemetry. Verify Sentry / OTel exporters are also routed
  through Tor (or disabled).
- Tor circuits rotate; a misconfigured CDN-in-front or a
  HSTS-pinned clearnet alias can fingerprint your service across
  rotations. Keep the .onion deployment isolated from any
  clearnet alias of the same operator.
- The bootstrap-token banner from VULN-009 lands in the operator's
  `${DATA_DIR}/BOOTSTRAP_TOKEN` file. Make sure that's only
  readable by the dilla service user, mode 0600.
