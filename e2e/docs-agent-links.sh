#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
fixture=apps/docs/content/run/agent-link-fixture.md
asset=apps/docs/public/agent-link-fixture-asset
(set -o noclobber; cat e2e/docs-agent-link-fixture.md > "$fixture")
trap 'rm -f "$fixture"' EXIT
(set -o noclobber; cat apps/docs/public/executor-og-logo.svg > "$asset")
trap 'rm -f "$fixture" "$asset"' EXIT

docs=apps/docs/dist
mkdir -p .local
backup=$(mktemp -d "$PWD/.local/docs-agent-links.XXXXXXXX")
if [[ -d "$docs" ]]; then mv "$docs" "$backup/dist"; fi
restore() {
  rm -f "$fixture" "$asset"
  rm -rf "$docs"
  if [[ -d "$backup/dist" ]]; then mv "$backup/dist" "$docs"; fi
  rmdir "$backup"
}
trap restore EXIT
bun run docs:build
mirror=$docs/run/agent-link-fixture.md
full=$docs/llms-full.txt
fail=0
contains() {
  if ! rg -Fq -- "$2" "$1"; then
    printf '%s is missing %s\n' "$1" "$2" >&2
    fail=1
  fi
}
for file in "$mirror" "$full"; do
  contains "$file" '[Inline mirror](/docs/mcp-clients.md?format=raw#check-that-it-worked)'
  contains "$file" '[mirror]: /docs/mcp-clients.md?format=raw#check-that-it-worked'
  contains "$file" '[Image asset](/docs/executor-og-logo.svg)'
  contains "$file" '[asset]: /docs/executor-og-logo.svg'
  contains "$file" '![Inline image](/docs/executor-og-logo.svg)'
  contains "$file" '[image]: /docs/executor-og-logo.svg'
  contains "$file" '![Inline extensionless image](/docs/agent-link-fixture-asset?size=1)'
  contains "$file" '[extensionless]: /docs/agent-link-fixture-asset?size=1'
  contains "$file" '[Marketing asset](/og-image.png)'
  contains "$file" 'href="/docs/mcp-clients#check-that-it-worked"'
  contains "$file" '[Example](/mcp-clients)'
  contains "$file" 'href=" https://example.com/docs/mcp-clients?x=1#check-that-it-worked "'
  contains "$file" 'href=" //example.com/docs/mcp-clients?x=1#check-that-it-worked "'
done
contains "$mirror" '[Sibling page](./cli#install-and-start)'
contains "$mirror" '[Local heading](#local-heading)'
contains "$full" '[Sibling page](/docs/run/cli#install-and-start)'
contains "$full" '[Local heading](/docs/run/agent-link-fixture#local-heading)'
exit "$fail"
