#!/bin/sh
set -eu

# Railway mounts fresh volumes as root. Prepare only the mount directory, never
# recursively change ownership of existing data, then drop privileges.
if [ "$(id -u)" = 0 ]; then
  for data_dir in "${EXECUTOR_DATA_DIR:-/app/data}" "${EXECUTOR_MOTEL_DATA_DIR:-/app/motel-data}"; do
    if [ -L "$data_dir" ]; then
      echo 'Data directories must not be symbolic links.' >&2
      exit 1
    fi
    mkdir -p "$data_dir"
    chown --no-dereference executor:executor "$data_dir"
    chmod 700 "$data_dir"
  done
  exec gosu executor "$@"
fi
exec "$@"
