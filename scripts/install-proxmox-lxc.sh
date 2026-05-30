#!/usr/bin/env bash
#
# Proxmox LXC installer for the Dilla server.
#
# Run on the PVE host as root:
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/dilla-chat/dilla-chat/main/scripts/install-proxmox-lxc.sh)"
#
# Or with overrides:
#
#   CTID=210 CT_HOSTNAME=chat MEMORY=2048 \
#     bash -c "$(curl -fsSL https://raw.githubusercontent.com/dilla-chat/dilla-chat/main/scripts/install-proxmox-lxc.sh)"
#
# To update an already-installed container in-place:
#
#   ACTION=update CTID=121 \
#     bash -c "$(curl -fsSL https://raw.githubusercontent.com/dilla-chat/dilla-chat/main/scripts/install-proxmox-lxc.sh)"
#
# Interactively, the script asks "Install / Update / Cancel" first.
#
# Creates an unprivileged Ubuntu 24.04 container, downloads the latest
# release binary from GitHub, and installs it as a systemd service.
# Exposes the Dilla HTTP/WS port on the LXC's IP address — terminate
# TLS with your own reverse proxy (Caddy, nginx, Cloudflare Tunnel, …).

set -Eeuo pipefail

# ---- Defaults ---------------------------------------------------------------

: "${CTID:=}"                      # auto-pick if empty
# NB: HOSTNAME is a bash builtin (set to the host's hostname). Use CT_HOSTNAME.
: "${CT_HOSTNAME:=dilla}"
: "${STORAGE:=}"                   # auto-detect first active rootdir storage if empty
: "${TEMPLATE_STORE:=local}"       # template cache
: "${BRIDGE:=vmbr0}"
: "${VLAN:=}"                      # tagged VLAN id (empty = untagged)
: "${CORES:=2}"
: "${MEMORY:=1024}"                # MiB
: "${SWAP:=512}"                   # MiB
: "${DISK_GB:=8}"
: "${UNPRIVILEGED:=1}"
: "${IPV4:=dhcp}"                  # or "10.0.0.50/24,gw=10.0.0.1"
: "${IPV6:=auto}"                  # auto | dhcp | none | "fd00::5/64,gw=fd00::1"
: "${DNS:=}"                       # space-separated; empty = inherit PVE host
: "${SEARCH_DOMAIN:=}"             # empty = inherit PVE host
: "${DILLA_PORT:=8080}"
# Public hostname the server is reached at (e.g. "dilla.example.com").
# Used as the WebAuthn rp.id — must match the origin a browser sees, or
# passkey registration fails with "OriginRpMismatch". Leave empty if you
# only ever hit the LXC directly by IP for local testing.
: "${DILLA_DOMAIN:=}"
: "${RELEASE_TAG:=nightly}"
: "${RELEASE_REPO:=dilla-chat/dilla-chat}"
# Released binaries are built on ubuntu-latest (currently 24.04, glibc 2.39),
# so the container needs ≥ that glibc to load them. Ubuntu 24.04 LTS matches.
# Override with TEMPLATE_PREFIX=debian-13-standard once the release pipeline
# moves to a lower glibc floor.
: "${TEMPLATE_PREFIX:=ubuntu-24.04-standard}"

readonly TIMER_LIMIT=120

# Color palette matches community-scripts/ProxmoxVE for a familiar look.
YW=$'\033[33m'; GN=$'\033[1;92m'; RD=$'\033[01;31m'; BL=$'\033[36m'
DGN=$'\033[32m'; CL=$'\033[m'; BFR=$'\r\033[K'
CM=$' ✓\033[0m'; CROSS=$' ✗\033[0m'; HOLD=' '

SPINNER_PID=""

spinner_start() {
  local i=0 frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  while :; do
    printf "\r ${YW}%s${CL} %s" "${frames:i++%${#frames}:1}" "$1"
    sleep 0.1
  done
}

start_spinner() {
  [[ -t 1 ]] || { echo " ${HOLD}${YW}$1...${CL}"; return; }
  spinner_start "$1" &
  SPINNER_PID=$!
  disown 2>/dev/null || true
}

stop_spinner() {
  [[ -n "$SPINNER_PID" ]] || return 0
  kill "$SPINNER_PID" 2>/dev/null || true
  wait "$SPINNER_PID" 2>/dev/null || true
  SPINNER_PID=""
  printf "%s" "$BFR"
}

msg_info()  { stop_spinner; start_spinner "$1"; }
msg_ok()    { stop_spinner; echo -e "${BFR}${CM}${GN} $1${CL}"; }
msg_error() { stop_spinner; echo -e "${BFR}${CROSS}${RD} $1${CL}" >&2; }
msg_warn()  { stop_spinner; echo -e " ${YW}!${CL} $1" >&2; }
die()       { msg_error "$1"; exit 1; }

trap 'stop_spinner; die "Aborted on line $LINENO"' ERR
trap 'stop_spinner' EXIT

show_header() {
  cat <<'EOF'

    ____  _ ____
   / __ \(_) / /___ _
  / / / / / / / __ `/
 / /_/ / / / / /_/ /
/_____/_/_/_/\__,_/

EOF
  echo -e "${DGN}      Dilla LXC Installer${CL}"
  echo -e "${BL}      federated · end-to-end encrypted chat${CL}"
  echo
}

# ---- whiptail helpers -------------------------------------------------------

# Track which variables were explicitly passed via env so we don't re-prompt
# for them in advanced mode.
declare -A user_set
for v in CTID CT_HOSTNAME STORAGE BRIDGE VLAN CORES MEMORY SWAP DISK_GB \
         IPV4 IPV6 DNS SEARCH_DOMAIN DILLA_PORT DILLA_DOMAIN \
         TEMPLATE_PREFIX RELEASE_TAG; do
  [[ -n "${!v}" ]] && user_set[$v]=1
done

WT_TITLE="Dilla LXC Installer"

wt_yesno() {
  whiptail --backtitle "$WT_TITLE" --title "$1" --yesno "$2" 12 70
}

wt_input() {
  # $1 title, $2 prompt, $3 default → echoes user input, returns 1 on cancel
  local title="$1" prompt="$2" default="$3" out
  out=$(whiptail --backtitle "$WT_TITLE" --title "$title" \
                 --inputbox "$prompt" 12 70 "$default" 3>&1 1>&2 2>&3) || return 1
  echo "$out"
}

wt_menu() {
  # $1 title, $2 prompt, then alternating tag/desc pairs
  local title="$1" prompt="$2"; shift 2
  whiptail --backtitle "$WT_TITLE" --title "$title" \
           --menu "$prompt" 16 70 6 "$@" 3>&1 1>&2 2>&3
}

# ---- In-container update helper --------------------------------------------

# Body of /usr/local/bin/update inside the LXC. Single-quoted heredoc so
# nothing here is expanded by the outer (host-side) shell — the script
# sees its own literal text. Invoke from inside the CT via `pct enter`
# (or `pct exec <id> -- update`).
read -r -d '' IN_CT_UPDATE_SCRIPT <<'IN_CT_UPDATE_EOF' || true
#!/usr/bin/env bash
# Dilla in-container update helper. Atomically swaps the dilla-server
# binary for the latest release artifact, restarts the service, and
# rolls back if the new binary fails to come up.
#
# Usage (inside the LXC, as root):
#
#   update                  # pull RELEASE_TAG=nightly
#   update --tag v1.2.3     # pull a specific tag
#   RELEASE_TAG=v1.2.3 update
#
# Re-running with the same tag short-circuits via cmp(1).

set -Eeuo pipefail

: "${RELEASE_TAG:=nightly}"
: "${RELEASE_REPO:=dilla-chat/dilla-chat}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)   RELEASE_TAG="$2"; shift 2 ;;
    --repo)  RELEASE_REPO="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,16p' "$0"
      exit 0
      ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

GN=$'\033[1;92m'; RD=$'\033[01;31m'; YW=$'\033[33m'; CL=$'\033[m'
ok()   { echo -e " ${GN}✓${CL} $*"; }
warn() { echo -e " ${YW}!${CL} $*" >&2; }
die()  { echo -e " ${RD}✗${CL} $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root (try: sudo update)."

ARCH=$(dpkg --print-architecture)
case "$ARCH" in
  amd64) BIN_ASSET=dilla-server-linux-amd64 ;;
  arm64) BIN_ASSET=dilla-server-linux-arm64 ;;
  *)     die "Unsupported architecture: $ARCH" ;;
esac

ASSET_URL="https://github.com/${RELEASE_REPO}/releases/download/${RELEASE_TAG}/${BIN_ASSET}"
SUMS_URL="https://github.com/${RELEASE_REPO}/releases/download/${RELEASE_TAG}/SHA256SUMS.txt"

echo " ⤓ Downloading ${BIN_ASSET} from ${RELEASE_TAG}…"
curl --fail --location --silent --show-error \
  -o /usr/local/bin/dilla-server.new "$ASSET_URL"
chmod 0755 /usr/local/bin/dilla-server.new

# Integrity check against the SHA256SUMS.txt published alongside the
# release. Catches truncated downloads, accidental asset swaps, and any
# CDN-side corruption. Does NOT defend against a release-key compromise
# (an attacker who can replace the binary can also replace SHA256SUMS).
# That gap is tracked separately and is the next layer to add via
# cosign-signed checksums.
echo " ⤓ Verifying SHA-256 against SHA256SUMS.txt…"
sums=$(curl --fail --location --silent --show-error "$SUMS_URL") \
  || die "Could not fetch SHA256SUMS.txt — release missing checksums?"
expected=$(awk -v f="$BIN_ASSET" '$2 == f || $2 == "*"f { print $1; exit }' <<<"$sums")
[[ -n "$expected" ]] \
  || die "SHA256SUMS.txt has no entry for ${BIN_ASSET}."
actual=$(sha256sum /usr/local/bin/dilla-server.new | awk '{print $1}')
if [[ "$expected" != "$actual" ]]; then
  rm -f /usr/local/bin/dilla-server.new
  die "Checksum mismatch for ${BIN_ASSET} (expected ${expected:0:12}…, got ${actual:0:12}…). Refusing to swap."
fi

if cmp -s /usr/local/bin/dilla-server /usr/local/bin/dilla-server.new 2>/dev/null; then
  ok "Already up to date (${RELEASE_TAG})."
  rm -f /usr/local/bin/dilla-server.new
  exit 0
fi

cp /usr/local/bin/dilla-server /usr/local/bin/dilla-server.bak
mv /usr/local/bin/dilla-server.new /usr/local/bin/dilla-server
systemctl restart dilla.service

for _ in $(seq 1 120); do
  systemctl is-active --quiet dilla.service && {
    rm -f /usr/local/bin/dilla-server.bak
    ok "Updated to ${RELEASE_TAG}."
    exit 0
  }
  sleep 1
done

warn "Service didn't come back up — rolling back."
mv /usr/local/bin/dilla-server.bak /usr/local/bin/dilla-server
systemctl restart dilla.service || true
die "Update failed. Old binary restored. Check 'journalctl -u dilla -n 100'."
IN_CT_UPDATE_EOF

install_update_helper() {
  # $1 = CTID
  local ctid="$1"
  pct exec "$ctid" -- bash -c '
    cat >/usr/local/bin/update
    chmod 0755 /usr/local/bin/update
  ' <<<"$IN_CT_UPDATE_SCRIPT"
}

# ---- Detect existing Dilla containers ---------------------------------------

list_dilla_cts() {
  # Echoes "<ctid> <hostname> <status>" for every container that has
  # /usr/local/bin/dilla-server. Returns empty on no matches.
  local id status hostname
  while read -r id status _; do
    [[ "$id" =~ ^[0-9]+$ ]] || continue
    # Only running CTs respond to `pct exec`. Skip stopped ones (they can't
    # be updated without being started first, which we don't want to do
    # silently).
    [[ "$status" == "running" ]] || continue
    if pct exec "$id" -- test -x /usr/local/bin/dilla-server 2>/dev/null; then
      hostname=$(pct config "$id" 2>/dev/null | awk '/^hostname:/ {print $2}')
      echo "$id ${hostname:-unknown} $status"
    fi
  done < <(pct list 2>/dev/null | tail -n +2)
}

run_update() {
  local ctid="$1"
  msg_info "Inspecting CT ${ctid}"
  pct status "$ctid" &>/dev/null || die "CT ${ctid} doesn't exist."
  pct exec "$ctid" -- test -x /usr/local/bin/dilla-server 2>/dev/null \
    || die "/usr/local/bin/dilla-server not found in CT ${ctid} — nothing to update."
  local arch
  arch=$(pct exec "$ctid" -- dpkg --print-architecture 2>/dev/null) \
    || die "Failed to query architecture from CT ${ctid}."
  local bin_asset
  case "$arch" in
    amd64) bin_asset=dilla-server-linux-amd64 ;;
    arm64) bin_asset=dilla-server-linux-arm64 ;;
    *)     die "Unsupported container architecture: $arch" ;;
  esac
  msg_ok "CT ${ctid} architecture: ${arch}"

  local asset_url="https://github.com/${RELEASE_REPO}/releases/download/${RELEASE_TAG}/${bin_asset}"
  local sums_url="https://github.com/${RELEASE_REPO}/releases/download/${RELEASE_TAG}/SHA256SUMS.txt"

  msg_info "Installing in-container update helper"
  install_update_helper "$ctid"
  msg_ok "Installed /usr/local/bin/update inside CT ${ctid}"

  msg_info "Downloading ${bin_asset} from ${RELEASE_TAG} release"
  pct exec "$ctid" -- env LANG=C.UTF-8 LC_ALL=C.UTF-8 bash -c "
    set -Eeuo pipefail
    curl --fail --location --silent --show-error \
      -o /usr/local/bin/dilla-server.new '${asset_url}'
    chmod 0755 /usr/local/bin/dilla-server.new
  "
  msg_ok "Downloaded new binary"

  msg_info "Verifying SHA-256 against SHA256SUMS.txt"
  pct exec "$ctid" -- env LANG=C.UTF-8 LC_ALL=C.UTF-8 bash -c "
    set -Eeuo pipefail
    sums=\$(curl --fail --location --silent --show-error '${sums_url}')
    expected=\$(awk -v f='${bin_asset}' '\$2 == f || \$2 == \"*\"f { print \$1; exit }' <<<\"\$sums\")
    [[ -n \"\$expected\" ]] || { echo 'SHA256SUMS.txt has no entry for ${bin_asset}' >&2; exit 1; }
    actual=\$(sha256sum /usr/local/bin/dilla-server.new | awk '{print \$1}')
    if [[ \"\$expected\" != \"\$actual\" ]]; then
      rm -f /usr/local/bin/dilla-server.new
      echo \"Checksum mismatch (expected \${expected:0:12}…, got \${actual:0:12}…)\" >&2
      exit 1
    fi
  " || die "Checksum verification failed. Old binary untouched."
  msg_ok "Checksum verified"

  if pct exec "$ctid" -- cmp -s /usr/local/bin/dilla-server /usr/local/bin/dilla-server.new 2>/dev/null; then
    msg_ok "Already up to date — no swap needed"
    pct exec "$ctid" -- rm -f /usr/local/bin/dilla-server.new
    return 0
  fi

  msg_info "Swapping binary, restarting service"
  pct exec "$ctid" -- bash -c '
    set -Eeuo pipefail
    cp /usr/local/bin/dilla-server /usr/local/bin/dilla-server.bak
    mv /usr/local/bin/dilla-server.new /usr/local/bin/dilla-server
    systemctl restart dilla.service
  '
  msg_ok "Restarted dilla.service"

  msg_info "Verifying service is active"
  local i
  for ((i = 0; i < TIMER_LIMIT; i++)); do
    if pct exec "$ctid" -- systemctl is-active --quiet dilla.service 2>/dev/null; then
      break
    fi
    sleep 1
  done
  if ! pct exec "$ctid" -- systemctl is-active --quiet dilla.service 2>/dev/null; then
    msg_warn "Service did not come back up — rolling back binary."
    pct exec "$ctid" -- bash -c '
      mv /usr/local/bin/dilla-server.bak /usr/local/bin/dilla-server
      systemctl restart dilla.service
    ' || true
    die "Update failed. Old binary restored. Check 'pct exec ${ctid} -- journalctl -u dilla -n 100'."
  fi
  # Success — drop the backup.
  pct exec "$ctid" -- rm -f /usr/local/bin/dilla-server.bak
  msg_ok "dilla-server is active on the new binary"

  echo
  echo -e " ${GN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${CL}"
  echo -e " ${GN}  CT ${ctid} updated to ${RELEASE_TAG}${CL}"
  echo -e " ${GN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${CL}"
  echo
  echo -e "   ${YW}Logs${CL}  : pct exec ${ctid} -- journalctl -u dilla -f"
  echo -e "   ${YW}Status${CL}: pct exec ${ctid} -- systemctl status dilla --no-pager"
  echo -e "   ${YW}Next${CL}  : ${BL}pct enter ${ctid}${CL}, then just ${BL}update${CL} — same flow without the host wrapper."
  echo
}

# ---- Pre-flight -------------------------------------------------------------

show_header

[[ $EUID -eq 0 ]]            || die "Run as root on the Proxmox host."
command -v pct >/dev/null    || die "pct not found — this must run on a Proxmox VE host."
command -v pveam >/dev/null  || die "pveam not found — Proxmox VE tools missing."
command -v whiptail >/dev/null || die "whiptail not found — install with 'apt install whiptail'."

# ---- Action: install or update ---------------------------------------------

: "${ACTION:=}"   # may be pre-set: ACTION=install | update

if [[ -z "$ACTION" ]]; then
  if [[ -t 0 ]]; then
    ACTION=$(wt_menu "Action" \
      "What would you like to do?" \
      "install" "Set up Dilla in a new LXC" \
      "update"  "Update Dilla in an existing LXC" \
      "cancel"  "Abort" \
    ) || die "Cancelled."
    [[ "$ACTION" == "cancel" ]] && die "Cancelled."
  else
    ACTION="install"
  fi
fi

if [[ "$ACTION" == "update" ]]; then
  if [[ -z "$CTID" ]]; then
    if [[ ! -t 0 ]]; then
      die "ACTION=update requires CTID to be set when running non-interactively."
    fi
    mapfile -t dilla_cts < <(list_dilla_cts)
    if (( ${#dilla_cts[@]} == 0 )); then
      die "No running container with /usr/local/bin/dilla-server found."
    fi
    # Build the whiptail menu items.
    menu_args=()
    for line in "${dilla_cts[@]}"; do
      read -r id hostname _ <<<"$line"
      menu_args+=("$id" "$hostname")
    done
    CTID=$(wt_menu "Select Container" \
      "Pick the Dilla container to update:" "${menu_args[@]}") \
      || die "Cancelled."
  fi
  run_update "$CTID"
  exit 0
fi

# ---- Mode selection (install flow) -----------------------------------------

INSTALL_MODE="noninteractive"
if [[ -t 0 ]]; then
  choice=$(wt_menu "Setup Mode" \
    "Choose how to configure the new container." \
    "default"  "Use sensible defaults (only ask for the public domain)" \
    "advanced" "Walk through every option" \
    "cancel"   "Abort the installer" \
  ) || die "Cancelled."
  case "$choice" in
    default)  INSTALL_MODE="default" ;;
    advanced) INSTALL_MODE="advanced" ;;
    *)        die "Cancelled." ;;
  esac
fi

# Prompt only when interactive AND the variable wasn't pre-set via env.
prompt_for() {
  # $1 var name, $2 title, $3 prompt, $4 default
  local name="$1" title="$2" prompt="$3" default="$4"
  [[ -n "${user_set[$name]:-}" ]] && return 0
  [[ "$INSTALL_MODE" != "advanced" ]] && return 0
  local out
  out=$(wt_input "$title" "$prompt" "$default") || die "Cancelled."
  printf -v "$name" '%s' "$out"
}

# Domain is special: required in default mode too, with an explicit
# "testing" escape hatch.
prompt_for_domain() {
  [[ -n "${user_set[DILLA_DOMAIN]:-}" ]] && return 0
  [[ "$INSTALL_MODE" == "noninteractive" ]] && return 0
  local choice
  choice=$(wt_menu "Public Domain" \
    "WebAuthn (passkeys) requires the server's rp.id to match the URL\nthe browser sees. Pick how this LXC will be reached:" \
    "domain"  "I have a public domain (recommended)" \
    "testing" "Local testing only via SSH tunnel to localhost" \
  ) || die "Cancelled."
  if [[ "$choice" == "testing" ]]; then
    DILLA_DOMAIN="localhost"
    return
  fi
  while :; do
    local entered
    entered=$(wt_input "Public Domain" \
      "Hostname your reverse proxy serves Dilla on,\ne.g. chat.example.com" "") \
      || die "Cancelled."
    if [[ "$entered" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$ ]] \
       || [[ "$entered" == "localhost" ]]; then
      DILLA_DOMAIN="$entered"
      return
    fi
    whiptail --backtitle "$WT_TITLE" --title "Invalid domain" \
             --msgbox "'$entered' doesn't look like a valid hostname.\nTry again." 10 60 || true
  done
}

prompt_for CT_HOSTNAME    "Hostname"          "Container hostname"                       "$CT_HOSTNAME"
prompt_for CTID           "Container ID"      "Numeric CTID (leave blank for next free)" "$CTID"
prompt_for CORES          "CPU cores"         "Number of CPU cores"                      "$CORES"
prompt_for MEMORY         "Memory (MiB)"      "Memory limit in MiB"                      "$MEMORY"
prompt_for SWAP           "Swap (MiB)"        "Swap allowance in MiB (0 to disable)"     "$SWAP"
prompt_for DISK_GB        "Disk (GiB)"        "Root disk size in GiB"                    "$DISK_GB"
prompt_for BRIDGE         "Network bridge"    "Proxmox bridge to attach eth0 to"         "$BRIDGE"
prompt_for VLAN           "VLAN tag"          "Tagged VLAN id (leave blank for untagged)" "$VLAN"
prompt_for IPV4           "IPv4 address"      "Either 'dhcp' or 'A.B.C.D/24,gw=GW.IP'"   "$IPV4"
prompt_for IPV6           "IPv6 address"      "auto | dhcp | none | 'fd00::5/64,gw=fd00::1'" "$IPV6"
prompt_for DNS            "DNS servers"       "Space-separated (blank = inherit from PVE host)" "$DNS"
prompt_for SEARCH_DOMAIN  "Search domain"     "DNS search domain (blank = inherit)"      "$SEARCH_DOMAIN"
prompt_for DILLA_PORT     "Dilla port"        "HTTP/WS port the dilla-server listens on" "$DILLA_PORT"
prompt_for_domain

# Validate VLAN if set: must be 1..4094.
if [[ -n "$VLAN" ]]; then
  [[ "$VLAN" =~ ^[0-9]+$ ]] && (( VLAN >= 1 && VLAN <= 4094 )) \
    || die "VLAN must be an integer in 1..4094 (got '$VLAN')."
fi

# ---- Pick a CTID ------------------------------------------------------------

if [[ -z "$CTID" ]]; then
  CTID=$(pvesh get /cluster/nextid)
fi

if pct status "$CTID" &>/dev/null; then
  die "CTID $CTID is already in use."
fi

# ---- Pick a rootfs storage --------------------------------------------------

if [[ -z "$STORAGE" ]]; then
  # Auto-detect: first active storage that supports rootdir/container content.
  # Prefer well-known defaults if present.
  available=$(pvesm status -content rootdir 2>/dev/null | awk 'NR>1 && $3=="active" {print $1}')
  [[ -n "$available" ]] || die "No active storage with content type 'rootdir' found. Set STORAGE=… explicitly."
  for preferred in local-lvm local-zfs local; do
    if grep -qx "$preferred" <<<"$available"; then
      STORAGE="$preferred"
      break
    fi
  done
  [[ -n "$STORAGE" ]] || STORAGE=$(head -n1 <<<"$available")
  msg_ok "Using auto-detected rootfs storage: ${STORAGE}"
elif ! pvesm status -storage "$STORAGE" &>/dev/null; then
  die "Storage '${STORAGE}' does not exist. Available rootdir storages: $(pvesm status -content rootdir 2>/dev/null | awk 'NR>1 {print $1}' | xargs)"
fi

# ---- Confirmation summary ---------------------------------------------------

if [[ "$INSTALL_MODE" != "noninteractive" ]]; then
  domain_label="${DILLA_DOMAIN:-(none — passkeys will require a domain later)}"
  [[ "$DILLA_DOMAIN" == "localhost" ]] && domain_label="localhost (testing — SSH-tunnel only)"
  vlan_label="${VLAN:-untagged}"
  dns_label="${DNS:-(inherit PVE host)}"
  summary="\
CTID         : ${CTID}
Hostname     : ${CT_HOSTNAME}
Storage      : ${STORAGE}
Cores        : ${CORES}
RAM / Swap   : ${MEMORY} MiB / ${SWAP} MiB
Disk         : ${DISK_GB} GiB
Bridge / VLAN: ${BRIDGE} / ${vlan_label}
IPv4 / IPv6  : ${IPV4} / ${IPV6}
DNS          : ${dns_label}
Dilla port   : ${DILLA_PORT}
Domain       : ${domain_label}
Template     : ${TEMPLATE_PREFIX}*
Release tag  : ${RELEASE_TAG}"
  whiptail --backtitle "$WT_TITLE" --title "Confirm" \
           --yes-button "Install" --no-button "Abort" \
           --yesno "About to create the container with these settings:\n\n${summary}\n\nProceed?" 22 70 \
    || die "Cancelled."
fi

# ---- Locate or download the LXC template ------------------------------------

msg_info "Refreshing template index"
pveam update >/dev/null
msg_ok "Template index refreshed"

template_name=$(
  pveam available --section system \
    | awk -v prefix="$TEMPLATE_PREFIX" \
        '$1=="system" && index($2, prefix)==1 {print $2}' \
    | sort -V | tail -n1
)
[[ -n "$template_name" ]] \
  || die "No template matching '${TEMPLATE_PREFIX}' available from pveam. Override with TEMPLATE_PREFIX=…"

template_path="${TEMPLATE_STORE}:vztmpl/${template_name}"
local_path="/var/lib/vz/template/cache/${template_name}"

if [[ ! -f "$local_path" ]]; then
  msg_info "Downloading ${template_name} to ${TEMPLATE_STORE}"
  pveam download "$TEMPLATE_STORE" "$template_name" >/dev/null 2>&1
  msg_ok "Downloaded ${template_name}"
else
  msg_ok "Template ${template_name} cached"
fi

# ---- Create the container ---------------------------------------------------

msg_info "Creating LXC ${CTID} (${CT_HOSTNAME})"

db_passphrase=$(head -c 32 /dev/urandom | base64 | tr -d '+/=' | head -c 32)

# CORS allow-list derived from DILLA_DOMAIN. The dilla-server defaults
# to permissive CORS and emits a SECURITY warning at startup until this
# is set — we lock it down to the single browser origin the user will
# actually hit:
#   - domain mode  → https://<domain>            (terminated by the reverse proxy)
#   - testing mode → http://localhost:<port>     (matches the SSH tunnel hint
#                                                 printed at end-of-install)
#   - noninteractive with no domain set → leave empty (the heredoc skips it)
if [[ "$DILLA_DOMAIN" == "localhost" ]]; then
  allowed_origins="http://localhost:${DILLA_PORT}"
elif [[ -n "$DILLA_DOMAIN" ]]; then
  allowed_origins="https://${DILLA_DOMAIN}"
else
  allowed_origins=""
fi

# Compose net0 with optional VLAN tag + IPv6 spec.
net0="name=eth0,bridge=${BRIDGE},ip=${IPV4}"
[[ -n "$VLAN" ]]                        && net0+=",tag=${VLAN}"
[[ "$IPV6" != "none" && -n "$IPV6" ]]   && net0+=",ip6=${IPV6}"

# Optional DNS extras — pct only honours --nameserver / --searchdomain if set.
dns_args=()
[[ -n "$DNS" ]]            && dns_args+=(--nameserver "$DNS")
[[ -n "$SEARCH_DOMAIN" ]]  && dns_args+=(--searchdomain "$SEARCH_DOMAIN")

pct create "$CTID" "$template_path" \
  --hostname "$CT_HOSTNAME" \
  --cores "$CORES" \
  --memory "$MEMORY" \
  --swap "$SWAP" \
  --rootfs "${STORAGE}:${DISK_GB}" \
  --net0 "$net0" \
  "${dns_args[@]}" \
  --unprivileged "$UNPRIVILEGED" \
  --features "nesting=1" \
  --onboot 1 \
  --start 0 \
  >/dev/null
msg_ok "Created CT ${CTID}"

msg_info "Starting CT ${CTID} and waiting for network"
pct start "$CTID"

# Wait for network/dns inside the container.
for ((i = 0; i < TIMER_LIMIT; i++)); do
  if pct exec "$CTID" -- getent hosts github.com &>/dev/null; then
    break
  fi
  sleep 1
done
pct exec "$CTID" -- getent hosts github.com &>/dev/null \
  || die "Container has no network connectivity to github.com after ${TIMER_LIMIT}s."
msg_ok "Container is online"

# ---- Bootstrap inside the container ----------------------------------------

msg_info "Installing dependencies inside CT ${CTID}"
# pct exec inherits the host's LANG (typically en_US.UTF-8), but minimal LXC
# templates only ship C.UTF-8 — leaving inherited LANG set makes perl-based
# apt maintainer scripts emit "locale: Cannot set LC_*" warnings. Pin the
# locale we know exists.
pct exec "$CTID" -- env LANG=C.UTF-8 LC_ALL=C.UTF-8 bash -c '
  set -Eeuo pipefail
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends ca-certificates curl >/dev/null
'
msg_ok "Installed dependencies"

arch=$(pct exec "$CTID" -- dpkg --print-architecture)
case "$arch" in
  amd64) bin_asset=dilla-server-linux-amd64 ;;
  arm64) bin_asset=dilla-server-linux-arm64 ;;
  *)     die "Unsupported container architecture: $arch" ;;
esac

asset_url="https://github.com/${RELEASE_REPO}/releases/download/${RELEASE_TAG}/${bin_asset}"
sums_url="https://github.com/${RELEASE_REPO}/releases/download/${RELEASE_TAG}/SHA256SUMS.txt"

msg_info "Downloading ${bin_asset} from ${RELEASE_TAG} release"
# Download to a temp path, verify SHA-256 against the SHA256SUMS.txt
# published in the same release, then promote. Refuses to install on
# checksum mismatch. (This only catches transport-level tampering and
# corruption — a release-key compromise can swap both files. Tracked
# follow-up: cosign-signed checksums.)
pct exec "$CTID" -- bash -c "
  set -Eeuo pipefail
  curl --fail --location --silent --show-error \
    -o /usr/local/bin/dilla-server.new '${asset_url}'
  chmod 0755 /usr/local/bin/dilla-server.new
  sums=\$(curl --fail --location --silent --show-error '${sums_url}')
  expected=\$(awk -v f='${bin_asset}' '\$2 == f || \$2 == \"*\"f { print \$1; exit }' <<<\"\$sums\")
  [[ -n \"\$expected\" ]] || { echo 'SHA256SUMS.txt has no entry for ${bin_asset}' >&2; exit 1; }
  actual=\$(sha256sum /usr/local/bin/dilla-server.new | awk '{print \$1}')
  if [[ \"\$expected\" != \"\$actual\" ]]; then
    rm -f /usr/local/bin/dilla-server.new
    echo \"Checksum mismatch (expected \${expected:0:12}…, got \${actual:0:12}…)\" >&2
    exit 1
  fi
  mv /usr/local/bin/dilla-server.new /usr/local/bin/dilla-server
"
msg_ok "Installed dilla-server binary (sha-256 verified)"

msg_info "Provisioning user, data dir, and systemd unit"
pct exec "$CTID" -- bash -c "
  set -Eeuo pipefail
  if ! id dilla &>/dev/null; then
    useradd --system --home-dir /var/lib/dilla --shell /usr/sbin/nologin dilla
  fi
  install -d -o dilla -g dilla -m 0750 /var/lib/dilla /etc/dilla

  umask 077
  cat >/etc/dilla/dilla.env <<EOF
DILLA_PORT=${DILLA_PORT}
DILLA_DATA_DIR=/var/lib/dilla
DILLA_DB_PASSPHRASE=${db_passphrase}
# This LXC install runs plaintext HTTP behind an external reverse proxy
# (see header comment + post-install hint below). DILLA_INSECURE=true
# is what the dilla-server requires to allow that — without it the
# service refuses to start.
DILLA_INSECURE=true
${DILLA_DOMAIN:+DILLA_DOMAIN=${DILLA_DOMAIN}}
${allowed_origins:+DILLA_ALLOWED_ORIGINS=${allowed_origins}}
EOF
  chown root:dilla /etc/dilla/dilla.env
  chmod 0640 /etc/dilla/dilla.env

  cat >/etc/systemd/system/dilla.service <<'EOF'
[Unit]
Description=Dilla federated chat server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=dilla
Group=dilla
EnvironmentFile=/etc/dilla/dilla.env
ExecStart=/usr/local/bin/dilla-server
Restart=on-failure
RestartSec=5
ReadWritePaths=/var/lib/dilla
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now dilla.service
"
msg_ok "Provisioned systemd unit"

msg_info "Installing in-container update helper"
install_update_helper "$CTID"
msg_ok "Installed /usr/local/bin/update inside CT ${CTID}"

# ---- Wait for the service to come up ---------------------------------------

msg_info "Waiting for dilla-server to come up"
for ((i = 0; i < TIMER_LIMIT; i++)); do
  if pct exec "$CTID" -- systemctl is-active --quiet dilla.service; then
    break
  fi
  sleep 1
done
pct exec "$CTID" -- systemctl is-active --quiet dilla.service \
  || die "dilla.service failed to start. Check 'pct exec ${CTID} -- journalctl -u dilla -n 100'."
msg_ok "dilla-server is active"

container_ip=$(pct exec "$CTID" -- bash -c "hostname -I | awk '{print \$1}'" || true)

echo
echo -e " ${GN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${CL}"
echo -e " ${GN}  Dilla is up in CT ${CTID}${CL}"
echo -e " ${GN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${CL}"
echo
echo -e "   ${YW}Container ID${CL} : ${CTID}"
echo -e "   ${YW}Hostname${CL}     : ${CT_HOSTNAME}"
[[ -n "${container_ip:-}" ]] && echo -e "   ${YW}Local URL${CL}    : ${BL}http://${container_ip}:${DILLA_PORT}${CL}"
echo -e "   ${YW}Logs${CL}         : pct exec ${CTID} -- journalctl -u dilla -f"
echo -e "   ${YW}Shell${CL}        : pct enter ${CTID}"
echo -e "   ${YW}Env file${CL}     : /etc/dilla/dilla.env (inside the CT)"
echo -e "   ${YW}Update${CL}       : pct exec ${CTID} -- update   (or 'update' inside ${BL}pct enter${CL})"
echo

if [[ "$DILLA_DOMAIN" == "localhost" ]]; then
  echo -e " ${YW}Testing mode:${CL} access Dilla via SSH tunnel so the browser sees"
  echo -e "       'http://localhost' (the only origin WebAuthn allows over HTTP):"
  echo
  echo -e "         ${BL}ssh -L ${DILLA_PORT}:${container_ip:-CT_IP}:${DILLA_PORT} \\${CL}"
  echo -e "         ${BL}    user@your-pve-host${CL}"
  echo
  echo -e "       …then open ${BL}http://localhost:${DILLA_PORT}${CL} in your browser."
elif [[ -n "$DILLA_DOMAIN" ]]; then
  echo -e " ${DGN}Next:${CL} point your reverse proxy at ${BL}${container_ip:-<ct-ip>}:${DILLA_PORT}${CL}"
  echo -e "       and serve it as ${BL}https://${DILLA_DOMAIN}${CL}."
  echo -e "       ${YW}CORS${CL} is pinned to ${BL}${allowed_origins}${CL} — update"
  echo -e "       ${BL}DILLA_ALLOWED_ORIGINS${CL} in ${BL}/etc/dilla/dilla.env${CL} if you move the proxy hostname."
else
  echo -e " ${YW}No DILLA_DOMAIN set${CL} — passkey registration will fail until you"
  echo -e "       front the LXC with a reverse proxy on a domain and append"
  echo -e "       'DILLA_DOMAIN=<your-domain>' to /etc/dilla/dilla.env."
fi
echo
