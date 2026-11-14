#!/usr/bin/env bash
# Runs one long build in the background of a Linux job, so the steps after it run meanwhile, and
# waits for it in a later step, which prints its output and fails with its exit code.
#
#   background.sh start <name> <command...>
#   background.sh wait <name>
#
# The build writes to $RUNNER_TEMP/background/<name>/output.log, never to the step's own output,
# so the starting step ends at once. The runner ends anything still running when the job ends.
set -euo pipefail

action=$1
name=$2
shift 2
directory="${RUNNER_TEMP:?}/background/$name"
case "$action" in
  start)
    mkdir -p "$directory"
    (
      set +e
      "$@"
      echo $? > "$directory/status"
    ) > "$directory/output.log" 2>&1 < /dev/null &
    echo $! > "$directory/pid"
    echo "Started $name in the background."
    ;;
  wait)
    started=$(date +%s)
    tail --pid="$(cat "$directory/pid")" -f /dev/null
    cat "$directory/output.log"
    echo "Waited $(($(date +%s) - started)) s for $name."
    exit "$(cat "$directory/status")"
    ;;
  *)
    echo "Usage: background.sh start <name> <command...> | wait <name>" >&2
    exit 2
    ;;
esac
