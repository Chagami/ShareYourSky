#!/usr/bin/env bash
#
# Make the exhibit start at boot, and let update.sh restart it over ssh without a password.
#
# Run once, on the exhibit machine:
#
#   sudo scripts/install-service.sh
#
# ...and to undo the whole thing:
#
#   sudo scripts/install-service.sh --remove

set -euo pipefail

SERVICE="${SKY_SERVICE:-sharedsky}"
UNIT="/etc/systemd/system/$SERVICE.service"
SUDOERS="/etc/sudoers.d/$SERVICE"

if [ "$(id -u)" -ne 0 ]; then
  echo "This needs root: sudo scripts/install-service.sh" >&2
  exit 1
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The account the exhibit should run as: whoever invoked sudo, not root. It owns the checkout,
# it is the one ssh logs in as, and running the server as root to serve static files is a
# habit worth not forming.
RUN_AS="${SUDO_USER:-root}"
if [ "$RUN_AS" = "root" ]; then
  echo "Warning: no SUDO_USER, so the service will run as root." >&2
  echo "Run this with sudo from the account that owns $REPO instead." >&2
fi

if [ "${1:-}" = "--remove" ]; then
  systemctl disable --now "$SERVICE" 2>/dev/null || true
  rm -f "$UNIT" "$SUDOERS"
  systemctl daemon-reload
  echo "Removed $SERVICE. It will not start at boot."
  exit 0
fi

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "node is not on PATH. Install it system-wide first." >&2
  exit 1
fi
case "$NODE" in
  */.nvm/*)
    echo "Warning: node is $NODE, which is nvm's." >&2
    echo "systemd does not run your shell profile, and exhibit.sh calls plain 'node'." >&2
    echo "Install node system-wide (apt, or NodeSource) before relying on this at boot." >&2
    ;;
esac

chmod +x "$REPO/scripts/exhibit.sh" "$REPO/scripts/update.sh" "$REPO/scripts/install-service.sh"

cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=Share Your Sky exhibit
Documentation=https://github.com/Chagami/IsItReal-experiment
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_AS
WorkingDirectory=$REPO
ExecStart=$REPO/scripts/exhibit.sh

# Always, not on-failure. A server that exits cleanly is still a dark exhibit.
Restart=always
RestartSec=5

# Lets a non-root user bind port 80, so the address can be http://sharedsky with nothing
# after it. Without this, ports below 1024 are refused and the URL needs :4173 on the end.
AmbientCapabilities=CAP_NET_BIND_SERVICE

StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT_EOF

# So update.sh can restart the service over ssh without a password prompt it cannot answer.
# Scoped to this one unit and these verbs: it is not general sudo.
SYSTEMCTL="$(command -v systemctl)"
TMP_SUDO="$(mktemp)"
cat > "$TMP_SUDO" <<SUDO_EOF
# Installed by $REPO/scripts/install-service.sh
$RUN_AS ALL=(root) NOPASSWD: $SYSTEMCTL restart $SERVICE, $SYSTEMCTL start $SERVICE, $SYSTEMCTL stop $SERVICE, $SYSTEMCTL status $SERVICE
SUDO_EOF

# A malformed file in sudoers.d breaks sudo for everyone, so it is checked before it is put
# anywhere sudo will read it.
if visudo -cf "$TMP_SUDO" >/dev/null; then
  install -m 0440 "$TMP_SUDO" "$SUDOERS"
  rm -f "$TMP_SUDO"
else
  rm -f "$TMP_SUDO"
  echo "Generated sudoers rule failed validation — skipping it." >&2
  echo "update.sh will still work, but will ask for a password on restart." >&2
fi

if [ ! -f "$REPO/scripts/exhibit.env" ]; then
  install -o "$RUN_AS" -m 0644 "$REPO/scripts/exhibit.env.example" "$REPO/scripts/exhibit.env"
  echo
  echo "Created scripts/exhibit.env from the example. Edit it to set the port."
fi

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"

echo
echo "Installed $SERVICE"
echo "  runs       : $REPO/scripts/exhibit.sh"
echo "  as         : $RUN_AS"
echo "  at boot    : yes, and restarted if it stops"
echo
sleep 3
systemctl --no-pager --lines=0 status "$SERVICE" || true
echo
echo "Logs:    journalctl -u $SERVICE -f"
echo "Update:  $REPO/scripts/update.sh"
