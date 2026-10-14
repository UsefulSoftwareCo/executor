#!/bin/sh
# Check a release install with no Node or Bun on PATH and an isolated data directory: it prints
# its version, starts the server, restarts with the keys it saved, pairs, loads the dashboard,
# then creates, commits and deploys an app with a binary ui/public file through `executor apps`
# and calls its tool. A blank Linux machine has no Secret Service, so keys go to keys.json; on
# macOS the first start saves them in the login Keychain, and the script removes that item on
# exit and prints its name.
#
#   scripts/releases/standalone-smoke.sh <path to executor> [port]
set -eu

executable="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
port="${2:-4620}"
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
if command -v node >/dev/null 2>&1 || command -v bun >/dev/null 2>&1; then
  echo "node or bun is still on PATH" >&2
  exit 1
fi
work="$(mktemp -d "${TMPDIR:-/tmp}/executor-smoke.XXXXXX")"
# EXECUTOR_KEY_STORAGE=file keeps keys out of the OS store.
unset NODE_OPTIONS BUN_OPTIONS EXECUTOR_API_KEY EXECUTOR_ENCRYPTION_KEY 2>/dev/null || true
EXECUTOR_DATA_DIR="$work/data"
EXECUTOR_PORT="$port"
EXECUTOR_NO_UPDATE_CHECK=1
DO_NOT_TRACK=1
export EXECUTOR_DATA_DIR EXECUTOR_PORT EXECUTOR_NO_UPDATE_CHECK DO_NOT_TRACK
service=com.usefulsoftware.executor.v2
server=""
field() { sed -n "s/.*\"$1\": *\"\\([^\"]*\\)\".*/\\1/p" | head -n 1; }
step() { printf '\n== %s\n' "$*"; }
millis() { date +%s%N 2>/dev/null | grep -v N || echo "$(date +%s)000000000"; }
seconds() { awk "BEGIN { printf \"%.2f\", ($2 - $1) / 1000000000 }"; }

keys="$work/data"
cleanup() {
  if [ -n "$server" ]; then kill "$server" 2>/dev/null || true; wait "$server" 2>/dev/null || true; fi
  # The first data directory is the one whose keys may be in the Keychain.
  if [ "$(uname)" = Darwin ] && [ -f "$keys/installation.json" ]; then
    id="$(field id < "$keys/installation.json")"
    if security delete-generic-password -s "$service" -a "$id" >/dev/null 2>&1; then
      echo "Removed Keychain item: service $service, account $id"
    fi
  fi
}
trap cleanup EXIT INT TERM

start() {
  started="$(millis)"
  "$executable" serve > "$work/server-$1.log" 2>&1 &
  server=$!
  until grep -q "^Executor: http://127.0.0.1:$port" "$work/server-$1.log"; do
    if ! kill -0 "$server" 2>/dev/null; then cat "$work/server-$1.log"; exit 1; fi
    sleep 0.05
  done
  echo "server ready in $(seconds "$started" "$(millis)")s (pid $server)"
}
stop() {
  kill -TERM "$server"
  wait "$server" || true
  server=""
}

step "executor --version"
started="$(millis)"
"$executable" --version
echo "version in $(seconds "$started" "$(millis)")s"

step "first start saves its keys"
start first
test "$(field state < "$EXECUTOR_DATA_DIR/installation.json")" != pending
id="$(field id < "$EXECUTOR_DATA_DIR/installation.json")"
if [ -e "$EXECUTOR_DATA_DIR/keys.json" ]; then echo "keys in keys.json"; else echo "keys in the OS credential store ($service, $id)"; fi
stop

step "restart reads the same keys"
start second
test "$(field id < "$EXECUTOR_DATA_DIR/installation.json")" = "$id"
ps -o rss= -p "$server" | awk '{printf "server RSS %.0f MiB\n", $1/1024}'
stop

# The apps commands need the server's API key. Supplied keys are never saved, so this generation
# runs with its own and touches no store.
step "start with supplied keys"
EXECUTOR_DATA_DIR="$work/supplied"
EXECUTOR_API_KEY="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
EXECUTOR_ENCRYPTION_KEY="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
EXECUTOR_HOST="http://127.0.0.1:$port"
export EXECUTOR_DATA_DIR EXECUTOR_API_KEY EXECUTOR_ENCRYPTION_KEY EXECUTOR_HOST
unset EXECUTOR_KEY_STORAGE 2>/dev/null || true
start supplied

step "dashboard"
asset="$(curl -fsS "http://127.0.0.1:$port/" | grep -aoE '/assets/[^"]+\.js' | head -n 1)"
curl -fsS -o /dev/null -w "GET / 200, $asset %{http_code} %{size_download} bytes\n" "http://127.0.0.1:$port$asset"

step "executor pair"
"$executable" pair | grep -E "^http://127\.0\.0\.1:$port/#pair=[0-9a-f]{64}$" | sed 's/#pair=.*/#pair=<redacted>/'

step "executor apps"
framework="$("$executable" apps framework | field version)"
echo "apps framework $framework"
app="$work/app"
mkdir -p "$app/ui/public" "$work/initial"
cat > "$app/index.ts" <<'TS'
import { defineApp, object, query, router } from "apps";

export default defineApp({ accounts: {} }, async () => ({
  tools: router({
    hello: query({ description: "Say hello", input: object({}) }, async () => ({
      message: "Hello from a standalone install",
    })),
  }),
}));
TS
printf '{"name":"standalone-smoke","private":true,"type":"module","dependencies":{"apps":"%s"}}\n' "$framework" > "$app/package.json"
printf '<!doctype html><title>Standalone</title><img src="/public/logo.png">\n' > "$app/ui/index.html"
{ printf '\211PNG\r\n\032\n'; head -c 4096 /dev/urandom; } > "$app/ui/public/logo.png"
cp "$app/index.ts" "$app/package.json" "$work/initial/"
app_id="$("$executable" apps create --name "Standalone smoke" --files "$work/initial" | field id)"
echo "created $app_id"
first="$("$executable" apps source --app "$app_id" | field commit)"
commit="$("$executable" apps commit --app "$app_id" --files "$app" --expected "$first" --message "Add the UI" | field commit)"
"$executable" apps deploy --app "$app_id" --commit "$commit" > "$work/deploy.json"
echo "deployed commit $commit"
# deploy --files pushes binary ui/public files with the bundled Git.
head -c 8192 /dev/urandom >> "$app/ui/public/logo.png"
"$executable" apps deploy --app "$app_id" --files "$app" --message "Grow the logo" > "$work/deploy-files.json"
"$executable" apps source --app "$app_id" --out "$work/source" > /dev/null
cmp "$app/ui/public/logo.png" "$work/source/ui/public/logo.png"
echo "ui/public/logo.png round-trips byte for byte ($(wc -c < "$app/ui/public/logo.png" | tr -d ' ') bytes)"

step "call the app's tool"
curl -fsS -X POST "http://127.0.0.1:$port/v1/tools/call" \
  -H "authorization: Bearer $EXECUTOR_API_KEY" -H 'content-type: application/json' \
  -d "{\"app\":\"$app_id\",\"tool\":\"hello\",\"kind\":\"query\",\"input\":{}}" | tee "$work/call.json"
echo
grep -q 'Hello from a standalone install' "$work/call.json"
stop

echo
echo "PASS ($work)"
