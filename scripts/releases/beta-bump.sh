#!/usr/bin/env bash
# Commits `Release <next> [skip ci]` on the checked-out main and pushes it to main at <remote>.
# `.github/workflows/beta.yml` runs it after `scripts/releases/beta-due.ts` decides `bump`, and
# `e2e/tests/beta-due.spec.ts` runs it against a scratch remote.
#
#   beta-bump.sh <current version> <remote>
#
# Writes `release=<next>` to GITHUB_OUTPUT once main holds the commit. When the push is refused
# because main moved after the checkout, it pushes nothing, writes no release and exits 0: the
# push that moved main started a Beta run, queued behind this one, which decides again from the
# new main. Any other refusal fails.
set -euo pipefail

current=$1
remote=$2
next="2.0.0-beta.$((${current##*.} + 1))"

node -e '
  const fs = require("fs");
  const [current, next] = process.argv.slice(1);
  const edit = (file, change) => {
    const before = fs.readFileSync(file, "utf8");
    const after = change(before);
    if (after === before) {
      console.error(`::error::${file} does not record apps/cli at ${current}.`);
      process.exit(1);
    }
    fs.writeFileSync(file, after);
  };
  const version = (text) => `"version": "${text}"`;
  edit("apps/cli/package.json", (text) => text.replace(version(current), version(next)));
  edit("bun.lock", (text) =>
    text.replace(/"apps\/cli": \{[^}]*\}/, (entry) => entry.replace(version(current), version(next))),
  );
  edit("apps/cli/CHANGELOG.md", (text) =>
    text.replace(
      /^## /m,
      `## ${next}\n\nBeta of the Executor local runtime, CLI, desktop, and self-host Docker image.\n\n## `,
    ),
  );
' "$current" "$next"

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
# `[skip ci]` skips every push workflow for this commit, Beta included: CI, Deploy, the public
# export and Cloud tests run with the next merge, which contains it.
git commit -qam "Release $next [skip ci]"
base=$(git rev-parse HEAD^)

if git push -q "$remote" HEAD:main; then
  echo "release=$next" >> "$GITHUB_OUTPUT"
  exit 0
fi

main=$(git ls-remote "$remote" refs/heads/main | cut -f1)
if [ -z "$main" ] || [ "$main" = "$base" ]; then
  echo "::error::Pushing Release $next to main was refused, and main is still at $base."
  exit 1
fi
echo "::notice::main moved from $base to $main after this run read it, so Release $next was not pushed. The push that moved main started a Beta run, which decides again from the new main."
