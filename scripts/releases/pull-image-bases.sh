#!/usr/bin/env bash
# Pulls the images the self-host Dockerfile builds from, and any extra image named as an argument,
# for linux/<arch>, retrying each pull a bounded number of times, so a registry's brief outage does
# not fail the build that follows, which then finds them locally.
#
#   pull-image-bases.sh <arch> [image...]
set -euo pipefail

arch=$1
shift
dockerfile=apps/hosted/self-host/Dockerfile
# FROM images, and COPY --from images, which name a registry image rather than a stage.
mapfile -t images < <(
  {
    sed -nE 's/^FROM[[:space:]]+([^[:space:]]+).*/\1/p' "$dockerfile"
    sed -nE 's/^COPY[[:space:]]+(--[^[:space:]]+[[:space:]]+)*--from=([^[:space:]]+).*/\2/p' "$dockerfile" | grep -E '[:/@]'
  } | sort -u
)
for image in "${images[@]}" "$@"; do
  for attempt in 1 2 3 4; do
    if docker pull --quiet --platform "linux/$arch" "$image"; then break; fi
    if [[ "$attempt" == 4 ]]; then
      echo "::error::Pulling $image failed four times." >&2
      exit 1
    fi
    sleep $((attempt * 15))
  done
done
