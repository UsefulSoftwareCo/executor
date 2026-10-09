#!/usr/bin/env bash
# Summarizes which merges a "Cloud tests on main" run tests. The baseline is the
# nearest ancestor of SHA whose run reached the deployed scenarios, shown by its
# deployed-neon-results artifact. A run that failed during checkout, install or
# deploy, or that was replaced while pending, tested nothing and is not a baseline.
#
# Inputs: REPO (owner/name) and SHA (the commit under test). Writes Markdown to
# GITHUB_STEP_SUMMARY, or to stdout when it is unset. The summary is
# informational, so a failed API lookup reports an unknown range and exits 0.
set -euo pipefail
: "${REPO:?}" "${SHA:?}"
summary=${GITHUB_STEP_SUMMARY:-/dev/stdout}
api_error=$(mktemp)
trap 'rm -f "$api_error"' EXIT

api() { gh api "$@" 2> "$api_error"; }
unknown() {
  local reason
  reason="$1: $(head -c 200 "$api_error" | tr '\n' ' ' | sed 's/ *$//')"
  echo "Range unknown ($reason)." >> "$summary"
  echo "::notice::This run's range is unknown ($reason)."
  exit 0
}

echo "### Merges this run tests" >> "$summary"

# Newest first. 30 runs is about a day of main pushes; an older baseline means
# the lane has been broken for a day, and each run costs two more requests.
runs=$(api "repos/$REPO/actions/workflows/cloud-tests.yml/runs?branch=main&event=push&status=completed&per_page=30" \
  --jq '.workflow_runs[] | select(.head_sha != env.SHA) | [.id, .head_sha, .conclusion, .html_url] | @tsv') ||
  unknown "listing runs failed"

baseline_sha=""
baseline_run=""
baseline_conclusion=""
not_started=()
while IFS=$'\t' read -r id sha conclusion url; do
  [ -n "$id" ] || continue
  # A rerun of an older commit must not count newer commits as already tested.
  ancestry=$(api "repos/$REPO/compare/$sha...$SHA?per_page=1" --jq .status) ||
    unknown "comparing ${sha:0:9} failed"
  [ "$ancestry" = ahead ] || continue
  started=$(api "repos/$REPO/actions/runs/$id/artifacts?name=deployed-neon-results" --jq .total_count) ||
    unknown "reading artifacts of run $id failed"
  if [ "$started" -gt 0 ]; then
    baseline_sha=$sha
    baseline_run=$url
    baseline_conclusion=$conclusion
    break
  fi
  if [ "$conclusion" != cancelled ]; then
    not_started+=("- [\`${sha:0:9}\`]($url) $conclusion, no scenario results")
  fi
done <<< "$runs"

if [ ${#not_started[@]} -gt 0 ]; then
  {
    echo "Later runs with no record that the scenarios ran (no deployed-neon-results artifact):"
    echo
    printf '%s\n' "${not_started[@]}"
    echo
  } >> "$summary"
fi

if [ -z "$baseline_sha" ]; then
  echo "No earlier ancestor of \`${SHA:0:9}\` ran the deployed scenarios in the last 30 runs." >> "$summary"
  echo "::notice::No earlier tested commit found; this run's range is unknown."
  exit 0
fi

case "$baseline_conclusion" in
  success) outcome="passed" ;;
  failure) outcome="failed" ;;
  *) outcome="ended as $baseline_conclusion" ;;
esac
# The compare API returns at most 250 commits per request; pages return the rest.
count=$(api "repos/$REPO/compare/$baseline_sha...$SHA?per_page=1" --jq .total_commits) ||
  unknown "counting commits since ${baseline_sha:0:9} failed"
commits=$(api --paginate "repos/$REPO/compare/$baseline_sha...$SHA?per_page=100" \
  --jq '.commits[] | "- [`\(.sha[0:9])`](\(.html_url)) \(.commit.message | split("\n")[0])"') ||
  unknown "listing commits since ${baseline_sha:0:9} failed"
listed=$(grep -c . <<< "$commits" || true)
{
  echo "$count commits after [\`${baseline_sha:0:9}\`]($baseline_run), the last commit whose deployed scenarios ran. That run $outcome."
  echo
  echo "$commits"
  if [ "$listed" -ne "$count" ]; then
    echo
    echo "Listed $listed of $count commits; the compare API returned no more."
  fi
} >> "$summary"
if [ "$count" -gt 1 ]; then
  echo "::notice::This run tests $count commits since ${baseline_sha:0:9}; a failure can come from any of them."
fi
