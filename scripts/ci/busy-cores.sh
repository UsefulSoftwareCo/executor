#!/usr/bin/env bash
# Keep half of the runner's cores busy while a repeat of a ready pull request's changed scenarios
# runs under load (e2e/repeat-scope.ts), and stop them again.
#
#   scripts/ci/busy-cores.sh start   starts one busy loop per two cores, recording their PIDs
#   scripts/ci/busy-cores.sh stop    stops the loops it recorded, and says how many
#
# The loops are this job's own processes: `stop` runs as the job's last step, whatever came
# before, and kills only the PIDs `start` recorded; the runner also ends a job's orphans.
set -euo pipefail
pids="${RUNNER_TEMP:-/tmp}/busy-cores.pids"
case "${1:-}" in
  start)
    : > "$pids"
    for _ in $(seq $(( $(nproc) / 2 ))); do
      (while :; do :; done) > /dev/null 2>&1 &
      echo "$!" >> "$pids"
    done
    echo "Started $(wc -l < "$pids") busy loops on $(nproc) cores."
    ;;
  stop)
    if [ ! -s "$pids" ]; then
      echo "No busy loops were started."
      exit 0
    fi
    stopped=0
    while read -r pid; do
      if kill "$pid" 2> /dev/null; then stopped=$((stopped + 1)); fi
    done < "$pids"
    rm -f "$pids"
    echo "Stopped $stopped busy loops."
    ;;
  *)
    echo "Usage: scripts/ci/busy-cores.sh start | stop" >&2
    exit 2
    ;;
esac
