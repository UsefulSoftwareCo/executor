#!/usr/bin/env bash
# Refreshes a stale bun.lock on main, in two steps of `.github/workflows/beta.yml` that run on each
# tick before it decides on a beta. `e2e/tests/lockfile-sync.spec.ts` runs both against a scratch
# remote.
#
#   lock-repair.sh prepare
#   lock-repair.sh push <start> <commit> <remote>
#
# A pull request cannot merge a lock it leaves stale itself (`scripts/check-lockfile.ts --base` in
# the `apps-version` job), but one that passed on an older main can, as could any before that
# check. This puts main right instead of failing every later run on it.
#
# `prepare` runs without the deploy key. When bun.lock is not what `bun install` writes, it
# refreshes it and commits `Refresh bun.lock [skip ci]` on the checkout, without pushing, and
# writes `ready=true`, `start=<the main it read>` and `commit=<the refresh>` to GITHUB_OUTPUT.
# Nobody reviews that commit, so it is made only when `scripts/releases/lock-repair-scope.ts`
# accepts the refresh: each changed line is a workspace's own `version`, set to what its
# package.json says. A refresh that changes anything else, a dependency added, removed or resolved
# differently among them, is not committed: it warns and writes the lines to the run summary.
#
# `push`, the only step that holds the key, pushes that commit to main at <remote> and writes
# `pushed=true` and `repaired=<commit>`. It pushes only the commit `prepare` made on the main it
# read. When the push is refused because main moved after the checkout, it pushes nothing: the
# push that moved main started a Beta run, queued behind this one, which repairs the new main.
#
# Neither step ever holds a beta: every failure warns and exits 0. A stale lock does not make main
# unhealthy, and the beta's own `bun install --frozen-lockfile` fails loudly on a lock that is
# unusable. Each step leaves the checkout on the main it read with bun.lock as committed, unless
# main now holds the refresh, because the version bump after them commits every changed file. The
# workflow resets the checkout too when `push` fails or times out.
set -euo pipefail

# A refusal: a warning, a run-summary section, `refused=true` and the reason in
# $RUNNER_TEMP/lock-repair-refused.md, which `lock-repair-issue.sh` puts in the issue it keeps open.
summary() {
  echo "::warning::$1"
  echo "refused=true" >> "$GITHUB_OUTPUT"
  {
    echo "$1"
    if [ -n "${2:-}" ]; then
      echo
      echo "$2"
    fi
  } >> "$RUNNER_TEMP/lock-repair-refused.md"
  {
    echo "### bun.lock not refreshed"
    echo
    echo "$1"
    if [ -n "${2:-}" ]; then
      echo
      echo '```diff'
      echo "$2"
      echo '```'
    fi
  } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
}

# Globals, because the EXIT traps read them after the function has returned.
start=""
ready=false
pushed=false

prepare() {
  local scope committed refreshed
  start=$(git rev-parse HEAD)
  # Every way out but a commit ready to push leaves the checkout as it was read.
  trap 'if [ "$ready" != true ]; then git reset -q --hard "$start"; fi' EXIT

  committed="$RUNNER_TEMP/bun.lock.committed"
  cp bun.lock "$committed"
  if ! bun install --lockfile-only > /dev/null; then
    summary "\`bun install --lockfile-only\` failed on main, so bun.lock was not checked."
    return 0
  fi
  if cmp -s bun.lock "$committed"; then
    echo "bun.lock is what \`bun install\` writes."
    echo "fresh=true" >> "$GITHUB_OUTPUT"
    return 0
  fi

  if ! scope=$(node "$(dirname "$0")/lock-repair-scope.ts" "$committed" bun.lock); then
    summary "bun.lock on main is not what \`bun install\` writes, and the refresh changes more than workspace versions, so it was not pushed. Run \`bun install\` and commit bun.lock in a pull request so the change gets a review." "$scope"
    return 0
  fi
  echo "$scope"

  # The refreshed lock must be what `bun install` writes from it, or the commit would be stale too.
  refreshed="$RUNNER_TEMP/bun.lock.refreshed"
  cp bun.lock "$refreshed"
  if ! bun install --lockfile-only > /dev/null || ! cmp -s bun.lock "$refreshed"; then
    summary "A second \`bun install --lockfile-only\` changed bun.lock again, so the refresh was not pushed."
    return 0
  fi

  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  # `[skip ci]` skips every push workflow for this commit, Beta and Executor releases included, as
  # for a release commit. The next merge runs them on a tree that contains it.
  git commit -q -m "Refresh bun.lock [skip ci]" -m "$scope" -- bun.lock
  {
    echo "ready=true"
    echo "start=$start"
    echo "commit=$(git rev-parse HEAD)"
  } >> "$GITHUB_OUTPUT"
  ready=true
}

push() {
  local commit=$2 remote=$3 main
  start=$1
  trap 'if [ "$pushed" != true ]; then git reset -q --hard "$start"; fi' EXIT
  # Only the commit `prepare` made, on the main it read, holding bun.lock alone.
  if [ "$(git rev-parse HEAD)" != "$commit" ] || [ "$(git rev-parse HEAD^)" != "$start" ] ||
    [ "$(git diff --name-only "$start" HEAD)" != "bun.lock" ]; then
    summary "The checkout is not the bun.lock refresh the previous step committed, so nothing was pushed."
    return 0
  fi

  if git push -q "$remote" "$commit:refs/heads/main"; then
    pushed=true
    echo "pushed=true" >> "$GITHUB_OUTPUT"
    echo "repaired=$commit" >> "$GITHUB_OUTPUT"
    echo "::notice::bun.lock on main recorded old workspace versions; pushed $commit to refresh it."
    # The version bump commits every changed file, so the checkout must hold main exactly.
    if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
      echo "::notice::The checkout had changes besides the refresh; reset them."
      git reset -q --hard "$commit"
    fi
    return 0
  fi

  if ! main=$(git ls-remote "$remote" refs/heads/main | cut -f1) || [ -z "$main" ]; then
    summary "Pushing the bun.lock refresh to main failed, and main could not be read either; check the deploy key."
    return 0
  fi
  if [ "$main" = "$start" ]; then
    summary "Pushing the bun.lock refresh to main was refused, and main is still at $start."
    return 0
  fi
  echo "::notice::main moved from $start to $main after this run read it, so the bun.lock refresh was not pushed. The push that moved main started a Beta run, which repairs the new main."
}

case "${1:-}" in
  prepare) prepare ;;
  push) push "$2" "$3" "$4" ;;
  *)
    echo "usage: lock-repair.sh prepare | push <start> <commit> <remote>" >&2
    exit 2
    ;;
esac
