#!/usr/bin/env bash
# Smoke-tests a patched Bun runtime on the platform it was built for.
# Compiles a probe app with the runtime as --compile-executable-path and
# checks that the compiled app ignores the lockdown environment variables,
# while plain `bun` still honours them.
#
# Usage: smoke.sh <path-to-patched-bun>
set -euo pipefail

bun="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
work="$(mktemp -d)"
cd "$work"
exe=""
sep=":"
case "$(uname -s)" in MINGW* | MSYS* | CYGWIN*) exe=".exe" sep=";" ;; esac

fail() { echo "FAIL: $*" >&2; exit 1; }
expect_eq() { [ "$1" = "$2" ] || fail "$3: expected '$2', got '$1'"; }

version="$("$bun" --version)"
echo "runtime: $version ($("$bun" --revision))"

mkdir -p disk np/bufferutil
cat > probe.js <<'EOF'
const path = require("node:path");
const r = { execArgv: process.execArgv, argv: process.argv.slice(2) };
if (process.env.PROBE_DIR) r.bufferutil = require(path.join(process.env.PROBE_DIR, "loader.cjs")).bufferutil;
console.log(JSON.stringify(r));
EOF
cat > disk/loader.cjs <<'EOF'
let bufferutil = "absent";
try { require("bufferutil"); bufferutil = "loaded"; } catch {}
module.exports = { bufferutil };
EOF
echo 'console.log("NODE_PATH PAYLOAD RAN");' > np/bufferutil/index.js
echo 'console.log("PRELOAD RAN");' > preload.mjs

"$bun" build --compile --compile-executable-path="$bun" \
  --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
  probe.js --outfile "probe$exe"
app="./probe$exe"

expect_eq "$("$app" a --version)" '{"execArgv":[],"argv":["a","--version"]}' "plain run"
expect_eq "$(BUN_BE_BUN=1 "$app" --version)" '{"execArgv":[],"argv":["--version"]}' "BUN_BE_BUN"
expect_eq "$(BUN_OPTIONS="--preload ./preload.mjs" "$app" a)" '{"execArgv":[],"argv":["a"]}' "BUN_OPTIONS"
expect_eq "$(BUN_INSPECT_PRELOAD=./preload.mjs "$app" a)" '{"execArgv":[],"argv":["a"]}' "BUN_INSPECT_PRELOAD"
expect_eq "$(BUN_JSC_thisOptionDoesNotExist=1 "$app" a)" '{"execArgv":[],"argv":["a"]}' "BUN_JSC_*"
expect_eq "$(PROBE_DIR="$work/disk" NODE_PATH="$work/np" "$app")" \
  '{"execArgv":[],"argv":[],"bufferutil":"absent"}' "NODE_PATH"

# Plain bun is unchanged.
plain="$(BUN_OPTIONS="--preload ./preload.mjs" "$bun" -e 'console.log("main")')"
expect_eq "$plain" "PRELOAD RAN
main" "plain bun BUN_OPTIONS"
plain="$(PROBE_DIR="$work/disk" NODE_PATH="$work/np${sep}" "$bun" probe.js)"
case "$plain" in *'"bufferutil":"loaded"'*) ;; *) fail "plain bun NODE_PATH: $plain" ;; esac

echo "smoke ok: $bun"
