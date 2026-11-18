#!/usr/bin/env bash
# Keeps one open issue while a workflow is red on a branch, so a red main is noticed without anyone
# watching it. `.github/workflows/main-health.yml` runs it when CI finishes on a push to main and
# when the paced Windows check finishes (release-check.yml), with the finished run in RUN_ID.
#
#   LABEL, TITLE    the issue's label and title, one issue per label
#   WORKFLOW        the workflow file whose runs decide, such as ci.yml
#   BRANCH, EVENT   the runs that count: this branch and event
#
# - A newer run of the same workflow, branch and event has finished, not cancelled: that run
#   decides, so it does nothing. A cancelled run decides nothing either.
# - The run passed: closes the open issue, noting the green run in its body.
# - The run failed: opens the issue, or rewrites its body, with this run's failed jobs and the
#   scenarios their logs name as failed, the first failed run and the last green one before it,
#   and the commits between them.
#
# It never re-runs, reverts or mentions anyone: backticks and @ are removed from log text. It
# mirrors scripts/releases/matrix-issue.sh, which does the same for the release matrix.
set -euo pipefail

: "${LABEL:?}" "${TITLE:?}" "${WORKFLOW:?}" "${BRANCH:?}" "${EVENT:?}" "${RUN_ID:?}"
server_repo="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY"

run="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$RUN_ID")"
run_url="$(jq -r .html_url <<< "$run")"
run_sha="$(jq -r .head_sha <<< "$run")"
run_attempt="$(jq -r .run_attempt <<< "$run")"
created="$(jq -r .created_at <<< "$run")"
conclusion="$(jq -r .conclusion <<< "$run")"

if [[ "$conclusion" == cancelled || "$conclusion" == skipped ]]; then
  echo "$run_url ended $conclusion, so it tested nothing and the issue stays as it is."
  exit 0
fi

finished="$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/$WORKFLOW/runs?branch=$BRANCH&event=$EVENT&status=completed&per_page=100" \
  --jq '[.workflow_runs[] | select(.conclusion != "cancelled" and .conclusion != "skipped") | {id, created_at, conclusion, head_sha, html_url}]')"
newer="$(jq -r --arg created "$created" '[.[] | select(.created_at > $created)][0].html_url // empty' <<< "$finished")"
if [[ -n "$newer" ]]; then
  echo "$newer, created after $run_url, has finished, so its result decides the issue."
  exit 0
fi

issue="$(gh issue list --repo "$GITHUB_REPOSITORY" --label "$LABEL" --state open --json number --jq '.[0].number // empty')"

if [[ "$conclusion" == success ]]; then
  if [[ -n "$issue" ]]; then
    body="$(gh issue view "$issue" --repo "$GITHUB_REPOSITORY" --json body --jq .body)"
    printf '%s\n\nPassed again in %s on %s.\n' "$body" "$run_url" "$run_sha" > "$RUNNER_TEMP/issue.md"
    gh issue edit "$issue" --repo "$GITHUB_REPOSITORY" --body-file "$RUNNER_TEMP/issue.md"
    gh issue close "$issue" --repo "$GITHUB_REPOSITORY" --reason completed
    echo "Closed #$issue: $WORKFLOW passed on $run_sha."
  else
    echo "$WORKFLOW passed on $run_sha and no issue is open."
  fi
  exit 0
fi

# Text from logs and job names, safe inside a code span: no backtick ends it, no @ mentions.
clean() { tr -d '`@'; }

# The failed jobs, and the scenarios their logs list in Vitest's summary or, for a job stopped
# before it, its live reporter.
jobs="$(gh api --paginate "repos/$GITHUB_REPOSITORY/actions/runs/$RUN_ID/attempts/$run_attempt/jobs?per_page=100" \
  --jq '.jobs[] | select(.conclusion == "failure" or .conclusion == "timed_out") | [.id, .name, .html_url] | @tsv')"
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

# The last green run before this one, and the first red run after it: kept from the open issue
# when there is one, otherwise the oldest failed run since that green one (or this run).
green="$(jq -r --arg created "$created" '[.[] | select(.created_at < $created and .conclusion == "success")][0] // empty | "\(.head_sha) \(.html_url)"' <<< "$finished")"
green_created="$(jq -r --arg created "$created" '[.[] | select(.created_at < $created and .conclusion == "success")][0].created_at // ""' <<< "$finished")"
first="$(jq -r --arg after "$green_created" --arg created "$created" '[.[] | select(.created_at > $after and .created_at <= $created and .conclusion != "success")][-1] // empty | "\(.head_sha) \(.html_url)"' <<< "$finished")"
if [[ -z "$first" ]]; then first="$run_sha $run_url"; fi
if [[ -n "$issue" ]]; then
  kept="$(gh issue view "$issue" --repo "$GITHUB_REPOSITORY" --json body --jq .body | sed -n 's/^<!-- first-red: \([0-9a-f]* [^ ]*\) -->$/\1/p')"
  if [[ -n "$kept" ]]; then first="$kept"; fi
fi
read -r first_sha first_url <<< "$first"

{
  echo "$WORKFLOW is red on $BRANCH. Fix the cause: do not re-run or revert to get it green. This issue closes when a later run passes."
  echo
  echo "- Latest failure: $run_url on $run_sha"
  echo "- First failure: $first_url on $first_sha"
  if [[ -n "$green" ]]; then
    read -r green_sha green_url <<< "$green"
    echo "- Last green run before it: $green_url on $green_sha. The first failure came from a commit in $server_repo/compare/$green_sha...$first_sha"
    commits="$(gh api "repos/$GITHUB_REPOSITORY/compare/$green_sha...$first_sha" \
      --jq '.commits[] | "\(.sha[0:9]) \(.commit.message | split("\n")[0])"' 2> /dev/null | clean | head -50 || true)"
    if [[ -n "$commits" ]]; then
      echo
      echo "Commits since the last green run, oldest first:"
      echo
      sed 's/^/- /' <<< "$commits"
    fi
  else
    echo "- No green run is among the last 100 finished runs before it."
  fi
  echo
  echo "Failed jobs in the latest failure:"
  echo
  if [[ -n "$details" ]]; then printf '%s' "$details"; else echo "- No failed job listed; see the run."; fi
  echo
  echo "<!-- first-red: $first_sha $first_url -->"
} > "$RUNNER_TEMP/issue.md"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then cat "$RUNNER_TEMP/issue.md" >> "$GITHUB_STEP_SUMMARY"; fi

if [[ -n "$issue" ]]; then
  gh issue edit "$issue" --repo "$GITHUB_REPOSITORY" --body-file "$RUNNER_TEMP/issue.md"
  echo "Updated #$issue with $run_url."
else
  gh label create "$LABEL" --repo "$GITHUB_REPOSITORY" --color B60205 \
    --description "$TITLE; main-health.yml opens and closes it" --force > /dev/null
  gh issue create --repo "$GITHUB_REPOSITORY" --title "$TITLE" --label "$LABEL" --body-file "$RUNNER_TEMP/issue.md"
fi
