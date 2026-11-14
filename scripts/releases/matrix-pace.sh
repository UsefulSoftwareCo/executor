#!/usr/bin/env bash
# Paces the release checks on main to one build every PACE_SECONDS (two hours by default).
# `.github/workflows/release-artifacts.yml` runs it as the first job of each check, the runs the
# Release check workflow starts with a repository dispatch, which list apart from every other run.
#
# - The last check that built, the newest older one not cancelled whose own pace job passed,
#   started building that long ago or longer: this check builds now.
# - Otherwise this check waits until then. If a newer check is waiting by that time, it contains
#   this check's commits, so this check cancels itself and the newer one builds at once. A
#   cancelled check tested nothing and counts for nothing. Otherwise this check builds.
#
# So every check builds within PACE_SECONDS of the last build, and a red check's cause lies in the
# commits since the build before it. Checks share one concurrency group that never cancels a
# running run, so only this check can be pacing. Writes nothing but the run's own cancellation.
set -euo pipefail

pace="${PACE_SECONDS:-7200}"
runs="repos/$GITHUB_REPOSITORY/actions/workflows/release-artifacts.yml/runs?branch=main&event=repository_dispatch"
created="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" --jq .created_at)"

# Older checks, newest first; the first whose pace job passed is the last build.
last=""
# Finished runs only, enough to reach the last build past a busy day of checks that gave way.
for id in $(gh api "$runs&status=completed&per_page=100" --jq ".workflow_runs[] | select(.created_at < \"$created\" and .conclusion != \"cancelled\") | .id"); do
  last="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$id/jobs?per_page=100" \
    --jq '[.jobs[] | select(.name == "pace" and .conclusion == "success") | .completed_at][0] // empty')"
  if [[ -n "$last" ]]; then
    echo "The last build, run $id, started at $last."
    break
  fi
done

if [[ -z "$last" ]]; then
  echo "No earlier check on main built, so this one builds now."
  exit 0
fi
wait=$(($(date -d "$last" +%s) + pace - $(date +%s)))
if ((wait <= 0)); then
  echo "That was at least $((pace / 60)) minutes ago, so this run builds now."
  exit 0
fi

echo "Waiting $((wait / 60)) minutes, until $((pace / 60)) minutes after it."
sleep "$wait"
newer="$(gh api "$runs&per_page=30" --jq "[.workflow_runs[] | select(.created_at > \"$created\" and .status != \"completed\")] | length")"
if [[ "$newer" == 0 ]]; then
  echo "No newer check is waiting, so this check builds."
  exit 0
fi
echo "A newer check on main is waiting and contains this check's commits; it builds instead."
gh run cancel "$GITHUB_RUN_ID" --repo "$GITHUB_REPOSITORY"
# The cancellation stops this job. A run that tested nothing must never pass, so it fails if not.
sleep 300
echo "::error::This run asked to be cancelled, yet is still running. It tested nothing."
exit 1
