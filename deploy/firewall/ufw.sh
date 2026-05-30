#!/usr/bin/env bash
# Dilla — UFW (Uncomplicated Firewall) reference rule-set.
#
# Threat model:
#   - dilla-server runs behind a reverse proxy on this same host.
#   - The reverse proxy is the only public-facing thing: 80 + 443 inbound.
#   - Federation traffic rides a WireGuard mesh on wg0 (10.42.0.0/24).
#   - Admin SSH lives on a non-default port (here, ${ADMIN_SSH_PORT}) and is
#     restricted to the operator's bastion CIDR (${ADMIN_CIDR}).
#   - Outbound is opened only for what dilla actually needs (DNS, HTTPS, NTP,
#     and the mesh peers). Default-deny on egress closes SSRF / exfil paths
#     even if app-layer egress allow-list (R-19) is bypassed.
#
# Usage:
#   sudo ADMIN_SSH_PORT=2222 ADMIN_CIDR=203.0.113.0/24 bash ufw.sh
#
# Tested-with: ufw 0.36.2 on Debian 12.

set -euo pipefail

: "${ADMIN_SSH_PORT:?set ADMIN_SSH_PORT (e.g. 2222)}"
: "${ADMIN_CIDR:?set ADMIN_CIDR (e.g. 203.0.113.0/24)}"
WG_MESH_CIDR="${WG_MESH_CIDR:-10.42.0.0/24}"

ufw --force reset
ufw default deny incoming
ufw default deny outgoing     # critical: deny outbound by default

# --- Inbound -----------------------------------------------------------------
# Admin SSH (rate-limited at 6/min by UFW's `limit` verb).
ufw limit proto tcp from "${ADMIN_CIDR}" to any port "${ADMIN_SSH_PORT}" comment 'admin SSH'

# Public web — HTTPS only. HTTP exists solely for the ACME redirect.
ufw allow proto tcp from any to any port 80   comment 'HTTP (ACME + redirect)'
ufw allow proto tcp from any to any port 443  comment 'HTTPS'
ufw allow proto udp from any to any port 443  comment 'HTTP/3 (QUIC)'

# WireGuard federation mesh (UDP 51820 by default).
ufw allow proto udp from any to any port 51820 comment 'WireGuard mesh'

# Federation listener — only from the WG peers.
ufw allow proto tcp from "${WG_MESH_CIDR}" to any port 9443 comment 'federation peers'

# --- Outbound ----------------------------------------------------------------
# DNS (TCP + UDP 53).
ufw allow out proto udp from any to any port 53 comment 'DNS'
ufw allow out proto tcp from any to any port 53 comment 'DNS-over-TCP'

# HTTPS — required for Cloudflare TURN, Let's Encrypt, optional Giphy.
ufw allow out proto tcp from any to any port 443 comment 'HTTPS egress'

# NTP.
ufw allow out proto udp from any to any port 123 comment 'NTP'

# Federation peers over the mesh.
ufw allow out proto tcp from any to "${WG_MESH_CIDR}" port 9443 comment 'federation peers'
ufw allow out proto udp from any to any port 51820 comment 'WireGuard handshake'

# Loopback (reverse-proxy → dilla-server on 127.0.0.1:8080).
ufw allow out on lo

# Established connections (UFW does this automatically via /etc/ufw/before.rules
# but make the intent explicit in logs).
ufw allow out from any to any state RELATED,ESTABLISHED 2>/dev/null || true

ufw logging medium
ufw --force enable
ufw status verbose
