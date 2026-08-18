#!/usr/bin/env bash
# One-shot deploy for the Executor Cloudflare host.
#
# Provisions everything a fresh account needs and deploys the Worker:
#   1. verifies wrangler is logged in
#   2. creates (or reuses) the `executor` D1 database and records its id in
#      wrangler.local.jsonc (this installation's gitignored overlay — the
#      tracked wrangler.jsonc template is never written, so upgrading is a
#      clean `git pull`; see scripts/deploy-config.ts)
#   3. generates + uploads EXECUTOR_SECRET_KEY (the at-rest secret key) if unset
#   4. deploys the Worker
#   5. prints the single manual step: configure the Cloudflare Access application
#
# Idempotent — safe to re-run, and re-running it after an upgrade is the whole
# upgrade procedure. Run from anywhere:
#   bash apps/host-cloudflare/scripts/deploy.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$APP_DIR"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }

step "Checking wrangler login"
if ! bunx wrangler whoami >/dev/null 2>&1; then
  info "Not logged in. Run: bunx wrangler login"
  exit 1
fi
info "Logged in."

step "Provisioning D1 database 'executor'"
# `d1 create` is non-idempotent (errors if it exists), so list first.
EXISTING_ID="$(bunx wrangler d1 list --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s).find(d=>d.name==="executor");process.stdout.write(r?r.uuid:"")}catch{}})')"
if [ -n "$EXISTING_ID" ]; then
  DB_ID="$EXISTING_ID"
  info "Reusing existing database: $DB_ID"
else
  CREATE_OUT="$(bunx wrangler d1 create executor 2>&1)"
  DB_ID="$(printf '%s' "$CREATE_OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
  info "Created database: $DB_ID"
fi
[ -n "$DB_ID" ] || { echo "Failed to resolve D1 database id" >&2; exit 1; }

step "Recording D1 id in wrangler.local.jsonc"
# The id belongs to this account, not to the repo, so it goes in the gitignored
# overlay; deploy-config.ts merges it over the tracked template and prints the
# generated config every wrangler command below deploys with.
CONFIG="$(bun scripts/deploy-config.ts --set-d1 "$DB_ID")"
info "wrangler.local.jsonc -> $DB_ID"
info "deploying with $(basename "$CONFIG")"

step "Ensuring EXECUTOR_SECRET_KEY secret"
if bunx wrangler secret list --config "$CONFIG" 2>/dev/null | grep -q EXECUTOR_SECRET_KEY; then
  info "Secret already set — leaving it."
else
  SECRET="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
  printf '%s' "$SECRET" | bunx wrangler secret put EXECUTOR_SECRET_KEY --config "$CONFIG" >/dev/null
  info "Generated + uploaded a fresh 32-byte key."
fi

step "Building the web SPA"
bunx vite build

step "Deploying Worker"
bunx wrangler deploy --config "$CONFIG"

cat <<'NEXT'

==> One manual step left: turn on Cloudflare Access (the auth layer)

  The Worker is deployed but is not ready to serve requests until you configure
  a Cloudflare Access application. API and MCP requests return 503 and name the
  missing variables until configuration is complete. In the Zero Trust
  dashboard:

    1. Access -> Applications -> Add an application -> Self-hosted
    2. Application domain: executor-cloudflare.<your-subdomain>.workers.dev
    3. Add an Access policy (e.g. "Emails ending in @yourcompany.com")
    4. After saving, copy the Application Audience (AUD) tag, then set:
       bunx wrangler deploy --var ACCESS_AUD:<aud> \
         --var ACCESS_TEAM_DOMAIN:<your-team>.cloudflareaccess.com \
         --var ADMIN_EMAILS:<admin@example.com>

  Wrangler preserves these live variables during later code deploys.

  That's it. Visiting the Worker URL now prompts a Cloudflare Access login,
  and the Worker validates the issued JWT on every request.

NEXT
