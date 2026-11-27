---
title: Upgrade and migrate from Executor 1
description: "Upgrade or roll back the Executor CLI, replace Executor 1 commands, resolve local owner migration banners, and keep Cloud v1 MCP URLs working."
---

Use `executor upgrade` to install the newest Executor release on your channel (**Local** CLI), `executor upgrade --rollback` to revert a standalone script install, and the guides below when moving from Executor 1 (**Local** and **Cloud**). For **Self-host** Docker server updates, see [Storage, backups, and updates](/docs/run/self-host/storage-and-updates#updates).

**Prerequisites:** An existing Executor 2 CLI install (to upgrade) or an Executor 1 installation or **Cloud** v1 organization (to migrate).

**You'll know it worked when** `executor --version` prints the target release (for example `executor v2.0.0-beta.79`), and if the background server is running (or after `executor service start`), `executor service status` reports that version.

## Upgrade or roll back the CLI

`executor` and `executor serve` check npm for a newer release on your channel and reuse a successful check written to disk for up to one day (command-error upgrade hints can make a separate check). Beta installs are notified when a newer stable release ships. The check never installs anything, skips in CI, and can be disabled with `EXECUTOR_NO_UPDATE_CHECK=1`.

Choose one upgrade command for your installation:

| Command | Purpose |
| --- | --- |
| `executor upgrade` | Install the newest release on your channel. |
| `executor upgrade 2.0.0-beta.79` | Install a specific release. |
| `executor upgrade --rollback` | Switch a standalone script install back to its previous release. |
| `executor upgrade --method pnpm` | Force a specific package manager (`npm`, `pnpm`, `bun`, or `yarn`). |
| `executor upgrade --yes` | Skip the confirmation prompt (required for downgrades without a terminal). |

How `executor upgrade` behaves depends on how Executor was installed:

- **Install script (standalone):** Confirms first, downloads the release, checks its archive against the release's `SHA256SUMS`, confirms the new binary starts, stops an already-running release background server if needed, and flips `~/.executor/v2/runtime/current` to the new release. The previous version stays in `~/.executor/v2/runtime/versions/`, so `executor upgrade --rollback` can switch back when a previous release is present.
- **npm, pnpm, Bun, or Yarn:** Detects which package manager installed Executor (or uses `--method npm|pnpm|bun|yarn`), verifies your Node.js version meets the new launcher's requirement, runs the package manager install, and checks `executor --version`. If Executor cannot tell which package manager installed it, it prints the install command for each one instead of guessing.
- **Homebrew:** Upgrade with `brew upgrade executor-beta` (for the beta formula) or `brew upgrade executor` (for stable) instead of `executor upgrade`.
- **`npx`, `bunx`, or `pnpm dlx`:** There is nothing installed to upgrade; run `npx executor@beta` to launch the newest release.

On an interactive terminal, `executor upgrade` asks for confirmation before installing unless you pass `--yes` (`-y`). Without a terminal (agents or CI), upgrades proceed automatically, while downgrading to an older version still requires an explicit version and `--yes`.

Upgrading or rolling back restarts an already-running release background server on the selected version when possible. If the background server was stopped beforehand, it stays stopped. If an install fails after stopping the server, Executor tries to restart the previous version (which can fail). If the new version fails to start, the upgrade itself still finishes and instructs you to run `executor service start`.

After an external package update (such as `npm i -g`, `brew upgrade executor-beta`, or another package manager), run `executor service restart` (or bare `executor`) to move a running background server to the new version. If a package replaces or removes the running native executable directly, the local server normally detects it on its next five-second check and stops (an npm launcher update can leave the old cached native executable running until you restart). The standalone install scripts stop a known release background server automatically. On Windows, stop the server first with `executor service stop` because Windows locks running executables.

Your `~/.executor/v2/cli` data directory stays the same when beta transitions to stable.

### Desktop app updates

The desktop app shares the background Executor with the CLI, but checks for and confirms desktop app updates separately from `executor upgrade`. Beta installs follow beta releases and move to stable once stable is newer. On Linux, only the AppImage auto-updates; for `.deb` packages, install the newer `.deb` over the existing one.

## Coming from Executor 1

If `executor --version` still reports v1 after installing Executor 2, your shell is resolving an older install earlier on `PATH`. Check which binary wins:

On macOS or Linux:

```bash
type -a executor
```

On Windows, in PowerShell:

```powershell
where.exe executor
```

Remove the old install with the package manager that installed it (for example `bun remove -g executor`), then open a new terminal. Removing the v1 package binary does not delete your data.

Executor 2 removes Executor 1's `web`, `open`, `daemon`, `install`, `tools`, `server`, and `docs` commands; running them reports an unknown command.

| Executor 1 | Executor 2 |
| --- | --- |
| `executor web` | `executor` starts the background Executor if needed and opens the dashboard. |
| `executor open` | `executor service pair` prints a connection link for the background Executor. |
| `executor daemon run` | `executor service start` starts the background Executor without opening a browser. |
| `executor install`, `executor service install` | Nothing to install. `executor` or `executor service start` runs the background Executor until `executor service stop`; it does not start on OS boot. |
| `executor service uninstall` | Nothing to remove. Run `executor service stop`. |
| `executor tools` | `executor search` and `executor describe`. |
| `executor call`, `executor resume`, `executor mcp`, `executor login` | Still present with updated flags; see [Use Executor from a shell](/docs/run/cli/from-a-shell). |
| `executor server` | No server profiles. Commands accept `--host` and remember the last host you signed in to; `executor service rotate-key` replaces `executor server rotate-token`. |
| `executor docs` | Open [executor.sh/docs](https://executor.sh/docs). |

## Records under another owner (Local)

Local Executor puts your apps, accounts, and OAuth clients under one local owner. Executor normally moves eligible older-owner records at startup (this is separate from moving Local v1 installations to v2 or Cloud migration). If the dashboard shows a migration banner, follow the instructions for the reported status. There are two banners:

- **"Records of other owners wait to move"**: Shown when the server was started with `EXECUTOR_DATA_STEPS=report` (dry-run mode). Restart Executor without `EXECUTOR_DATA_STEPS` so the move can run.
- **"Records of other owners could not move"**: Shown when moving records failed because of either:
  - **Collisions (`collision`)**: Another owner already holds an `app_name`, `app_slug`, or `oauth_client_credentials` entry matching the active owner. Rename or remove the duplicate app, or for duplicate OAuth client credentials remove all but one of the matching clients listed by the banner, then restart Executor.
  - **Unreadable encrypted records (`blocked`)**: Follow the recovery action printed beside each listed record. For a printed request, use the exact request from the banner, including its owner query if present. If the banner directs you to restore a backup, choose one from before the record was written and use its original key source.

Restart Executor after resolving the listed records (`executor service restart`). You'll know it worked when the banner disappears from the dashboard.

## Executor v1 MCP URLs (Cloud)

Cloud has compatibility routes for migrated v1 organizations. Older client configurations may use one of these paths:

- `/<v1-slug-or-org_id>/mcp`
- `/mcp/toolkits/<toolkit>`
- `/<selector>/mcp/toolkits/<toolkit>`

Use the migrated organization's authorized MCP connection. To update a client configuration, open **Connections** in that organization, select the connection you want, and follow [Add an MCP client](/docs/mcp-clients).

## Example

Upgrade an installed CLI to a specific release (or omit the version to install the newest on your channel) and verify both the binary and the background server:

```bash
executor upgrade 2.0.0-beta.79 --yes
executor --version
executor service start
executor service status
```

On a standalone script install that has a previous release, roll back and verify:

```bash
executor upgrade --rollback
executor --version
executor service start
executor service status
```

## Limits

- `executor upgrade --rollback` works only for installations created by the standalone install script (`install.sh` / `install.ps1`) that have a previous release, not npm, pnpm, Bun, Yarn, or Homebrew installs.
- Rolling back or downgrading to a release from before the background Executor existed removes `executor service`; on such releases, run `executor serve` or `executor` and keep it running.
- A background Executor started from a development build is left running during `executor upgrade`.
- Executor never upgrades the CLI automatically without you running `executor upgrade` or an external installer.

## Related

- [Command line](/docs/run/cli)
- [Background server and key storage](/docs/run/cli/background-server)
- [Use Executor from a shell](/docs/run/cli/from-a-shell)
- [Add an MCP client](/docs/mcp-clients)
- [Desktop troubleshooting](/docs/desktop/troubleshooting)
