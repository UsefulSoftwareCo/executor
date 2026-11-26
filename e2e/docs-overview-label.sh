#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
fixture=apps/docs/content/overview-label-fixture.md
mkdir -p .local
output=$(mktemp -d "$PWD/.local/overview-label.XXXXXXXX")
trap 'rm -rf "$output"' EXIT
(set -o noclobber; printf '%s\n' '---' 'title: "Map ] values"' '---' '' 'A docs page.' > "$fixture")
trap 'rm -f "$fixture"; rm -rf "$output"' EXIT

origin=https://overview.example.invalid
EXECUTOR_SITE_ORIGIN="$origin" bun run marketing:build --outDir "$output"
for file in index.md llms.txt; do
  expected="- [Map \] values]($origin/docs/overview-label-fixture)"
  if ! rg --fixed-strings -- "$expected" "$output/$file"; then
    printf 'Missing escaped docs link in %s\n' "$file" >&2
    exit 1
  fi
done
