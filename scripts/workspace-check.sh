#!/usr/bin/env bash
# Read-only worktree check. Fetch updates remote refs but never changes files.
set -euo pipefail

mode="${1:---main}"
if [[ "$mode" == "--help" ]]; then
  printf 'Usage: bash scripts/workspace-check.sh [--main|--task]\n'
  printf 'Require a clean, current main checkout or a clean task branch based on main.\n'
  exit 0
fi
if [[ $# -gt 1 || ( "$mode" != "--main" && "$mode" != "--task" ) ]]; then
  printf 'Expected --main or --task.\n' >&2
  exit 2
fi

checkout_root="$(git rev-parse --show-toplevel)"
cd "$checkout_root"
if ! git fetch --quiet origin; then
  printf 'Cannot verify current main: fetching origin failed.\n' >&2
  exit 1
fi
git rev-parse --verify origin/main >/dev/null
branch="$(git symbolic-ref --quiet --short HEAD || true)"
read -r ahead behind < <(git rev-list --left-right --count HEAD...origin/main)
status="$(git status --porcelain=v1 --untracked-files=all)"
failed=0

printf 'Checkout: %s\nBranch: %s\nCompared with origin/main: %s ahead, %s behind\n' \
  "$checkout_root" "${branch:-detached HEAD}" "$ahead" "$behind"

if [[ -n "$status" ]]; then
  printf '\nUncommitted work must be assigned to a task before continuing:\n%s\n' "$status"
  failed=1
fi
if [[ "$mode" == "--main" ]]; then
  if [[ "$checkout_root" == */.rifts/* || "$branch" != "main" ]]; then
    printf '\nUse the canonical top-level executor-next checkout on main for the shared preview.\n'
    failed=1
  fi
  if [[ "$ahead" != 0 || "$behind" != 0 ]]; then
    printf '\nMain must match origin/main. Preserve local commits; only fast-forward a clean checkout.\n'
    failed=1
  fi
else
  if [[ "$checkout_root" != */.rifts/* ]]; then
    printf '\nUse an isolated task rift; keep the canonical checkout on main.\n'
    failed=1
  fi
  if [[ -z "$branch" || "$branch" == "main" ]]; then
    printf '\nTask work needs its own named branch.\n'
    failed=1
  fi
  if [[ "$behind" != 0 ]]; then
    printf '\nIntegrate current origin/main into this task branch before continuing.\n'
    failed=1
  fi
fi
if [[ "$failed" == 0 ]]; then printf '\nWorkspace check passed.\n'; fi
exit "$failed"
