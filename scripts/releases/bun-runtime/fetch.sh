#!/usr/bin/env bash
# Download one locked-down Bun runtime from its release in this repository and check it against
# the digest pinned on main in SHA256SUMS beside this script, not against anything in the release:
# the release could change after it was published, the pinned file only by a reviewed commit.
#
#   scripts/releases/bun-runtime/fetch.sh <release> <file> <directory>
#
# Prints nothing on success and leaves the executable at <directory>/<file>; a download that fails
# the check is removed, never moved there. A runtime with no pinned digest fails with the command
# that pins it (pin.sh, after the release is published).
set -euo pipefail
release="$1"
file="$2"
directory="$3"
pins="$(dirname "$0")/SHA256SUMS"
expected="$(awk -v name="$release/$file" '$2 == name { print $1 }' "$pins")"
if [[ -z "$expected" ]]; then
  echo "::error::$release/$file has no digest pinned in scripts/releases/bun-runtime/SHA256SUMS. Once the release is published, pin it with: bash scripts/releases/bun-runtime/pin.sh $release, and quote its output in the pull request. A reviewer of a pin change checks pin.sh's output, which the pull request quotes: the release was published by github-actions[bot], and its commit's build inputs match the pull request's or differ only in lines that cannot change the built files." >&2
  exit 1
fi
mkdir -p "$directory"
# Downloaded beside its destination and moved there only once it matches, so a file that does not
# match is never at the path a later step runs.
download="$(mktemp -d "$directory/.fetch.XXXXXX")"
trap 'rm -rf "$download"' EXIT
gh release download "$release" --repo "$GITHUB_REPOSITORY" --pattern "$file" --dir "$download"
actual="$(node -e 'const { createHash } = require("node:crypto"); process.stdout.write(createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' "$download/$file")"
if [[ "$actual" != "$expected" ]]; then
  echo "::error::$release/$file does not match its pinned digest: expected $expected, downloaded $actual." >&2
  exit 1
fi
chmod +x "$download/$file"
mv -f "$download/$file" "$directory/$file"
