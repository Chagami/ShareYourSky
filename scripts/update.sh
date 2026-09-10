#!/usr/bin/env bash
#
# Pull the latest exhibit from GitHub and restart it.
#
# Meant to be run over ssh from the dev machine, so it prints what it did and fails loudly
# rather than half-succeeding in silence:
#
#   ssh exhibit@sharedsky '~/IsItReal-experiment/scripts/update.sh'
#
# Nothing here needs a password if install-service.sh was used: it leaves a sudoers rule
# allowing exactly `systemctl restart sharedsky` and nothing else.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

SERVICE="${SKY_SERVICE:-sharedsky}"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "Fetching"
git fetch --prune origin

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
BEFORE="$(git rev-parse HEAD)"
AFTER="$(git rev-parse "origin/$BRANCH")"

if [ "$BEFORE" = "$AFTER" ]; then
  echo "  already current: $(git --no-pager log --oneline -1)"
else
  # Uncommitted work on an exhibit machine is nearly always accidental — but throwing it away
  # without asking is worse than stopping, because it might be the fix someone made at the
  # wall on a Saturday. Say what is there and let a person decide.
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "  there are uncommitted changes here:" >&2
    git status --short >&2
    echo >&2
    echo "  refusing to pull over them. Commit them, 'git stash', or 'git checkout -- .'." >&2
    exit 1
  fi

  say "Updating"
  # --ff-only: if the exhibit machine has commits of its own this stops rather than making a
  # merge nobody asked for on a machine nobody is looking at.
  git merge --ff-only --quiet "origin/$BRANCH"
  git --no-pager log --oneline "$BEFORE..$AFTER" | sed 's/^/  /'
fi

# npm ci deletes node_modules and takes a minute, so only when the lockfile actually moved.
if [ "$BEFORE" != "$AFTER" ] && ! git diff --quiet "$BEFORE" "$AFTER" -- package.json package-lock.json; then
  say "Dependencies changed"
  npm ci
fi

say "Restarting $SERVICE"
if ! command -v systemctl >/dev/null 2>&1; then
  echo "  no systemctl here. Start it by hand: scripts/exhibit.sh" >&2
elif ! systemctl list-unit-files "$SERVICE.service" --no-legend | grep -q .; then
  echo "  no $SERVICE.service installed yet — run: sudo scripts/install-service.sh" >&2
else
  sudo systemctl restart "$SERVICE"
  # Give it a moment to fail, if it is going to. Coming back up and falling over two seconds
  # later is the failure mode worth catching here.
  sleep 3
  if systemctl is-active --quiet "$SERVICE"; then
    echo "  $SERVICE is running"
  else
    echo "  $SERVICE did not come back:" >&2
    journalctl -u "$SERVICE" -n 25 --no-pager >&2
    exit 1
  fi
fi

say "Now at"
git --no-pager log --oneline -1 | sed 's/^/  /'
