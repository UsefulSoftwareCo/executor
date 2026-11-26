#!/usr/bin/env bash
# The `apps-version` checks, shared by CI's `apps-version` job (.github/workflows/checks.yml) and
# `bun run pr:check` (scripts/pr-check.ts), so the two cannot drift.
#
#   scripts/ci/apps-version.sh <step> <main checkout> <lock base checkout>
#
# <main checkout> is main as the pull request is compared with (CI: the pull request's base on main,
# or main itself for an upper stack layer). <lock base checkout> is where the pull request meets
# main. Steps, in the order the job runs them:
#
#   base-build  install and build the apps package in <main checkout>
#   lockfile    require bun.lock to record this tree's package.json changes (scripts/check-lockfile.ts)
#   bump        require a version bump for an apps change (scripts/releases/apps-bumped.ts)
#   protocols   check the live host protocol against main's (scripts/check-app-protocols.ts)
#   all         every step above
set -euo pipefail

step=${1:?usage: apps-version.sh <step> <main checkout> <lock base checkout>}
main=${2:?usage: apps-version.sh <step> <main checkout> <lock base checkout>}
lock_base=${3:?usage: apps-version.sh <step> <main checkout> <lock base checkout>}

base_build() {
  (cd "$main" && bun install --frozen-lockfile && bun run apps:build)
}

lockfile() {
  node scripts/check-lockfile.ts --base "$lock_base"
}

# Compared with main's tip. When this build differs and its version is not above main's, the check
# exits 3: an upper stack layer behind main differs without touching apps, so it builds where the
# pull request meets main and asks again.
bump() {
  bun run apps:build
  local status=0
  node scripts/releases/apps-bumped.ts "$main/packages/apps/dist" || status=$?
  if [ "$status" -eq 3 ]; then
    (cd "$lock_base" && bun install --frozen-lockfile && bun run apps:build)
    node scripts/releases/apps-bumped.ts "$main/packages/apps/dist" "$lock_base/packages/apps/dist"
  elif [ "$status" -ne 0 ]; then
    return "$status"
  fi
}

# The same protocol number must still accept everything it accepted at the base.
protocols() {
  bun run apps:protocols --base "$main/packages/apps/protocols"
}

case "$step" in
  base-build) base_build ;;
  lockfile) lockfile ;;
  bump) bump ;;
  protocols) protocols ;;
  all) base_build && lockfile && bump && protocols ;;
  *)
    echo "Unknown step $step" >&2
    exit 2
    ;;
esac
