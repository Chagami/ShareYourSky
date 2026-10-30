#!/usr/bin/env bash
#
# Bring the kiosk back when its desktop session is gone.
#
# What took the exhibit down in October was not the server or the browser but the desktop: GNOME
# Shell crashed (signal 6, on Oct 25 and Oct 28), and on X11 a shell crash ends the whole session.
# The kiosk browser went with it, the screen fell back to the login screen, and automatic login
# only happens once, when the login manager starts, so it stayed there until somebody rebooted.
#
# This watches for that. When the exhibit account has had no graphical session for a minute, it
# restarts the login manager, which logs in automatically again and the kiosk starts with the
# session. If that does not bring a session back within five minutes, it reboots — at most three
# times in two hours, so a fault that a reboot cannot fix does not become a machine that never
# stays up long enough to be looked at.
#
# Run as root, by the sharedsky-session-watchdog service that scripts/install-watchdog.sh sets up.
# Everything it does goes to the journal:  journalctl -u sharedsky-session-watchdog
#
# Settings, all optional, in seconds (the installer passes SKY_KIOSK_USER):
#   SKY_KIOSK_USER            the account that logs in automatically
#   SKY_SESSION_GRACE         no session this long before acting                    (60)
#   SKY_SESSION_CHECK         how often to look                                     (15)
#   SKY_SESSION_BOOT_GRACE    no judging until the machine has been up this long   (180)
#   SKY_SESSION_REBOOT_AFTER  still none this long after the login manager restart, reboot (300; 0 = never)
#   SKY_SESSION_MAX_REBOOTS   reboots allowed in two hours                          (3)

USER_NAME="${SKY_KIOSK_USER:?set SKY_KIOSK_USER to the account that logs in automatically}"
GRACE="${SKY_SESSION_GRACE:-60}"
CHECK="${SKY_SESSION_CHECK:-15}"
BOOT_GRACE="${SKY_SESSION_BOOT_GRACE:-180}"
REBOOT_AFTER="${SKY_SESSION_REBOOT_AFTER:-300}"
MAX_REBOOTS="${SKY_SESSION_MAX_REBOOTS:-3}"
STATE_DIR="${SKY_SESSION_STATE_DIR:-/var/lib/sharedsky-watchdog}"

say() { echo "$*"; }
now() { date +%s; }

# Whether the account has a graphical session that is still alive. loginctl names the one that
# owns the display; a session that is closing or gone does not count.
has_session() {
  local id state type
  id="$(loginctl show-user "$USER_NAME" -p Display --value 2>/dev/null)"
  [ -n "$id" ] || return 1
  state="$(loginctl show-session "$id" -p State --value 2>/dev/null)"
  type="$(loginctl show-session "$id" -p Type --value 2>/dev/null)"
  [[ "$state" == active || "$state" == online ]] && [[ "$type" == x11 || "$type" == wayland ]]
}

# Reboots in the last two hours, from a file that survives them.
recent_reboots() {
  local cutoff
  cutoff=$(( $(now) - 7200 ))
  [ -f "$STATE_DIR/reboots" ] || { echo 0; return; }
  awk -v c="$cutoff" '$1 >= c' "$STATE_DIR/reboots" | wc -l
}

# Wait out the start of the day: automatic login takes a little while after boot, and a session
# that has not arrived yet is not one that has been lost.
up="$(cut -d. -f1 /proc/uptime 2>/dev/null || echo "$BOOT_GRACE")"
if [ "$up" -lt "$BOOT_GRACE" ]; then
  say "watching for $USER_NAME's desktop session, from ${BOOT_GRACE}s after boot"
  sleep $(( BOOT_GRACE - up ))
else
  say "watching for $USER_NAME's desktop session"
fi

missing_since=""
restarted_at=""
while true; do
  if has_session; then
    [ -n "$missing_since" ] && say "desktop session is back after $(( $(now) - missing_since ))s"
    missing_since=""
    restarted_at=""
  else
    t="$(now)"
    missing_since="${missing_since:-$t}"
    gone=$(( t - missing_since ))
    if [ -z "$restarted_at" ] && [ "$gone" -ge "$GRACE" ]; then
      say "no desktop session for $USER_NAME for ${gone}s — restarting the login manager so it logs in again"
      systemctl restart display-manager.service || say "could not restart the login manager"
      restarted_at="$t"
    elif [ -n "$restarted_at" ] && [ "$REBOOT_AFTER" -gt 0 ] && [ $(( t - restarted_at )) -ge "$REBOOT_AFTER" ]; then
      n="$(recent_reboots)"
      if [ "$n" -ge "$MAX_REBOOTS" ]; then
        say "still no desktop session, but this watchdog has rebooted $n times in two hours — leaving it for a person"
        restarted_at="$t" # ask again after another REBOOT_AFTER, by which time an old reboot may have aged out
      else
        say "still no desktop session ${REBOOT_AFTER}s after restarting the login manager — rebooting"
        mkdir -p "$STATE_DIR" && echo "$t" >> "$STATE_DIR/reboots"
        systemctl reboot
      fi
    fi
  fi
  sleep "$CHECK"
done
