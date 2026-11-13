#!/usr/bin/env bash
# Puts the oldest Node the npm launcher supports, which apps/cli/package.json names, in
# <directory>/node-v<version>-linux-x64 and prints its node's path. The tarball's SHA-256 is pinned
# in oldest-node.sha256 beside this script. The workflows keep <directory> in the Actions cache,
# which main fills, so a run downloads it from nodejs.org only on a cache miss, with a bounded
# retry of that download.
#
#   oldest-node.sh <directory>
set -euo pipefail

directory=$1
version="$(node -p 'require("./apps/cli/package.json").engines.node.slice(2)')"
tarball="node-v$version-linux-x64.tar.xz"
pin="$(dirname "$0")/oldest-node.sha256"
expected="$(awk -v file="$tarball" '$2 == file { print $1 }' "$pin")"
if [[ -z "$expected" ]]; then
  echo "::error::apps/cli/package.json names Node $version, but $pin pins no checksum for $tarball. Add its line from https://nodejs.org/dist/v$version/SHASUMS256.txt." >&2
  exit 1
fi
mkdir -p "$directory"
if [[ ! -f "$directory/$tarball" ]] || [[ "$(sha256sum < "$directory/$tarball" | cut -d' ' -f1)" != "$expected" ]]; then
  curl -fsSL --retry 4 --retry-all-errors --retry-delay 10 --max-time 300 \
    -o "$directory/$tarball" "https://nodejs.org/dist/v$version/$tarball"
fi
actual="$(sha256sum < "$directory/$tarball" | cut -d' ' -f1)"
if [[ "$actual" != "$expected" ]]; then
  echo "::error::$tarball has SHA-256 $actual, not the pinned $expected." >&2
  exit 1
fi
rm -rf "$directory/node-v$version-linux-x64"
tar -xJf "$directory/$tarball" -C "$directory"
echo "$directory/node-v$version-linux-x64/bin/node"
