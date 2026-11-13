#!/usr/bin/env bash
# Keeps one issue for a red release matrix on main. `.github/workflows/release-artifacts.yml` runs
# it in the `report` job of each push run on main and each build dispatch from main, with NEEDS
# holding the jobs' results. The job continues on error, so this script never makes a run red.
#
# - The run's pace job did not pass: the matrix never ran, so it does nothing.
# - A newer matrix run on main has finished, by the rule scripts/releases/beta-due.ts uses (a push
#   run whose pace job passed, or a build dispatch from main, not cancelled): that result decides,
#   so it does nothing.
# - Every matrix job passed: closes the open issue, noting the green run in its body.
# - A matrix job failed: opens the issue, or rewrites its body, with this run's failed jobs and the
#   scenarios their logs name as failed, the first failed run and the last green one before it.
#
# It never re-runs, reverts or mentions anyone: backticks and @ are removed from log text.
set -euo pipefail

label=release-matrix-red
title="Executor releases is failing on main"
server_repo="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY"
run_url="$server_repo/actions/runs/$GITHUB_RUN_ID"

pace="$(jq -r '.pace.result // "skipped"' <<< "$NEEDS")"
if [[ "$pace" != success && "$pace" != skipped ]]; then
  echo "The pace job ended $pace, so the matrix did not run and the issue stays as it is."
  exit 0
fi

# Whether a finished run on main tested the matrix: a push run whose pace passed, or a dispatch
# whose metadata passed and skipped the publishing step. Prints its releases job's conclusion.
verdict() {
  local id=$1 event=$2 jobs
  jobs="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$id/jobs?per_page=100")"
  if [[ "$event" == push ]]; then
    jq -e '.jobs[] | select(.name == "pace" and .conclusion == "success")' <<< "$jobs" > /dev/null || return 0
  else
    jq -e '.jobs[] | select(.name == "metadata" and .conclusion == "success")
      | .steps[] | select(.name == "Check the apps release is published unchanged" and .conclusion == "skipped")' \
      <<< "$jobs" > /dev/null || return 0
  fi
  jq -r '[.jobs[] | select(.name == "releases") | .conclusion][0] // "missing"' <<< "$jobs"
}

created="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" --jq .created_at)"
finished="$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/release-artifacts.yml/runs?branch=main&status=completed&per_page=100" \
  --jq '[.workflow_runs[] | select(.conclusion != "cancelled" and (.event == "push" or .event == "workflow_dispatch")) | {id, created_at, event, head_sha, html_url}]')"
for id in $(jq -r --arg created "$created" '.[] | select(.created_at > $created) | "\(.id):\(.event)"' <<< "$finished"); do
  if [[ -n "$(verdict "${id%%:*}" "${id##*:}")" ]]; then
    echo "Matrix run ${id%%:*} on main, created after this one, has finished, so its result decides the issue."
    exit 0
  fi
done

issue="$(gh issue list --repo "$GITHUB_REPOSITORY" --label "$label" --state open --json number --jq '.[0].number // empty')"
failed="$(jq -r 'to_entries[] | select(.key != "pace" and .value.result != "success") | "\(.key): \(.value.result)"' <<< "$NEEDS")"

if [[ -z "$failed" ]]; then
  if [[ -n "$issue" ]]; then
    body="$(gh issue view "$issue" --repo "$GITHUB_REPOSITORY" --json body --jq .body)"
    printf '%s\n\nPassed again in %s on %s.\n' "$body" "$run_url" "$GITHUB_SHA" > "$RUNNER_TEMP/issue.md"
    gh issue edit "$issue" --repo "$GITHUB_REPOSITORY" --body-file "$RUNNER_TEMP/issue.md"
    gh issue close "$issue" --repo "$GITHUB_REPOSITORY" --reason completed
    echo "Closed #$issue: the matrix passed on $GITHUB_SHA."
  fi
  exit 0
fi

# Text from logs and job names, safe inside a code span: no backtick ends it, no @ mentions.
clean() { tr -d '`@'; }

# The failed jobs by their matrix names, and the scenarios their logs list in Vitest's summary or,
# for a job stopped before it, its live reporter.
jobs="$(gh api --paginate "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/attempts/$GITHUB_RUN_ATTEMPT/jobs?per_page=100" \
  --jq '.jobs[] | select(.conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "cancelled") | [.id, .name, .html_url] | @tsv')"
details=""
while IFS=$'\t' read -r id name url; do
  [[ -n "$id" ]] || continue
  log="$(gh api "repos/$GITHUB_REPOSITORY/actions/jobs/$id/logs" 2> /dev/null |
    sed -E 's/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z ?//; s/\x1b\[[0-9;?]*[A-Za-z]//g' || true)"
  scenarios="$(grep -E '^\s*FAIL\s+.*\.(spec|test)\.[cm]?[jt]sx? > ' <<< "$log" | sed -E 's/^\s*FAIL\s+//' | clean | sort -u | head -20 || true)"
  if [[ -z "$scenarios" ]]; then
    scenarios="$(grep -E '^\s*[×✗]\s+.*\.(spec|test)\.[cm]?[jt]sx? > ' <<< "$log" | sed -E 's/^\s*[×✗]\s+//; s/\s+[0-9]+ms$//' | clean | sort -u | head -20 || true)"
  fi
  details+="- [$(clean <<< "$name")]($url)"$'\n'
  if [[ -n "$scenarios" ]]; then
    details+="$(sed 's/^/  - `/; s/$/`/' <<< "$scenarios")"$'\n'
  else
    details+="  - No failed scenario in its log; see the job's failed step."$'\n'
  fi
done <<< "$jobs"

# The first red run is kept from the open issue; otherwise it is this one.
first="$GITHUB_SHA $run_url"
if [[ -n "$issue" ]]; then
  kept="$(gh issue view "$issue" --repo "$GITHUB_REPOSITORY" --json body --jq .body | sed -n 's/^<!-- first-red: \([0-9a-f]* [^ ]*\) -->$/\1/p')"
  if [[ -n "$kept" ]]; then first="$kept"; fi
fi
read -r first_sha first_url <<< "$first"
# A deleted first run leaves only its commit; the last green run is then looked for before this one.
first_created="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/${first_url##*/}" --jq .created_at 2> /dev/null || echo "$created")"
green=""
for row in $(jq -r --arg created "$first_created" '.[] | select(.created_at < $created) | "\(.id):\(.event):\(.head_sha):\(.html_url)"' <<< "$finished"); do
  IFS=: read -r id event sha url <<< "$row"
  conclusion="$(verdict "$id" "$event")"
  [[ -n "$conclusion" ]] || continue
  if [[ "$conclusion" == success ]]; then green="$sha $url"; fi
  break
done

{
  echo "Executor releases is red on main. Fix the cause: do not re-run or revert to get it green. This issue closes when a later run on main passes; to test a fix that touches no release path, dispatch Executor releases from main with channel build."
  echo
  echo "- Latest failure: $run_url on $GITHUB_SHA"
  echo "- First failure: $first_url on $first_sha"
  if [[ -n "$green" ]]; then
    read -r green_sha green_url <<< "$green"
    echo "- Last green run before it: $green_url on $green_sha. The first failure came from a commit in $server_repo/compare/$green_sha...$first_sha"
  else
    echo "- The matrix run on main before the first failure did not pass, or is not among the last 100 finished runs."
  fi
  echo
  echo "Failed jobs in the latest failure:"
  echo
  if [[ -n "$details" ]]; then printf '%s' "$details"; else echo "$failed" | sed 's/^/- /'; fi
  echo
  echo "<!-- first-red: $first_sha $first_url -->"
} > "$RUNNER_TEMP/issue.md"

if [[ -n "$issue" ]]; then
  gh issue edit "$issue" --repo "$GITHUB_REPOSITORY" --body-file "$RUNNER_TEMP/issue.md"
  echo "Updated #$issue with $run_url."
else
  gh label create "$label" --repo "$GITHUB_REPOSITORY" --color B60205 \
    --description "The release matrix on main is red" --force > /dev/null
  gh issue create --repo "$GITHUB_REPOSITORY" --title "$title" --label "$label" --body-file "$RUNNER_TEMP/issue.md"
fi
