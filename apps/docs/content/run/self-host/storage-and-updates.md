---
title: Storage, backups, and updates
description: "Back up self-host data and key volumes, understand Update available checks, upgrade the Docker container safely, and move from a local Executor."
---

Self-hosted Executor stores persistent state and generated key files in `/app/data` (with the live product database in `/app/data/product` in the Docker image) and keeps optional telemetry separately in `/app/motel-data` (**Self-host** only).

Before upgrading, stop the container, back up the `/app/data` volume into a private directory, pull the target release tag from **How to update**, remove only the stopped container (`docker rm executor-v2`), and recreate it with that tag plus all of your original volume mounts and environment variables.

**Prerequisites:** Docker host access to your self-host container and volumes. In the dashboard, only organization `owner` and `admin` roles see the **Update available** notice.

**You'll know it worked when** the recreated container logs `Executor is ready at <BETTER_AUTH_URL>`, `/health` returns `{"status":"ok"}`, and your existing apps and accounts remain intact.

## Volumes and key files

| Mount path | Default volume | What it stores |
| --- | --- | --- |
| `/app/data` | `executor-v2-data` (or `pglite-data` in Compose) | Live product database (`/app/data/product`), app source and builds, app data, and the default `auth-secret.key` and `encryption.key` files. |
| `/app/motel-data` | Container filesystem (ephemeral unless mounted) | Bundled telemetry collector storage (`EXECUTOR_MOTEL_DATA_DIR`, named historically from Motel). Must be separate from `/app/data`. |

### Back up `/app/data` and keys

Back up the entire `/app/data` volume while the container is stopped (or using an atomic filesystem/volume snapshot):

- **Volume keys:** The default `auth-secret.key` and `encryption.key` files use POSIX mode `0600`. Host and Docker administrators can read the volume. Keep volume backups encrypted and private.
- **Supplied keys:** If you provide `EXECUTOR_ENCRYPTION_KEY` or `BETTER_AUTH_SECRET`, keep those values with your backup and supply them at startup. The account encryption key is a 64-character hexadecimal value. The separate auth secret needs at least 32 characters. Changing it invalidates existing session cookies.

Keep the whole `/app/data` volume and its original encryption key. A different key with a valid format can start the server and leave existing account credentials unreadable.

### Telemetry storage (`/app/motel-data`)

By default, replacing the container discards stored telemetry. Mount a separate volume at `/app/motel-data` if you want traces to survive upgrades.

By default, the bundled collector expires telemetry seven days after the last write and evicts older data to stay near its 1 GiB store limit. The bounded ingest queue can refuse new exports. Inspect queue limits and refusal counts with `docker exec executor-v2 executor-host telemetry /api/ingest`.

If you upgraded from an older image that ran Motel and mounted a persistent `/app/motel-data` volume, its legacy `motel` subdirectory (up to ~1 GiB) is no longer read or removed automatically. After confirming the mount is the intended one, delete that subdirectory with:

```bash
docker exec executor-v2 rm -rf /app/motel-data/motel
```

## Updates

### Daily update check (`Update available`)

Self-host checks daily whether a newer Executor release exists and shows organization `owner` and `admin` users an **Update available** tag at the bottom of the sidebar with a **How to update to v\<version\>** button that opens the **How to update** dialog. Regular `member` users see nothing.

How the check works:

- Sends a `GET` request to the configured npm registry's dist-tags URL without authentication or installation identifiers.
- Follows no redirects, ignores proxy environment variables, and uses a five-second timeout.
- The stored attempt normally prevents another check for 24 hours.
- Beta images compare against newer betas and newer stable releases; stable images compare against stable releases only.
- Disable the check completely with `EXECUTOR_NO_UPDATE_CHECK=1`.

### Upgrade the Docker container

In the block below, replace `2.0.0-beta.79` on the `TARGET_VERSION=` line with the tag shown in **How to update**. The example uses the loopback quick start's container and volume names. Adapt it to use your existing data volume and preserve your original environment and mounts, including any separate telemetry volume.

```bash
(
  set -euo pipefail
  TARGET_VERSION="2.0.0-beta.79"
  TARGET_IMAGE="ghcr.io/usefulsoftwareco/executor-selfhost:${TARGET_VERSION}"

  docker volume inspect executor-v2-data > /dev/null
  docker stop executor-v2

  umask 077
  BACKUP_DIR=$(mktemp -d)
  BACKUP_ARCHIVE="$BACKUP_DIR/executor-v2-data-backup.tgz"
  if ! docker run --rm -v executor-v2-data:/data:ro alpine \
    tar czf - -C /data . > "$BACKUP_ARCHIVE" || [[ ! -s "$BACKUP_ARCHIVE" ]]; then
    rm -f "$BACKUP_ARCHIVE"
    printf 'Backup failed. The stopped container and data volume are still in place.\n' >&2
    exit 1
  fi
  printf 'Backup archive: %s\n' "$BACKUP_ARCHIVE"

  docker pull "$TARGET_IMAGE"
  docker rm executor-v2
  docker run -d --name executor-v2 --init --restart unless-stopped \
    -p 127.0.0.1:4400:4400 -v executor-v2-data:/app/data \
    "$TARGET_IMAGE"
)
```

If the backup or pull fails, fix the failure before recreating the container. The stopped container and its volume are available to restart with `docker start executor-v2`. Save the printed archive path and encrypt the archive before copying it to long-term storage.

You'll know it worked when `docker logs -f executor-v2` prints `Executor is ready at ...` and `curl -sf http://127.0.0.1:4400/health` returns `{"status":"ok"}`.

To test or restore a backup, enter the archive path printed above. Docker assigns a new volume name on each run:

```bash
(
  set -euo pipefail
  read -r -p 'Backup archive path: ' BACKUP_ARCHIVE
  test -s "$BACKUP_ARCHIVE"
  RESTORE_VOLUME=$(docker volume create)
  printf 'Restore volume: %s\n' "$RESTORE_VOLUME"
  docker run --rm -i -v "$RESTORE_VOLUME:/data" alpine \
    tar xzf - -C /data < "$BACKUP_ARCHIVE"
)
```

Mount the printed volume at `/app/data` on a container with your original environment overrides. Keep access private while you verify the restore. Check that `/health` returns `{"status":"ok"}` and an existing account can sign in.

## Move from a local Executor

A self-hosted server starts empty. Data is not copied automatically from a **Local** Executor or from Executor 1, and both instances keep running independently.

1. **Add your apps again.** Install catalog apps from **Add app** in the self-host dashboard. To deploy custom apps with CLI `2.0.0-beta.79`, sign in for app commands against your self-host origin (and sign in separately with `executor login` if you also use shell tool commands or `executor mcp`):

   ```bash
   HOST="https://executor.example.com" # replace with your self-host origin
   executor apps login --host "$HOST"
   executor apps list --host "$HOST"
   # Optional, for shell tool commands and executor mcp:
   executor login --host "$HOST"
   ```

2. **Connect your accounts again.** Connect each account from its app's page on the new instance.
3. **Back up the new server.** Snapshot the `/app/data` volume together with any supplied keys.
4. **Replace each MCP client's old entry.** Remove or replace the old local or Executor 1 entry using the same client configuration and scope where you added it:
   - Codex: `codex mcp remove executor`, then add `<your origin>/mcp` (see [Add an MCP client](/docs/mcp-clients)).
   - Claude Code: `claude mcp remove executor` (or pass the `--scope` you originally used, such as `--scope user`), then add `<your origin>/mcp`.
5. **Start a new client session.** Most MCP clients load server definitions only when a session starts.
6. **Verify it works.** Ask your agent to [search the tools](/docs/mcp-clients#check-that-it-worked) and call one read-only tool from an app you added.

## Limits

- Do not mount `/app/motel-data` inside `/app/data`; they must remain separate directories.
- Restore the entire `/app/data` volume with its original encryption key.
- After moving from **Local** to **Self-host**, reconnect the provider accounts you want to use.

## Related

- [Self-host with Docker](/docs/run/self-host)
- [Deploy, proxy, and tune self-host](/docs/run/self-host/deploy)
- [Sign-in and OIDC SSO](/docs/run/self-host/sign-in-and-sso)
- [Tracing](/docs/run/tracing)
- [Add an MCP client](/docs/mcp-clients)
- [Upgrade and migrate from Executor 1](/docs/run/cli/upgrade)
