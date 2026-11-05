#!/usr/bin/env bash
# =============================================================================
# N-Signage — install / update / remove the cloud agent on a Raspberry Pi
#
# The cloud agent lets the hosted website (https://software.nsinages.in) find
# this Pi with "Find Pi" and manage it from anywhere. It only makes OUTGOING
# HTTPS requests; it opens no ports and changes nothing else on the Pi
# (player, uploads, Wi-Fi hotspot, captive portal and UDP discovery are untouched).
#
# Run from the N-Signage project folder (e.g. /home/<user>/n-signage):
#   sudo ./install-cloud-agent.sh              install or update
#   sudo ./install-cloud-agent.sh --status     show agent status
#   sudo ./install-cloud-agent.sh --uninstall  stop and remove the agent (rollback)
#
# The Linux user and folder are detected automatically; nothing is hard-coded.
# =============================================================================
set -euo pipefail

UNIT=n-signage-cloud.service
UNIT_PATH=/etc/systemd/system/$UNIT
ENV_FILE=/etc/n-signage.env
CLOUD_URL_DEFAULT=https://software.nsinages.in

die() { echo "ERROR: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run with sudo:  sudo $0 ${1:-}"

case "${1:-}" in
  --uninstall)
    systemctl disable --now "$UNIT" 2>/dev/null || true
    rm -f "$UNIT_PATH"
    systemctl daemon-reload
    echo "Cloud agent removed. Local playback, uploads and discovery are unaffected."
    exit 0 ;;
  --status)
    systemctl --no-pager status "$UNIT" || true
    journalctl -u "$UNIT" -n 20 --no-pager || true
    exit 0 ;;
  ""|--install) ;;
  *) die "unknown option $1 (use --uninstall or --status)" ;;
esac

# The Pi's normal (non-root) user: the one that ran sudo, else the owner of this folder
PIDIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
PIUSER="${SUDO_USER:-}"
if [ -z "$PIUSER" ] || [ "$PIUSER" = root ]; then
  PIUSER="$(stat -c %U "$PIDIR")"
fi
[ "$PIUSER" != root ] || die "could not detect the Pi user; run as that user with sudo"
id "$PIUSER" >/dev/null 2>&1 || die "user $PIUSER does not exist"

[ -f "$PIDIR/app/cloud_agent.py" ] || die "$PIDIR/app/cloud_agent.py not found — run this script from the N-Signage folder"
[ -f "$PIDIR/app/device_identity.py" ] || die "$PIDIR/app/device_identity.py not found — update the N-Signage files first"
PYTHON="$(command -v python3)" || die "python3 is not installed"
"$PYTHON" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 7) else 1)' || die "python 3.7+ required"

# Keep the existing service user consistent with the player service, if present
if systemctl cat n-signage.service >/dev/null 2>&1; then
  SVC_USER="$(systemctl show -p User --value n-signage.service || true)"
  if [ -n "$SVC_USER" ] && [ "$SVC_USER" != "$PIUSER" ]; then
    echo "NOTE: n-signage.service runs as '$SVC_USER'; using that user for the cloud agent too."
    PIUSER="$SVC_USER"
  fi
fi

install -d -o "$PIUSER" -g "$(id -gn "$PIUSER")" -m 755 "$PIDIR/data"

CLOUD_URL="$CLOUD_URL_DEFAULT"
if [ -f "$ENV_FILE" ] && grep -q '^NSIGNAGE_CLOUD_URL=' "$ENV_FILE"; then
  CLOUD_URL="$(grep '^NSIGNAGE_CLOUD_URL=' "$ENV_FILE" | tail -1 | cut -d= -f2-)"
fi

# Back up an existing unit so it can be restored by hand
[ -f "$UNIT_PATH" ] && cp "$UNIT_PATH" "$UNIT_PATH.bak.$(date +%Y%m%d%H%M%S)"

cat > "$UNIT_PATH" <<EOF
[Unit]
Description=N Signage Cloud Agent (connects this Pi to the hosted website)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$PIUSER
WorkingDirectory=$PIDIR
ExecStart=$PYTHON $PIDIR/app/cloud_agent.py
Restart=always
RestartSec=10
Environment=PYTHONUNBUFFERED=1
EnvironmentFile=-$ENV_FILE
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$UNIT" >/dev/null
systemctl restart "$UNIT"

echo "Installed $UNIT  (user: $PIUSER, folder: $PIDIR, cloud: $CLOUD_URL)"
if command -v curl >/dev/null 2>&1; then
  if curl -fsS -m 10 "$CLOUD_URL/api/health" >/dev/null 2>&1; then
    echo "Cloud service reachable: $CLOUD_URL"
  else
    echo "WARNING: $CLOUD_URL/api/health is not answering OK yet. The agent keeps retrying;"
    echo "         check the Pi's internet access and the website's cloud storage setup."
  fi
fi
sleep 6
journalctl -u "$UNIT" -n 5 --no-pager || true
echo
echo "Expect: 'Connected to the cloud'. Then open $CLOUD_URL on a phone or PC on the SAME Wi-Fi → Devices → Add Device."
