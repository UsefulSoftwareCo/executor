#!/usr/bin/env bash
# Moves Docker onto an empty data directory of this job's own, and back again at the end.
#
#   own-docker-store.sh own <daemon.json>
#     Saves <daemon.json> (or that there is none), Docker's data directory and its images, then
#     restarts Docker on $RUNNER_TEMP/docker-store with the daemon's other settings kept. It fails
#     unless Docker then runs on that directory with no images, containers, volumes or build cache,
#     and keeps its images there rather than in containerd's store. Everything a later step builds
#     from or runs is then pulled in this job. A <daemon.json> that is not one JSON object stops it
#     before anything changes.
#
#   own-docker-store.sh restore <daemon.json>
#     Puts back the saved <daemon.json> byte for byte (or removes it if there was none), restarts
#     Docker, and fails unless Docker runs on its original data directory with the images it had
#     before. The runner's teardown then finds the store as the job found it, with nothing this
#     job pulled or built in it. With nothing saved, Docker was never moved and this does nothing.
#     With RELEASE_PUBLISH=true and DIGEST_UPLOAD=success, which a publishing run sets once it has
#     pushed this architecture and uploaded its digest, a failure is reported as a warning and the
#     script exits 0, so the release publishes what it pushed. Otherwise a failure fails it.
#
# Each wait for Docker is bounded by DOCKER_START_TIMEOUT seconds (120 by default).
set -Eeuo pipefail

mode=$1
config=$2
if [[ "$mode" == restore && "${RELEASE_PUBLISH:-}" == true && "${DIGEST_UPLOAD:-}" == success ]]; then
  status=0
  RELEASE_PUBLISH="" DIGEST_UPLOAD="" ANNOTATION=warning bash "${BASH_SOURCE[0]}" restore "$config" || status=$?
  if ((status != 0)); then
    echo "::warning title=Runner Docker store not restored::Putting Docker back on the runner's own store failed (own-docker-store.sh restore exited $status), so the runner's Docker store was not restored. This architecture's image is pushed and its digest uploaded, so the release continues." >&2
  fi
  exit 0
fi
level=${ANNOTATION:-error}
own="$RUNNER_TEMP/docker-store"
saved="$RUNNER_TEMP/docker-store-original"
wait=${DOCKER_START_TIMEOUT:-120}
started=$(date +%s%N)
ms() { echo $((($(date +%s%N) - started) / 1000000)); }
fail() {
  echo "::$level::$*" >&2
  exit 1
}
trap 'status=$?; echo "::$level::own-docker-store.sh $mode: \`$BASH_COMMAND\` exited $status" >&2' ERR
candidate=""
trap '[[ -z "$candidate" ]] || sudo rm -f "$candidate"' EXIT

images() { docker image ls -aq --no-trunc | sort -u; }
listed() {
  echo "::group::$1"
  docker image ls -a --format '{{.ID}} {{.Repository}}:{{.Tag}}'
  echo "::endgroup::"
}

within() { if (($1 == 124)); then echo "within $wait s"; else echo "(systemctl exited $1)"; fi; }

restart() {
  local status=0
  sudo timeout "$wait" systemctl stop docker.socket docker.service || status=$?
  ((status == 0)) || fail "Docker did not stop $(within "$status")"
  sudo timeout "$wait" systemctl start docker.service || status=$?
  if ((status != 0)); then
    sudo journalctl -u docker.service --no-pager | tail -30 >&2
    fail "Docker did not start on $1 $(within "$status")"
  fi
  local deadline=$((SECONDS + wait))
  until timeout 10 docker info >/dev/null 2>&1; do
    if ((SECONDS >= deadline)); then
      sudo journalctl -u docker.service --no-pager | tail -30 >&2
      fail "Docker started on $1 but did not answer within $wait s"
    fi
    sleep 1
  done
}

case "$mode" in
  own)
    if sudo test -e "$config"; then
      sudo jq -s -e 'length <= 1 and all(type == "object")' "$config" >/dev/null 2>&1 ||
        fail "$config is not one JSON object; it is left as it is and Docker is not restarted"
    fi
    root=$(docker info --format '{{.DockerRootDir}}')
    [[ -n "$root" ]] || fail "Docker reported no data directory"
    sudo rm -rf "$saved"
    mkdir -p "$saved"
    if sudo test -e "$config"; then
      sudo cp -p "$config" "$saved/daemon.json"
    else
      touch "$saved/absent"
    fi
    images >"$saved/images"
    echo "$root" >"$saved/root"
    echo "Docker ran on $root with $(wc -l <"$saved/images") images"
    listed "The images on $root before this job"

    sudo mkdir -p "$own" "$(dirname "$config")"
    candidate=$(sudo mktemp "$config.XXXXXX")
    if [[ -e "$saved/absent" ]]; then
      sudo chmod 644 "$candidate"
      jq -n --arg own "$own" '{"data-root": $own}' | sudo tee "$candidate" >/dev/null
    else
      sudo cp -p "$config" "$candidate"
      echo "Daemon settings kept: $(sudo jq -s -c '(.[0] // {}) | del(.["data-root"]) | keys' "$config")"
      sudo jq -s --arg own "$own" '(.[0] // {}) | .["data-root"] = $own' "$config" | sudo tee "$candidate" >/dev/null
    fi
    sudo jq -s -e --arg own "$own" 'length == 1 and .[0]["data-root"] == $own' "$candidate" >/dev/null ||
      fail "the new $config does not set data-root to $own"
    sudo mv -f "$candidate" "$config"
    candidate=""

    restart "$own"
    root=$(docker info --format '{{.DockerRootDir}}')
    driver=$(docker info --format '{{.Driver}}')
    status=$(docker info --format '{{json .DriverStatus}}')
    counts=$(docker system df --format '{{.Type}}={{.TotalCount}}' | paste -sd ' ')
    echo "Docker runs on $root ($driver $status): $counts"
    if [[ "$root" != "$own" || -z "$driver" || "$driver $status" == *containerd* || "$counts" != "Images=0 Containers=0 Local Volumes=0 Build Cache=0" ]]; then
      fail "Docker does not run on an empty store of this job's own"
    fi
    echo "Restarted on an empty $own in $(ms) ms, $(df -h --output=avail "$own" | tail -1 | tr -d ' ') free"
    ;;
  restore)
    if [[ ! -s "$saved/root" ]]; then
      echo "Docker was not moved off its own data directory in this job; nothing to restore"
      exit 0
    fi
    root=$(cat "$saved/root")
    if [[ -e "$saved/absent" ]]; then
      sudo rm -f "$config"
      ! sudo test -e "$config" || fail "$config is still there, and there was none before this job"
      echo "Removed $config, which this job created"
    else
      candidate=$(sudo mktemp "$config.XXXXXX")
      sudo cp -p "$saved/daemon.json" "$candidate"
      sudo mv -f "$candidate" "$config"
      candidate=""
      sudo cmp -s "$saved/daemon.json" "$config" || fail "$config differs from the one this job saved"
      echo "Put back $config as this job found it"
    fi
    restart "$root"
    now=$(docker info --format '{{.DockerRootDir}}')
    images >"$saved/images-after"
    echo "Docker runs on $now again with $(wc -l <"$saved/images-after") images, in $(ms) ms"
    listed "The images on $now after this job"
    [[ "$now" == "$root" ]] || fail "Docker runs on $now, not on its original data directory $root"
    if ! cmp -s "$saved/images" "$saved/images-after"; then
      diff "$saved/images" "$saved/images-after" >&2 || true
      fail "Docker on $root holds other images than it did before this job"
    fi
    echo "Docker is back on $root with the $(wc -l <"$saved/images") images it had before this job"
    ;;
  *)
    fail "usage: own-docker-store.sh own|restore <daemon.json>"
    ;;
esac
