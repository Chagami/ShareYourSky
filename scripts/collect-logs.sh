#!/usr/bin/env bash
#
# Everything worth reading after the exhibit went down, in one report. Read-only: it changes
# nothing on the machine, and needs no sudo — the first account on Ubuntu is in the `adm` group,
# which can read the system journal.
#
# Run from the dev machine, so the report lands there rather than on the exhibit:
#
#   ssh exhibit@sharedsky 'bash -s' < scripts/collect-logs.sh > sharedsky-logs.txt
#
# or on the exhibit machine itself:
#
#   scripts/collect-logs.sh > ~/sharedsky-logs.txt
#
# The last few days by default; a different window as the first argument, in journalctl's terms:
#
#   ssh exhibit@sharedsky 'bash -s -- "2 weeks ago"' < scripts/collect-logs.sh > sharedsky-logs.txt

SINCE="${1:-4 days ago}"
SERVICE="${SKY_SERVICE:-sharedsky}"
KIOSK="${SKY_KIOSK_UNIT:-sharedsky-kiosk}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

section() { printf '\n\n==================== %s ====================\n' "$*"; }
run() { printf '\n$ %s\n' "$*"; "$@" 2>&1; }

section "machine"
run date
run hostname
run uptime
run uname -a
run cat /etc/os-release
run id

section "boots: when it restarted, and whether it shut down cleanly"
# A boot with no clean shutdown before it is a crash, a freeze someone power-cycled, or a power cut.
run journalctl --list-boots --no-pager
run last -x -n 30 reboot shutdown

section "the end of the previous boot — what happened just before the last restart"
run journalctl -b -1 -n 80 --no-pager

section "the exhibit server ($SERVICE)"
run systemctl status "$SERVICE" --no-pager -n 0
run systemctl show "$SERVICE" -p NRestarts -p ActiveEnterTimestamp -p ExecMainStartTimestamp -p Result -p ExecMainStatus
printf '\n-- starts, stops, failures and errors since %s --\n' "$SINCE"
journalctl -u "$SERVICE" --since "$SINCE" --no-pager 2>&1 \
  | grep -iE 'start|stop|fail|error|exception|killed|signal|exit|restart|ENOMEM|EADDRINUSE|heap|\[kiosk\]' \
  | tail -n 150
printf '\n-- its last 60 lines --\n'
journalctl -u "$SERVICE" -n 60 --no-pager 2>&1

section "the kiosk browser ($KIOSK, a user service)"
run systemctl --user status "$KIOSK" --no-pager -n 0
run systemctl --user show "$KIOSK" -p NRestarts -p ActiveEnterTimestamp -p Result -p ExecMainStatus
printf '\n-- since %s --\n' "$SINCE"
journalctl --user -u "$KIOSK" --since "$SINCE" --no-pager 2>&1 | tail -n 120

section "the watchdogs (scripts/install-watchdog.sh): what they saw and did"
journalctl -u sharedsky-session-watchdog -u sharedsky-kiosk-nightly -u sharedsky-weekly-reboot --since "$SINCE" --no-pager 2>&1 | tail -n 60
printf '\n-- the heartbeat watchdog, in the server log --\n'
journalctl -u "$SERVICE" --since "$SINCE" --no-pager 2>&1 | grep -F '[kiosk] watchdog' | tail -n 40

section "the desktop session: shell crashes, and sessions that ended"
journalctl --since "$SINCE" --no-pager 2>&1 | grep -iE 'GNOME Shell crashed|gnome-session.*(fail|crash)|Fatal server error' | tail -n 20
journalctl --since "$SINCE" --no-pager 2>&1 | grep -E "systemd-logind.*(Removed session|logged out|New session 'c)" | tail -n 30

section "Firefox's own crash reports"
for dir in "$HOME/snap/firefox/common/.mozilla/firefox/Crash Reports" "$HOME/.mozilla/firefox/Crash Reports"; do
  [ -d "$dir" ] || continue
  printf '\n%s\n' "$dir"
  ls -la --time-style=long-iso "$dir/submitted" "$dir/pending" 2>/dev/null | tail -n 25
done

section "out of memory: anything the kernel killed to free memory"
journalctl -k --since "$SINCE" --no-pager 2>&1 | grep -iE 'out of memory|oom-kill|oom_reaper|killed process' | tail -n 40
journalctl --since "$SINCE" --no-pager 2>&1 | grep -iE 'systemd-oomd|earlyoom' | tail -n 20

section "graphics: driver hangs and resets"
journalctl -k --since "$SINCE" --no-pager 2>&1 | grep -iE 'gpu hang|hangcheck|ring timeout|i915.*(error|reset)|amdgpu.*(error|timeout|reset)|nouveau.*(error|fault)|drm.*(error|timeout)|flip_done timed out' | tail -n 40

section "camera and USB: disconnects and resets"
journalctl -k --since "$SINCE" --no-pager 2>&1 | grep -iE 'usb.*disconnect|uvcvideo|usb.*reset|over-current|xhci.*(error|died)' | tail -n 40

section "kernel warnings and errors"
journalctl -k -p warning --since "$SINCE" --no-pager 2>&1 | tail -n 60

section "snap updates (a Firefox snap refresh closes Firefox)"
run snap list firefox
run snap refresh --time
run snap changes
journalctl --since "$SINCE" --no-pager 2>&1 | grep -iE 'snapd.*(refresh|auto-refresh)|firefox.*(inhibit|refresh)' | tail -n 30

section "resources now"
run free -h
run df -h / "$HOME"
run swapon --show
printf '\n-- the biggest memory users --\n'
ps -eo pid,rss,etime,comm --sort=-rss | head -n 15
command -v sensors >/dev/null && run sensors

section "the kiosk setup as it is on this machine"
run systemctl --user cat "$KIOSK"
run systemctl cat "$SERVICE"
# Piped over ssh the script has no folder of its own, so the usual install place is the fallback.
ENV_FILE="$(dirname "$(readlink -f "${BASH_SOURCE[0]:-/dev/null}")")/exhibit.env"
[ -f "$ENV_FILE" ] || ENV_FILE="$HOME/IsItReal-experiment/scripts/exhibit.env"
run cat "$ENV_FILE"
run gsettings get org.gnome.desktop.session idle-delay
run gsettings get org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type
run cat /etc/gdm3/custom.conf

printf '\n\n(end of report)\n'
