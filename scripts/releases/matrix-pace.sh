#!/usr/bin/env bash
# Paces the release matrix's push runs on main to one build every PACE_SECONDS (two hours by
# default). `.github/workflows/release-artifacts.yml` runs it as the first job of each push run.
#
# - The last push run on main that built, the newest older one whose own pace job passed and
#   that was not cancelled, started building that long ago or longer: this run builds now.
# - Otherwise this run waits until then. If a newer push run on main is waiting by that time, it
#   contains this run's commits, so this run cancels itself and the newer one builds at once. A
#   cancelled run tested nothing and counts for nothing. Otherwise this run builds.
#
# So every push builds within PACE_SECONDS of the last build, and a red run's cause lies in the
# commits since the build before it. Push runs share one concurrency group that never cancels a
# running run, so only this run can be pacing. Writes nothing but the run's own cancellation.
set -euo pipefail

pace="${PACE_SECONDS:-7200}"
runs="repos/$GITHUB_REPOSITORY/actions/workflows/release-artifacts.yml/runs?branch=main&event=push"
created="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" --jq .created_at)"

# Older push runs, newest first; the first whose pace job passed is the last build.
last=""
# Finished runs only, enough to reach the last build past a busy day of runs that gave way.
for id in $(gh api "$runs&status=completed&per_page=100" --jq ".workflow_runs[] | select(.created_at < \"$created\" and .conclusion != \"cancelled\") | .id"); do
  last="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$id/jobs?per_page=100" \
    --jq '[.jobs[] | select(.name == "pace" and .conclusion == "success") | .completed_at][0] // empty')"
  if [[ -n "$last" ]]; then
    echo "The last build, run $id, started at $last."
    break
  fi
done

if [[ -z "$last" ]]; then
  echo "No earlier push run on main built, so this one builds now."
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
  echo "No newer push is waiting, so this run builds."
  exit 0
fi
echo "A newer push run on main is waiting and contains this run's commits; it builds instead."
gh run cancel "$GITHUB_RUN_ID" --repo "$GITHUB_REPOSITORY"
# The cancellation stops this job. A run that tested nothing must never pass, so it fails if not.
sleep 300
echo "::error::This run asked to be cancelled, yet is still running. It tested nothing."
exit 1
