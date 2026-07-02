#!/usr/bin/env bash
# Film a scenario on the Desk (one virtual desktop, one recording).
#   e2e/desk/run.sh [scenario-path] [project]
# First run builds the image and fills the node_modules volume; later runs
# reuse both.
set -euo pipefail
cd "$(dirname "$0")/../.."

docker build -t executor-e2e-desk e2e/desk

docker run --rm \
  -v "$PWD":/repo \
  -v executor-desk-node-modules:/repo/node_modules \
  -v executor-desk-bun-cache:/root/.bun/install/cache \
  -e DESK_SCENARIO="${1:-scenarios/connect-handoff-session.test.ts}" \
  -e DESK_PROJECT="${2:-cloud}" \
  executor-e2e-desk
