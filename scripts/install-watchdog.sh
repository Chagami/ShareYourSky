#!/usr/bin/env bash
#
# Keep the kiosk up. Run once, on the exhibit machine, from the account the kiosk runs as:
#
#   sudo scripts/install-watchdog.sh                  # the watchdogs and the nightly restart
#   sudo scripts/install-watchdog.sh --weekly-reboot  # ...and a reboot every Monday at 03:30
#   sudo scripts/install-watchdog.sh --remove         # take all of it out again
#
# It sets up three things, beside what install-service.sh did (that one runs the server):
#
#   sharedsky-session-watchdog   brings the desktop session back if it disappears — after a GNOME
#                                Shell crash the screen otherwise sits on the login screen until
#                                somebody reboots. See scripts/session-watchdog.sh.
#   sharedsky-kiosk-nightly      restarts the kiosk browser at 03:00 every night, so whatever a
#                                long day leaves behind in it does not build up for weeks.
#   a drop-in for the kiosk      the browser service keeps restarting however often it fails,
#                                instead of giving up after five failures in two minutes.
#
# The third piece of the uptime work needs no installing: the page's heartbeat, and the server
# restarting the browser when it stops, come with the exhibit code (server/kiosk.js).
#
# Logs:   journalctl -u sharedsky-session-watchdog -u sharedsky-kiosk-nightly
#         journalctl -u sharedsky | grep watchdog      (the heartbeat side)

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "This needs root: sudo scripts/install-watchdog.sh" >&2
  exit 1
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_AS="${SUDO_USER:-}"
if [ -z "$RUN_AS" ] || [ "$RUN_AS" = "root" ]; then
  echo "Run this with sudo from the account the kiosk runs as, not as root itself." >&2
  exit 1
fi
HOME_DIR="$(getent passwd "$RUN_AS" | cut -d: -f6)"
KIOSK="${SKY_KIOSK_UNIT:-sharedsky-kiosk}"
DROPIN_DIR="$HOME_DIR/.config/systemd/user/$KIOSK.service.d"
SYS=/etc/systemd/system
UNITS=(sharedsky-session-watchdog.service sharedsky-kiosk-nightly.timer sharedsky-weekly-reboot.timer)

# The kiosk account's own systemd, reached from root. Only works while that account is logged in,
# which on a kiosk it always is; if not, the drop-in is picked up at its next login anyway.
user_systemctl() { systemctl --user -M "$RUN_AS@" "$@" 2>/dev/null || true; }

if [ "${1:-}" = "--remove" ]; then
  for unit in "${UNITS[@]}"; do systemctl disable --now "$unit" 2>/dev/null || true; done
  rm -f "$SYS"/sharedsky-session-watchdog.service "$SYS"/sharedsky-kiosk-nightly.{service,timer} "$SYS"/sharedsky-weekly-reboot.{service,timer}
  rm -f "$DROPIN_DIR/uptime.conf"
  rmdir "$DROPIN_DIR" 2>/dev/null || true
  systemctl daemon-reload
  user_systemctl daemon-reload
  echo "Removed the watchdogs, the nightly restart and the weekly reboot."
  exit 0
fi

chmod +x "$REPO/scripts/session-watchdog.sh"

cat > "$SYS/sharedsky-session-watchdog.service" <<EOF
[Unit]
Description=Share Your Sky: bring the kiosk's desktop session back if it disappears
Documentation=https://github.com/Chagami/IsItReal-experiment
After=display-manager.service

[Service]
Type=simple
Environment=SKY_KIOSK_USER=$RUN_AS
ExecStart=$REPO/scripts/session-watchdog.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

cat > "$SYS/sharedsky-kiosk-nightly.service" <<EOF
[Unit]
Description=Share Your Sky: restart the kiosk browser for the night

[Service]
Type=oneshot
ExecStart=/usr/bin/systemctl --user -M $RUN_AS@ restart $KIOSK
EOF

cat > "$SYS/sharedsky-kiosk-nightly.timer" <<EOF
[Unit]
Description=Share Your Sky: restart the kiosk browser at 03:00

[Timer]
OnCalendar=*-*-* 03:00:00

[Install]
WantedBy=timers.target
EOF

if [ "${1:-}" = "--weekly-reboot" ]; then
  cat > "$SYS/sharedsky-weekly-reboot.service" <<EOF
[Unit]
Description=Share Your Sky: weekly reboot

[Service]
Type=oneshot
ExecStart=/usr/bin/systemctl reboot
EOF
  cat > "$SYS/sharedsky-weekly-reboot.timer" <<EOF
[Unit]
Description=Share Your Sky: reboot every Monday at 03:30

[Timer]
OnCalendar=Mon *-*-* 03:30:00

[Install]
WantedBy=timers.target
EOF
fi

# The kiosk keeps trying. Beside the unit rather than in it, so the unit stays as it was made.
install -d -o "$RUN_AS" -g "$RUN_AS" "$DROPIN_DIR"
cat > "$DROPIN_DIR/uptime.conf" <<'EOF'
# Installed by scripts/install-watchdog.sh. A kiosk never gives up restarting its browser: the
# start limit is off, and a pause between tries keeps a browser that fails at once from spinning.
[Unit]
StartLimitIntervalSec=0

[Service]
RestartSec=10
EOF
chown "$RUN_AS:$RUN_AS" "$DROPIN_DIR/uptime.conf"

systemctl daemon-reload
systemctl enable --now sharedsky-session-watchdog.service sharedsky-kiosk-nightly.timer >/dev/null
[ -f "$SYS/sharedsky-weekly-reboot.timer" ] && systemctl enable --now sharedsky-weekly-reboot.timer >/dev/null
user_systemctl daemon-reload

echo "Installed, for $RUN_AS:"
echo "  session watchdog   $(systemctl is-active sharedsky-session-watchdog.service)"
echo "  nightly restart    $(systemctl is-enabled sharedsky-kiosk-nightly.timer), next: $(systemctl show sharedsky-kiosk-nightly.timer -p NextElapseUSecRealtime --value)"
if [ -f "$SYS/sharedsky-weekly-reboot.timer" ]; then
  echo "  weekly reboot      $(systemctl is-enabled sharedsky-weekly-reboot.timer)"
fi
echo "  kiosk restarts     never give up (drop-in at $DROPIN_DIR/uptime.conf)"
echo
echo "Logs:  journalctl -u sharedsky-session-watchdog -u sharedsky-kiosk-nightly"
echo "       journalctl -u sharedsky | grep watchdog"
