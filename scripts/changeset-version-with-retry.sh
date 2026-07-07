#!/usr/bin/env bash
# Runs `bun run changeset:version`, retrying only the transient GitHub GraphQL
# failure modes of @changesets/changelog-github (truncated responses).
#
# Invoked from .github/workflows/release.yml as the changesets/action `version`
# command. It lives in a script because the action splits the command string
# itself rather than handing it to a shell, so inline quoting does not survive.
set -u

for attempt in 1 2 3; do
  log="$(mktemp)"
  if bun run changeset:version >"$log" 2>&1; then
    cat "$log"
    rm -f "$log"
    exit 0
  fi
  status=$?
  cat "$log"
  if ! grep -Eq "Failed to parse data from GitHub|Premature close" "$log" || [ "$attempt" -eq 3 ]; then
    rm -f "$log"
    exit "$status"
  fi
  echo "::warning::changeset:version hit a transient GitHub GraphQL failure on attempt $attempt; resetting generated files before retry."
  rm -f "$log"
  git reset --hard HEAD
  git clean -fd -- .changeset apps packages examples e2e
done
