---
title: Desktop troubleshooting
description: "Open diagnostics logs, export a diagnostics archive with pattern-based log masking, recover from startup or key errors, and reset local data in the Executor desktop app."
---

Use the **Help** menu in the Executor desktop app (**Local** workspace) to open the diagnostics folder, export a diagnostics archive, or back up and reset local Executor data when troubleshooting startup, key, or database issues.

Choose **Help → Export diagnostics…** to save a `.zip` bundle in your Downloads folder with best-effort pattern masking applied to included log and collector files, or **Help → Reset Executor data…** to back up your data directory and start fresh.

**Prerequisites:** The Executor desktop app (`2.0.0-beta.79`) installed on macOS, Windows, or Linux.

**You'll know it worked when** **Help → Export diagnostics…** reveals `executor-diagnostics-<timestamp>.zip` in your file manager, or **Help → Reset Executor data…** finishes with the **Executor data reset** dialog reporting that Executor is running with fresh data and the new Local dashboard loads.

## Open or export diagnostics logs

The desktop app writes structured JSONL logs for the desktop shell, local server, and telemetry collector to `<data-dir>/diagnostics` (by default `~/.executor/v2/cli/diagnostics`, or `$EXECUTOR_DESKTOP_DATA_DIR/diagnostics` if that override is set).

### Show diagnostics folder

1. Click **Show logs** on a recovery screen, or open the **Help** menu and choose **Help → Show diagnostics folder**.
2. Your operating system file manager opens `<data-dir>/diagnostics`.

You'll know it worked when the diagnostics directory opens showing `executor-*.jsonl` log files.

### Export a diagnostics archive

1. Choose **Help → Export diagnostics…**.
2. Wait for the export to finish. Executor saves `executor-diagnostics-<timestamp>.zip` to your **Downloads** folder (a new ZIP requests POSIX mode `0600`) and reveals it in your file manager.

**What the archive includes:**

- `manifest.json` — app name, version, packaged status, OS platform and architecture, runtime versions, process uptime, Local server origin, port source, data directory path, included file paths, and fixed categories excluded from collection. The manifest is written as-is without log masking.
- `executor-[a-z]+.jsonl` logs, rotated `.1` through `.4` log files, and `collector.json` — skipping files over **50 MiB** or with a known modification time older than **14 days**.

**Best-effort log masking:** Executor masks recognized credential patterns in included file contents. Review both the logs and the manifest before sharing the archive.

**Excluded from collection:** Under the normal layout, encryption and API keys (`keys.json`), `installation.json`, PGlite databases (`*.pglite`), retained app builds, browser profile data, and telemetry collector storage are outside the export allowlist.

## Reset Executor data

Use **Help → Reset Executor data…** (or **Reset data…** on recovery screens that offer it) when your local database or key state is broken and cannot be repaired, or when you want to start over cleanly. Because the desktop app and the CLI share `~/.executor/v2/cli` by default, resetting moves the selected Local data directory (shared by both unless overridden).

1. Choose **Help → Reset Executor data…** (or click **Reset data…** on a recovery screen).
2. In the **Reset Executor data?** dialog ("Start over with fresh Executor data?"), click **Reset and back up** (or **Cancel** to keep your current data).
3. Executor stops the background server and telemetry collector, moves the selected Local data directory to a sibling `backups/data-<timestamp>-<suffix>` folder (by default under `~/.executor/v2/backups/`), attempts to write a best-effort `executor-backup.json` manifest (recording key-source metadata when `installation.json` can be decoded), and starts a fresh local server.
4. When the **Executor data reset** dialog reports that Executor is running with fresh data, click **Show in folder** to inspect the backup or **OK** to close the dialog.

The backup retains access to managed keys. Keep externally supplied keys separately, and use the original key source when restoring the backup. Your fresh installation starts with no apps or connected accounts (besides the built-in Executor app).

You'll know it worked when the **Executor data reset** dialog reports that Executor is running with fresh data and the desktop window loads a fresh Local dashboard.

## Recover from startup, port, or key errors

When the local server cannot start or stops unexpectedly, the desktop app displays a recovery screen instead of the dashboard:

- **Stopped externally:** If you stopped the background server from the CLI (`executor service stop` or by changing a setting), the desktop app waits and shows **Start**. Click **Start** (or start it from the CLI) to reconnect.
- **Crash loop:** If the background server stops unexpectedly **3 times within 60 seconds**, the desktop app stops retrying automatically and shows **Restart**, **Show logs**, **Reset data…**, and **Quit**.
- **Port conflict or unreachable port:** Change the local port from **File → Server port…** (validates `1024`–`65535`, refuses edits while an `EXECUTOR_PORT` override is active, and restarts the server automatically on save). If an `EXECUTOR_PORT` override is active, change or unset it first. From the CLI, `executor service set port <port>` accepts `1`–`65535` and stops the server; then click **Start** or **Restart** on the recovery screen (or run `executor service start`).
- **Unavailable OS credential store (`credential-unavailable`):** The recorded OS credential store was not found. Make the original OS credential store available (for example, start Linux Secret Service), then click **Restart**.
- **Locked or denied OS credential store (`credential-denied`):** Unlock macOS Keychain, Windows Credential Manager, or Linux Secret Service, or click **Restart** and allow access when prompted.
- **Missing saved keys (`credential-missing`) or damaged key setup (`invalid`):** Restore the whole Local backup with its original key source. Both screens offer **Reset data…** if you need to start over. The separate **Executor's key settings do not match its data** screen (`misconfigured`) calls for restoring the recorded key settings.
- **API key mismatch:** Use **File → Rotate local API key…** (or `executor service rotate-key` followed by `executor service restart`) to replace a managed local API key, then update any MCP clients that used the previous key. Rotating the API key does not recover a missing or inaccessible encryption key.

## Example

The desktop app bundles its own runtime without putting `executor` on your shell `PATH`. If you also have the [`executor` CLI](/docs/run/cli) installed, you can inspect the shared background server and default Local diagnostics folder from a POSIX shell (macOS or Linux):

```bash
# Inspect the shared background server state and default diagnostics folder
executor service status
ls -la ~/.executor/v2/cli/diagnostics
```

After resetting data from the desktop app, confirm the backup folder was created and the new server is healthy:

```bash
ls -la ~/.executor/v2/backups
executor service status
```

If you changed `EXECUTOR_DESKTOP_DATA_DIR`, inspect logs under that directory instead and pass the same path in `EXECUTOR_DATA_DIR` for CLI service commands.

## Limits

- **Help → Reset Executor data…** is available for the Local workspace and on recovery screens that offer **Reset data…** (not for hosted workspaces).
- Resetting data in the desktop app resets the shared `~/.executor/v2/cli` directory used by the `executor` CLI by default.
- Diagnostics export skips files over 50 MiB or with a known modification time older than 14 days. Pattern-based masking is best-effort on included file contents and does not run on `manifest.json`; review the archive before sharing, and note that POSIX mode `0600` applies only to newly created files on POSIX systems.

## Related

- [Command line](/docs/run/cli)
- [Background server and key storage](/docs/run/cli/background-server)
- [Upgrade and migrate from Executor 1](/docs/run/cli/upgrade)
- [Usage analytics](/docs/run/usage-analytics)
