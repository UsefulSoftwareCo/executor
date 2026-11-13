#!/usr/bin/env bash
# Keeps one issue open while the bun.lock repair on main needs a person.
# `.github/workflows/beta.yml` runs it on each tick after `lock-repair.sh`, with the two repair
# steps' outcomes and outputs in the environment. The step continues on error, so this script never
# makes a tick red or holds a beta. `e2e/tests/lockfile-sync.spec.ts` runs it with a stub `gh`.
#
# - A repair step failed or ran out of time, or the repair refused (it found a refresh it may not
#   push, or could not push one): opens the issue, or rewrites its body, with the reason.
# - The tick found main's lock fresh, or pushed the refresh: closes the open issue, noting the run.
# - Anything else (main moved during the tick, so the next tick decides): leaves the issue as it is.
#
# It only creates, edits and closes the issue: no comments, and nobody is mentioned, because the
# reason stays inside a fenced block.
set -euo pipefail

label=lock-repair-refused
title="The bun.lock repair on main needs a person"
run_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
sha=$(git rev-parse HEAD)
reasons="$RUNNER_TEMP/lock-repair-refused.md"

problem=""
case "${LOCK_OUTCOME:-}" in
  failure | cancelled) problem="The step that refreshes bun.lock failed or ran out of time." ;;
esac
case "${PUSH_OUTCOME:-}" in
  failure | cancelled) problem="${problem:+$problem }The step that pushes the refresh failed or ran out of time." ;;
esac
if [ "${REFUSED:-}" = true ] && [ -s "$reasons" ]; then
  problem="${problem:+$problem$'\n\n'}$(cat "$reasons")"
fi

issue=$(gh issue list --repo "$GITHUB_REPOSITORY" --label "$label" --state open --json number --jq '.[0].number // empty')

if [ -z "$problem" ]; then
  if [ "${FRESH:-}" != true ] && [ "${PUSHED:-}" != true ]; then
    echo "This tick neither refreshed bun.lock nor found it fresh, so the issue stays as it is."
    exit 0
  fi
  if [ -n "$issue" ]; then
    body=$(gh issue view "$issue" --repo "$GITHUB_REPOSITORY" --json body --jq .body)
    printf '%s\n\nbun.lock on main is what `bun install` writes again, in %s on %s.\n' "$body" "$run_url" "$sha" > "$RUNNER_TEMP/lock-issue.md"
    gh issue edit "$issue" --repo "$GITHUB_REPOSITORY" --body-file "$RUNNER_TEMP/lock-issue.md"
    gh issue close "$issue" --repo "$GITHUB_REPOSITORY" --reason completed
    echo "Closed #$issue: bun.lock on main is fresh."
  fi
  exit 0
fi

# The first tick that needed a person is kept from the open issue; otherwise it is this one.
first="$sha $run_url"
if [ -n "$issue" ]; then
  kept=$(gh issue view "$issue" --repo "$GITHUB_REPOSITORY" --json body --jq .body |
    sed -n 's/^<!-- first-seen: \([0-9a-f]* [^ ]*\) -->$/\1/p')
  if [ -n "$kept" ]; then first=$kept; fi
fi
read -r first_sha first_url <<< "$first"

{
  echo "The Beta workflow's bun.lock repair did not refresh the lock on main. Until it does, every fresh \`bun install\` on main rewrites bun.lock."
  echo
  echo "When the refresh changes more than workspace versions, a dependency change no one has reviewed, run \`bun install\` on main and commit bun.lock in a pull request. When a step failed or the push was refused, read the run's log. This issue closes when a later tick finds the lock fresh or pushes the refresh."
  echo
  echo "- Latest: $run_url on $sha"
  echo "- First: $first_url on $first_sha"
  echo
  echo "~~~text"
  # Nothing in the reason can end the fence.
  sed 's/~~~/~ ~ ~/g' <<< "$problem"
  echo "~~~"
  echo
  echo "<!-- first-seen: $first_sha $first_url -->"
} > "$RUNNER_TEMP/lock-issue.md"

if [ -n "$issue" ]; then
  gh issue edit "$issue" --repo "$GITHUB_REPOSITORY" --body-file "$RUNNER_TEMP/lock-issue.md"
  echo "Updated #$issue with $run_url."
else
  gh label create "$label" --repo "$GITHUB_REPOSITORY" --color B60205 \
    --description "The bun.lock repair on main needs a person" --force > /dev/null
  gh issue create --repo "$GITHUB_REPOSITORY" --title "$title" --label "$label" --body-file "$RUNNER_TEMP/lock-issue.md"
fi
