#!/usr/bin/env bash
# =============================================================================
# N-Signage — install / remove the direct upload receiver + its Cloudflare Tunnel
#
# Adds TWO services and changes nothing else:
#   n-signage-upload.service   receiver.py as user ns, 127.0.0.1:8090 only
#   n-signage-tunnel.service   cloudflared as a DynamicUser, forwards the Pi's hostname to 127.0.0.1:8090
# Never touches: n-signage-api, -cloud (V2.1 agent), -discovery, -player, -portal-redirect, -v3,
# the agent's files, device identity, or the ownership/permissions of media/ and data/.
# New paths only: /home/ns/n-signage/upload/, /home/ns/n-signage/data/upload/,
#                 /etc/n-signage-upload.env, /etc/n-signage-tunnel.env, two unit files.
#
#   sudo ./install-upload-receiver.sh --hostname p-<16 hex>.nsinages.in < tunnel-token.txt
#   sudo ./install-upload-receiver.sh --dry-run --hostname ...   show what would happen
#   sudo ./install-upload-receiver.sh --status
#   sudo ./install-upload-receiver.sh --uninstall [--purge]       rollback (--purge also deletes the receiver key)
# The tunnel token is read from STDIN (never from the command line, so it is not in shell history).
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
PI_USER=ns
BASE=/home/ns/n-signage
APP_DIR=$BASE/upload
STATE_DIR=$BASE/data/upload
UPLOAD_ENV=/etc/n-signage-upload.env
TUNNEL_ENV=/etc/n-signage-tunnel.env
UNITS=(n-signage-upload.service n-signage-tunnel.service)
EXISTING=(n-signage-api n-signage-cloud n-signage-discovery n-signage-player n-signage-portal-redirect n-signage-v3)
CLOUD_URL=https://software.nsinages.in
HOSTNAME_ARG=""; MODE=install; DRY=0; PURGE=0

die() { echo "ERROR: $*" >&2; exit 1; }
run() { if [ "$DRY" = 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }

while [ $# -gt 0 ]; do
  case "$1" in
    --hostname) HOSTNAME_ARG="${2:-}"; shift 2 ;;
    --cloud-url) CLOUD_URL="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --status) MODE=status; shift ;;
    --uninstall) MODE=uninstall; shift ;;
    --purge) PURGE=1; shift ;;
    *) die "unknown option $1" ;;
  esac
done
[ "$(id -u)" -eq 0 ] || die "run with sudo"

existing_states() { for s in "${EXISTING[@]}"; do printf '  %-28s %s\n' "$s" "$(systemctl is-active "$s" 2>/dev/null || true)"; done; }

if [ "$MODE" = status ]; then
  for u in "${UNITS[@]}"; do systemctl --no-pager --lines=5 status "$u" || true; done
  # The same chain the website checks, step by step (each line names what is broken)
  check() { if eval "$2" >/dev/null 2>&1; then echo "  OK    $1"; else echo "  FAIL  $1"; fi; }
  PUB_HOST="$(sed -n 's/^NSIGNAGE_UPLOAD_HOSTNAME=//p' "$UPLOAD_ENV" 2>/dev/null || true)"
  echo "Upload path:"
  check "receiver installed ($UPLOAD_ENV, unit file)" "[ -f '$UPLOAD_ENV' ] && [ -f /etc/systemd/system/n-signage-upload.service ]"
  check "receiver running (127.0.0.1:8090/v1/health)" "curl -fsS -m 5 http://127.0.0.1:8090/v1/health"
  check "website accepts its heartbeat (no 'Heartbeat failed' in the last 2 min)" \
        "! journalctl -u n-signage-upload --since '-2 min' --no-pager | grep -q 'Heartbeat failed'"
  check "tunnel configured ($TUNNEL_ENV)" "[ -s '$TUNNEL_ENV' ]"
  check "tunnel connected to Cloudflare (Registered tunnel connection)" \
        "journalctl -u n-signage-tunnel --no-pager -n 200 | grep -q 'Registered tunnel connection'"
  if [ -n "$PUB_HOST" ]; then
    check "public address answers through Cloudflare (https://$PUB_HOST/v1/health)" "curl -fsS -m 10 https://$PUB_HOST/v1/health"
  fi
  journalctl -u n-signage-upload --no-pager -n 3 | sed 's/^/    /'
  echo "Existing services:"; existing_states
  exit 0
fi

if [ "$MODE" = uninstall ]; then
  for u in "${UNITS[@]}"; do run systemctl disable --now "$u" 2>/dev/null || true; run rm -f "/etc/systemd/system/$u"; done
  run systemctl daemon-reload
  run rm -f "$UPLOAD_ENV" "$TUNNEL_ENV"
  run rm -rf "$APP_DIR"
  find "$BASE/media" -maxdepth 1 -name '.upload-*.part' -print -exec rm -f {} + 2>/dev/null || true
  if [ "$PURGE" = 1 ]; then run rm -rf "$STATE_DIR"; else echo "Kept $STATE_DIR (receiver key); use --purge to delete it."; fi
  echo "Removed. Existing services (unchanged):"; existing_states
  exit 0
fi

# ---- install ----------------------------------------------------------------
[[ "$HOSTNAME_ARG" =~ ^p-[0-9a-f]{16}\.nsinages\.in$ ]] || die "--hostname must look like p-<16 hex>.nsinages.in"
id "$PI_USER" >/dev/null 2>&1 || die "user $PI_USER does not exist"
for p in "$BASE/media" "$BASE/data" "$BASE/data/device_identity.json" "$BASE/data/cloud_secret"; do
  [ -e "$p" ] || die "$p not found (is the N-Signage cloud agent installed?)"
done
[ "$(stat -c %U "$BASE/media")" = "$PI_USER" ] || die "$BASE/media is not owned by $PI_USER; refusing to change permissions"
sudo -u "$PI_USER" python3 -c 'import cryptography, sys; sys.exit(0 if int(cryptography.__version__.split(".")[0]) >= 3 else 1)' \
  || die "python3-cryptography missing (apt install python3-cryptography)"
sudo -u "$PI_USER" test -r "$BASE/data/cloud_secret" || die "$PI_USER cannot read data/cloud_secret"

TOKEN=""
if [ "$DRY" = 0 ]; then
  IFS= read -r TOKEN || true
  [[ "$TOKEN" =~ ^[A-Za-z0-9_=-]{100,}$ ]] || die "pipe the tunnel token on stdin (from scripts/provision-tunnel.mjs)"
fi

echo "Existing services before install:"; existing_states

if ! command -v cloudflared >/dev/null 2>&1; then
  # Cloudflare's signed package repository. No Debian 13 suite is published; the bookworm build is a
  # static Go binary (verify `cloudflared --version` after install during the pilot).
  run install -d -m 0755 /usr/share/keyrings
  run sh -c 'curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg'
  run sh -c 'echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared bookworm main" > /etc/apt/sources.list.d/cloudflared.list'
  run apt-get update
  run apt-get install -y cloudflared
fi
run cloudflared --version

run install -d -o "$PI_USER" -g "$PI_USER" -m 0750 "$APP_DIR"
run install -d -o "$PI_USER" -g "$PI_USER" -m 0700 "$STATE_DIR"
run install -o "$PI_USER" -g "$PI_USER" -m 0644 "$HERE/receiver.py" "$APP_DIR/receiver.py"
run sudo -u "$PI_USER" python3 -m py_compile "$APP_DIR/receiver.py"

if [ "$DRY" = 1 ]; then
  echo "[dry-run] write $UPLOAD_ENV (root:$PI_USER 0640) and $TUNNEL_ENV (root:root 0600)"
else
  umask 077
  printf 'NSIGNAGE_UPLOAD_HOSTNAME=%s\nNSIGNAGE_CLOUD_URL=%s\nNSIGNAGE_UPLOAD_ORIGIN=%s\nNSIGNAGE_UPLOAD_PORT=8090\n' \
    "$HOSTNAME_ARG" "$CLOUD_URL" "$CLOUD_URL" > "$UPLOAD_ENV"
  chown root:"$PI_USER" "$UPLOAD_ENV"; chmod 0640 "$UPLOAD_ENV"
  printf 'TUNNEL_TOKEN=%s\n' "$TOKEN" > "$TUNNEL_ENV"
  chown root:root "$TUNNEL_ENV"; chmod 0600 "$TUNNEL_ENV"
  unset TOKEN
fi

for u in "${UNITS[@]}"; do run install -o root -g root -m 0644 "$HERE/$u" "/etc/systemd/system/$u"; done
run systemctl daemon-reload
run systemctl enable --now n-signage-upload.service
[ "$DRY" = 1 ] || sleep 3
run curl -fsS -m 5 http://127.0.0.1:8090/v1/health
run systemctl enable --now n-signage-tunnel.service

echo "Existing services after install (must be unchanged):"; existing_states
echo "Check: journalctl -u n-signage-upload -n 20 --no-pager   (key fingerprint, heartbeat)"
echo "       journalctl -u n-signage-tunnel -n 20 --no-pager   (Registered tunnel connection)"
echo "       curl https://$HOSTNAME_ARG/v1/health"
