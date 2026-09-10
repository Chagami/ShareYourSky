#!/usr/bin/env bash
#
# The exhibit server.
#
# systemd runs this at boot (see install-service.sh). It is also safe to run by hand for a
# test — Ctrl-C stops it and nothing is left behind.
#
# It serves the built site in dist/, which is committed, so a fresh clone needs no build step.
# Anything edited under js/ or css/ needs `npm run build` or the exhibit goes on serving the
# version that was committed.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

# Port, and http or https, differ per machine, and a certificate path is local to the box it
# is on. So they live in a file that is not in git and a `git pull` cannot overwrite.
# Without one the defaults are port 4173 and a self-signed certificate: fine for a bench
# test, not for the floor.
if [ -f scripts/exhibit.env ]; then
  # set -a exports everything the file sets, so it reaches node rather than staying in this
  # shell. Which also means the file is plain KEY=value, and systemd could read it directly.
  set -a
  # shellcheck disable=SC1091
  . scripts/exhibit.env
  set +a
fi

# The journal is a file, not a terminal. Without this Vite writes colour escapes into it and
# `journalctl` is a wall of brackets.
export NO_COLOR=1
export FORCE_COLOR=0

if [ ! -d node_modules/vite ]; then
  echo "node_modules is missing or incomplete — run 'npm ci' in $REPO first." >&2
  exit 1
fi

echo "Share Your Sky — serving $REPO on port ${SKY_PORT:-4173}"

# exec, so this script's process *becomes* the server. Without it systemd tracks the wrapper,
# and stop/restart signals go to a shell that is not listening on anything.
exec node node_modules/vite/bin/vite.js preview
