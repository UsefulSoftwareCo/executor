#!/usr/bin/env bash
# One-shot deploy for the Executor Cloudflare host.
#
# Provisions everything a fresh account needs and deploys the Worker:
#   1. verifies wrangler is logged in
#   2. creates (or reuses) the `executor` D1 database and writes its id into
#      wrangler.jsonc
#   3. generates + uploads EXECUTOR_SECRET_KEY (the at-rest secret key) if unset
#   4. deploys the Worker
#   5. prints the single manual step: the Cloudflare Access application
#
# Idempotent — safe to re-run. Run from anywhere:
#   bash apps/host-cloudflare/scripts/deploy.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG="$APP_DIR/wrangler.jsonc"
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

step "Writing D1 id into wrangler.jsonc"
# Replace whatever database_id is present (placeholder or a prior id).
node -e '
  const fs=require("fs"),p=process.argv[1],id=process.argv[2];
  let t=fs.readFileSync(p,"utf8");
  t=t.replace(/("database_id":\s*")[^"]*(")/, `$1${id}$2`);
  fs.writeFileSync(p,t);
' "$CONFIG" "$DB_ID"
info "wrangler.jsonc -> $DB_ID"

step "Ensuring EXECUTOR_SECRET_KEY secret"
if bunx wrangler secret list 2>/dev/null | grep -q EXECUTOR_SECRET_KEY; then
  info "Secret already set — leaving it."
else
  SECRET="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
  printf '%s' "$SECRET" | bunx wrangler secret put EXECUTOR_SECRET_KEY >/dev/null
  info "Generated + uploaded a fresh 32-byte key."
fi

step "Building the web SPA"
bunx vite build

step "Deploying Worker"
bunx wrangler deploy

cat <<'NEXT'

==> One manual step left: turn on Cloudflare Access (the auth layer)

  The Worker is deployed but every request returns 401 until you put it behind
  a Cloudflare Access application. In the Zero Trust dashboard:

    1. Access -> Applications -> Add an application -> Self-hosted
    2. Application domain: executor-cloudflare.<your-subdomain>.workers.dev
    3. Add an Access policy (e.g. "Emails ending in @yourcompany.com")
    4. After saving, copy the Application Audience (AUD) tag, then set:
         bunx wrangler deploy --var ACCESS_AUD:<aud> \
           --var ACCESS_TEAM_DOMAIN:<your-team>.cloudflareaccess.com
       (or edit the vars in wrangler.jsonc and redeploy)

  That's it — visiting the Worker URL now prompts a Cloudflare Access login,
  and the Worker validates the issued JWT on every request.

NEXT
