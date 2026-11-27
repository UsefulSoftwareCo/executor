#!/usr/bin/env bash
# Run emulators.dev inside a CI job, so the required E2E checks do not depend on the shared hosted
# emulator: on 24 Nov 2026 its Durable Objects' p99 wall time went from about 0.3 s to 6 s while
# one run's scenarios called it, and six scenarios failed on a correct product.
#
#   scripts/ci/emulators.sh bundle <dir>   build the emulate-hosts Worker at the commit
#                                          e2e/emulate.json pins into <dir>/worker.js
#   scripts/ci/emulators.sh start <dir>    serve <dir>/worker.js as https://emulators.dev and
#                                          its service hosts on this runner
#
# It is the same Worker emulators.dev runs (UsefulSoftwareCo/emulate, packages/@emulators/cloudflare),
# reached at the same names over HTTPS, so scenarios, harness and product use the URLs they always
# do. `start` makes a CA for this job alone and a certificate for emulators.dev and *.emulators.dev,
# and adds the CA to every store the job's processes read: NODE_EXTRA_CA_CERTS (the harness, Node
# and Bun, and workerd, which miniflare and the self-host runtime configure from it), the system
# store, and Chrome's NSS database. Nothing turns TLS verification off. The names point at
# 127.0.0.1 through /etc/hosts. Only an ephemeral provider runner may run `start`: it edits the
# machine's hosts file and trust stores.
set -euo pipefail
# The CA, certificate and server log; a failed job uploads only server.log (checks.yml).
state="$(realpath -m .local/emulators)"
case "${1:-}" in
  bundle)
    out="$(realpath -m "${2:?Usage: scripts/ci/emulators.sh bundle <dir>}")"
    repository="$(jq -er .repository e2e/emulate.json)"
    commit="$(jq -er .commit e2e/emulate.json)"
    pnpm="$(jq -er .pnpm e2e/emulate.json)"
    # Emulate's lockfile does not hold Wrangler for this package, so the version is pinned here.
    wrangler="$(jq -er .wrangler e2e/emulate.json)"
    source="$(mktemp -d)"
    curl -fsSL --retry 3 "https://codeload.github.com/$repository/tar.gz/$commit" |
      tar -xz -C "$source" --strip-components=1
    (
      cd "$source"
      npx -y "pnpm@$pnpm" install --frozen-lockfile --reporter=silent
      npx -y "pnpm@$pnpm" turbo build --filter '@emulators/cloudflare...' --output-logs=errors-only
      cd packages/@emulators/cloudflare
      npx -y "wrangler@$wrangler" deploy --dry-run --outdir "$source/bundle" > /dev/null
    )
    mkdir -p "$out"
    cp "$source/bundle/worker.js" "$out/worker.js"
    # The service hosts it serves, so `start` can point every name at the runner before anything
    # else: a start that fails then leaves the names unreachable rather than on the hosted service.
    node scripts/ci/emulators-server.ts --services "$out/worker.js" "$out/services"
    echo "$commit" > "$out/commit"
    rm -rf "$source"
    echo "Built emulate-hosts at $commit: $(du -h "$out/worker.js" | cut -f1)."
    ;;
  start)
    bundle="$(realpath "${2:?Usage: scripts/ci/emulators.sh start <dir>}")"
    mkdir -p "$state"
    openssl req -x509 -newkey rsa:2048 -nodes -days 2 -keyout "$state/ca.key" -out "$state/ca.pem" \
      -subj "/CN=Executor CI emulators ${GITHUB_RUN_ID:-local}" \
      -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" 2> /dev/null
    openssl req -newkey rsa:2048 -nodes -keyout "$state/leaf.key" -out "$state/leaf.csr" \
      -subj "/CN=emulators.dev" 2> /dev/null
    printf 'subjectAltName=DNS:emulators.dev,DNS:*.emulators.dev\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n' \
      > "$state/leaf.ext"
    openssl x509 -req -in "$state/leaf.csr" -CA "$state/ca.pem" -CAkey "$state/ca.key" \
      -CAcreateserial -days 2 -extfile "$state/leaf.ext" -out "$state/leaf.pem" 2> /dev/null
    # Every name to this runner first: if anything below fails, the job's scenarios cannot reach the
    # hosted emulators.dev instead; their calls are refused here.
    {
      echo "127.0.0.1 emulators.dev"
      sed 's/^\(.*\)$/127.0.0.1 \1.emulators.dev/' "$bundle/services"
    } | sudo tee -a /etc/hosts > /dev/null
    # 443 without running the server as root.
    sudo sysctl -q net.ipv4.ip_unprivileged_port_start=443
    rm -f "$state/services"
    nohup node scripts/ci/emulators-server.ts "$bundle/worker.js" "$state" > "$state/server.log" 2>&1 &
    echo "$!" > "$state/pid"
    for _ in $(seq 100); do
      [ -s "$state/services" ] && break
      kill -0 "$(cat "$state/pid")" 2> /dev/null || { cat "$state/server.log"; exit 1; }
      sleep 0.1
    done
    [ -s "$state/services" ] || { echo "The emulators did not start within 10 s."; cat "$state/server.log"; exit 1; }
    cmp -s "$state/services" "$bundle/services" ||
      { echo "The running Worker serves other hosts than the bundle listed."; exit 1; }
    sudo cp "$state/ca.pem" /usr/local/share/ca-certificates/executor-ci-emulators.crt
    sudo update-ca-certificates > /dev/null
    command -v certutil > /dev/null ||
      sudo apt-get install -y -qq --no-install-recommends libnss3-tools > /dev/null
    mkdir -p "$HOME/.pki/nssdb"
    [ -f "$HOME/.pki/nssdb/cert9.db" ] || certutil -d "sql:$HOME/.pki/nssdb" -N --empty-password
    certutil -d "sql:$HOME/.pki/nssdb" -A -t "C,," -n executor-ci-emulators -i "$state/ca.pem"
    echo "NODE_EXTRA_CA_CERTS=$state/ca.pem" >> "${GITHUB_ENV:-/dev/null}"
    # Ready when an instance can be created over the real name, with verification on, and that
    # instance's Durable Object answers: creating it alone touches no storage.
    instance="$(curl -fsS --max-time 30 --cacert "$state/ca.pem" -X POST -H 'content-type: application/json' \
      -d '{"instance":"ready"}' https://autumn.emulators.dev/_emulate/instances | jq -er .providerBaseUrl)"
    curl -fsS --max-time 30 --cacert "$state/ca.pem" -X POST -H 'content-type: application/json' \
      -d '{"type":"api-key"}' "$instance/_emulate/credentials" > /dev/null
    echo "emulators.dev runs on this runner: emulate $(cat "$bundle/commit"), $(wc -l < "$state/services") service hosts."
    ;;
  *)
    echo "Usage: scripts/ci/emulators.sh bundle <dir> | start <dir>" >&2
    exit 2
    ;;
esac
