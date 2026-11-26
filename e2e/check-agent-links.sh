#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
site=apps/hosted/cloud/.generated/site
page=$site/docs/desktop-apps.md
full=$site/docs/llms-full.txt
backup=$(mktemp -d)
cp "$page" "$full" "$backup/"
trap 'cp "$backup/desktop-apps.md" "$page"; cp "$backup/llms-full.txt" "$full"; rm -rf "$backup"' EXIT

fail=0
reject() {
  local file=$1 fixture=$2 target=$3
  printf '\n\n%s\n' "$fixture" >> "$file"
  local output
  if output=$(bun run site:links 2>&1); then
    printf 'The crawler accepted %s in %s\n' "$fixture" "$file" >&2
    fail=1
  elif ! rg -F -- "$target is linked from" <<< "$output"; then
    printf '%s\nCrawler did not diagnose %s\n' "$output" "$target" >&2
    fail=1
  fi
  cp "$backup/${file##*/}" "$file"
}

reject "$page" '[The MCP endpoint](/mcp)' /mcp
reject "$full" '[Check that it worked](/mcp-clients#check-that-it-worked)' /mcp-clients#check-that-it-worked
reject "$page" '[Missing heading](/docs/mcp-clients#absent-fixture)' /docs/mcp-clients#absent-fixture
reject "$page" '[Missing local heading](#absent-fixture)' /docs/desktop-apps.md#absent-fixture
reject "$page" '[Missing mirror heading](/docs/mcp-clients.md#absent-fixture)' /docs/mcp-clients.md#absent-fixture
reject "$page" "<a href='/docs/absent-fixture'>Missing HTML target</a>" /docs/absent-fixture
accept_front_matter() {
  local file=$1 line=$2 output
  awk -v line="$line" 'NR == 1 && $0 == "---" { print; print line; next } { print }' "$backup/${file##*/}" > "$file"
  if ! head -2 "$file" | rg -Fq -- "$line"; then
    printf '%s has no front matter to extend\n' "$file" >&2
    fail=1
  elif ! output=$(bun run site:links 2>&1); then
    printf '%s\nThe crawler rejected front matter text in %s\n' "$output" "$file" >&2
    fail=1
  fi
  cp "$backup/${file##*/}" "$file"
}

accept_front_matter "$page" 'fixture_note: "Use literal [label](/not-a-real-fixture) syntax in documentation."'
exit "$fail"
