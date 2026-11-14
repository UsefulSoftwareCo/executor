#!/usr/bin/env bash
# Pin the digests of a published locked-down Bun runtime release, for fetch.sh. Run it once after
# bun-runtime.yml publishes a release for a changed lockdown patch, and commit SHA256SUMS:
#
#   bash scripts/releases/bun-runtime/pin.sh bun-runtime-<version>-<patch hash>
#
# A release's name says which patch it was built for, not which build published it first, so this
# prints what the reviewer of the pin needs: who published the release, the commit it was built
# from, and how that commit's build inputs differ from this checkout's. It refuses a release whose
# assets GitHub reports with digests other than the release's SHA256SUMS, or that changed after the
# release was published.
set -euo pipefail
release="$1"
here="$(dirname "$0")"
pins="$here/SHA256SUMS"
repository="${GITHUB_REPOSITORY:-UsefulSoftwareCo/executor-next}"
# The files that decide the runtime's bytes: the patch, the toolchain and the build's settings.
inputs=(
  scripts/releases/bun-runtime/lockdown.patch
  scripts/releases/bun-runtime/setup-linux.sh
  .github/workflows/bun-runtime.yml
)

metadata="$(gh api "repos/$repository/releases/tags/$release")"
sums="$(gh release download "$release" --repo "$repository" --pattern SHA256SUMS --output -)"
# Checks the assets against SHA256SUMS and the publication time; prints the author and target.
checked="$(
  node -e '
    const [metadata, sums] = [JSON.parse(process.argv[1]), process.argv[2]];
    const listed = new Map(
      sums.trim().split("\n").map((line) => line.trim().split(/\s+/)).map(([d, f]) => [f.replace(/^\*/, ""), d]),
    );
    const assets = metadata.assets.filter((asset) => asset.name !== "SHA256SUMS");
    const problems = [];
    for (const asset of metadata.assets)
      if (Date.parse(asset.updated_at) > Date.parse(metadata.published_at))
        problems.push(`${asset.name} was updated at ${asset.updated_at}, after the release was published at ${metadata.published_at}.`);
    for (const asset of assets) {
      const digest = (asset.digest ?? "").replace(/^sha256:/, "");
      if (listed.get(asset.name) !== digest)
        problems.push(`${asset.name}: GitHub reports ${digest || "no digest"}, SHA256SUMS lists ${listed.get(asset.name) ?? "nothing"}.`);
    }
    for (const name of listed.keys())
      if (!assets.some((asset) => asset.name === name)) problems.push(`SHA256SUMS lists ${name}, which is not an asset.`);
    if (metadata.draft || !metadata.published_at) problems.push("The release is not published.");
    if (problems.length > 0) {
      for (const problem of problems) console.error(`::error::${problem}`);
      process.exit(1);
    }
    console.log(`${metadata.author.login} ${metadata.target_commitish}`);
  ' "$metadata" "$sums"
)"
read -r author target <<<"$checked"
tagged="$(gh api "repos/$repository/git/ref/tags/$release" --jq '.object.sha')"
if [[ "$tagged" != "$target" ]]; then
  echo "::error::$release's tag points to $tagged, not to its target $target." >&2
  exit 1
fi

echo "$release was published by $author from commit $target."
git cat-file -e "$target^{commit}" 2>/dev/null || git fetch --quiet origin "$target"
if git diff --quiet "$target" HEAD -- "${inputs[@]}"; then
  echo "Its build inputs are the same as this checkout's: ${inputs[*]}."
else
  echo "Its build inputs differ from this checkout's. Check that the difference cannot change what was built:"
  git --no-pager diff --stat "$target" HEAD -- "${inputs[@]}"
  git --no-pager diff "$target" HEAD -- "${inputs[@]}"
fi

lines="$(awk -v release="$release" 'NF == 2 { sub(/^\*/, "", $2); print $1 "  " release "/" $2 }' <<<"$sums")"
{ grep -v "  $release/" "$pins" || true; printf '%s\n' "$lines"; } | sort -k2 > "$pins.new"
mv "$pins.new" "$pins"
echo "Pinned $release in $pins:"
printf '%s\n' "$lines"
