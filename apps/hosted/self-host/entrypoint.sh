#!/bin/sh
set -eu

# Railway mounts fresh volumes as root. Prepare only the mount directory, never
# recursively change ownership of existing data, then drop privileges.
if [ "$(id -u)" = 0 ]; then
  data_dir="${EXECUTOR_DATA_DIR:-/app/data}"
  if [ -L "$data_dir" ]; then
    echo 'EXECUTOR_DATA_DIR must not be a symbolic link.' >&2
    exit 1
  fi
  mkdir -p "$data_dir"
  chown --no-dereference node:node "$data_dir"
  chmod 700 "$data_dir"
  exec gosu node "$@"
fi
exec "$@"
