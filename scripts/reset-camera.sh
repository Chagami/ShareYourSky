#!/usr/bin/env bash
#
# Unplug the exhibit camera and plug it back in, without touching it.
#
# The Arducam sometimes jams after its resolution is changed: it stays connected, a browser can
# open it, and it sends nothing — or black — until it is physically unplugged. Turning its USB
# port's authorization off and on is the same thing in software: the kernel drops the device and
# finds it again, and the camera starts from cold.
#
# Needs root. install-service.sh copies this to /usr/local/sbin/sharedsky-reset-camera, owned by
# root, and lets the exhibit account run that copy — and only that — without a password, which is
# how the debug menu's "Reset camera" and the page's automatic reset reach it. The copy, not this
# file: the exhibit account can edit its own checkout, and must not be able to edit what it may
# run as root.
#
#   sudo /usr/local/sbin/sharedsky-reset-camera            the Arducam B0589 (04b4:0822)
#   SKY_CAMERA_USB=vvvv:pppp ... sharedsky-reset-camera    another camera, by USB vendor:product

set -euo pipefail
WANT="${SKY_CAMERA_USB:-04b4:0822}"

if [ "$(id -u)" -ne 0 ]; then
  echo "needs root" >&2
  exit 1
fi
case "$WANT" in
  [0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]) ;;
  *) echo "SKY_CAMERA_USB must be vendor:product, four hex digits each" >&2; exit 1 ;;
esac

found=0
for dev in /sys/bus/usb/devices/*; do
  [ -f "$dev/idVendor" ] && [ -f "$dev/authorized" ] || continue
  [ "$(cat "$dev/idVendor"):$(cat "$dev/idProduct")" = "${WANT,,}" ] || continue
  found=1
  name="$(cat "$dev/product" 2>/dev/null || echo camera)"
  echo "resetting $name at USB $(basename "$dev")"
  echo 0 > "$dev/authorized"
  sleep 2
  echo 1 > "$dev/authorized"
done

if [ "$found" -eq 0 ]; then
  echo "no USB device $WANT is connected" >&2
  exit 2
fi
# A moment for the camera to come back and the driver to find it.
sleep 3
echo "done"
