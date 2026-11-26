---
title: Executor desktop app
description: "Install the Executor desktop app on macOS, Windows, or Linux to run Local Executor, switch between Cloud and self-hosted teams, and manage updates and diagnostics."
---

The Executor desktop app (`Executor 2`) runs Local Executor and lets you switch between that dashboard and your **Cloud** or **Self-host** teams. Use the welcome screen (**Sign in**, **Run locally**, **Customize**), the sidebar account menu (**This computer**, **Switch to**, **Add account**), **Updates**, and **Help** (**Show diagnostics folder**, **Export diagnostics…**, **Reset Executor data…**). For standalone app windows, see [Install an app as a desktop app](/docs/desktop-apps) (using Executor CLI 2.0.0-beta.79? For app management and Git, run `executor apps login` and add `--host <your origin>` for Self-host).

**Key step:** download the installer at [executor.sh/#install](https://executor.sh/#install), launch **Executor 2**, and pick **Sign in**, **Run locally**, or **Customize**.

**Prerequisites:** macOS (Apple Silicon/Intel `.dmg`), Windows (x64 `.exe`), or Linux (x64/ARM64 `.AppImage`; `.deb` packages are also published without in-app updates).

**You'll know it worked when…** the dashboard opens for **This computer** or your organization and you can switch targets from the account button at the bottom of the sidebar.

## How to use it

### Connect to Cloud, Local, or Self-host

On a fresh install with no existing Local data, the **Welcome to Executor** window offers three targets (if existing Local data is already present, Executor 2 can open directly into the Local dashboard):

- **Cloud:** click **Sign in**. Executor opens `app.executor.sh` in your browser (*"Finish signing in in your browser"*). Choose your organization on the consent screen, approve access, and return to Executor 2.
- **Local:** click **Run locally**. Local desktop and the standalone CLI share `~/.executor/v2/cli` by default (override with `EXECUTOR_DESKTOP_DATA_DIR` for desktop or `EXECUTOR_DATA_DIR` for the CLI). Allow access to your OS credential store (macOS Keychain, Windows Credential Manager, or Linux Secret Service) if prompted. A new data directory tries the OS credential store; file mode, or an absent store with no forced OS mode, uses `keys.json` (`0600` on POSIX). A denied or locked store can stop startup and open a recovery screen. Initialized directories keep their key source.
- **Self-host:** click the **Customize** icon in the top-right corner, enter **Server address** (`https://executor.yourcompany.com`—origin only, no path, query, fragment, or credentials), and click **Sign in to this server**. Choose your organization on the browser consent screen, approve access, and return to Executor 2. Signing in to a non-loopback plain `http://` server displays a warning that sign-in travels in plain text and requires checking **Sign in without encryption**. Desktop uses Electron safe storage for hosted refresh tokens; on Linux using the `basic_text` storage fallback, desktop warns that saved hosted sign-ins are protected only by file permissions, and if storage fails desktop can refuse to start sign-in.

### Switch accounts and manage local settings

- **Switch or add accounts:** click the account button at the bottom of the sidebar. On a fresh Local-only install, look for **This computer**—its menu offers **Sign in to Executor Cloud** and **Self-hosted server…**. Once a hosted account is present, the menu switches one dashboard at a time under **Switch to**. Use **Add account** to sign in to Cloud (**Sign in to Executor Cloud**) or a self-hosted server (**Self-hosted server…**); if Local is absent, this menu also offers **Run locally**. Hosted accounts also expose **Sign out of `<team>`**, **Remove from this computer…**, and (when available) **Account settings**.
- **Local server controls (`File` menu):** when running locally, **File** exposes **Open in browser**, **Server port…**, and **Rotate local API key…**.

### Updates, diagnostics, and data reset

- **Updates (`Updates` menu):** installations with in-app updates configured check 15 seconds after launch and every 4 hours while running. Click **Updates** -> **Check for updates…** to check manually, or **Updates** -> **Restart to update (v…)** when a download is ready.
- **Diagnostics (`Help` menu):** click **Show diagnostics folder** to open the local diagnostics directory, or **Export diagnostics…** to save `executor-diagnostics-<timestamp>.zip` to Downloads (requesting POSIX `0600` permissions on a new ZIP). The export selects `manifest.json` (including the server origin, local data-directory path, versions, and uptime as written) and named diagnostic JSONL logs, rotations, and `collector.json`, skipping files over 50 MiB or with a known modification time older than 14 days. Databases, key files, installation records, retained builds, browser profiles, and telemetry collector storage are outside that list. Export masks recognized credential patterns in included file contents (quoted token, secret, password, authorization, cookie, and API-key fields; Bearer/Basic headers; `pair`, `token`, `code`, and `state` query or fragment parameters; and 64+ character hex strings); other content is left as written, so review the archive before sharing it.
- **Reset local data (`Help` menu):** when running locally, **Reset Executor data…** stops the local server and moves the data directory to a timestamped backup folder before starting fresh.

## Example

Excerpt from `manifest.json` inside an exported diagnostics archive (also includes generation time, packaging status, component versions, uptime, and the local data-directory path):

```json
{
  "app": "Executor 2",
  "version": "2.0.0-beta.79",
  "platform": "darwin",
  "arch": "arm64",
  "server": { "origin": "http://127.0.0.1:4312", "portSource": "default" },
  "files": ["diagnostics/executor-desktop.jsonl"],
  "excluded": [
    "keys and installation record",
    "databases and retained builds",
    "browser profile",
    "telemetry collector storage"
  ]
}
```

## Limits

- **Linux auto-updates:** in-app automatic updates on Linux require running the packaged `.AppImage` (`APPIMAGE` set). In other Linux packages (such as `.deb`), **Updates** -> **Check for updates…** shows instructions for downloading a newer installer manually; it does not prompt on a timer.
- **Self-hosted URL rules:** **Server address** accepts only `http://` or `https://` origins without paths, query strings, fragments, or embedded usernames/passwords.
- **Crash recovery and stopped service:** if the local server stops unexpectedly three times within a minute, Executor displays a recovery screen (*"Executor keeps stopping"*) with **Restart**, **Show logs**, **Reset data…**, and **Quit**. After `executor service stop`, click **Start** in the desktop recovery screen or run `executor service start` in your terminal—the app reconnects when the service comes back.
- **Shared local state with CLI:** the packaged desktop app shares `~/.executor/v2/cli` with the `executor` CLI by default, so stopping or changing the background service from a terminal affects both.

## Related

- [Quickstart](/docs/quickstart)
- [Install an app as a desktop app](/docs/desktop-apps)
- [Command line](/docs/run/cli)
- [Self-host Executor](/docs/run/self-host)

Using Executor CLI 2.0.0-beta.79? For app management and Git, run `executor apps login`. For tool commands and MCP, run `executor login`. For Self-host, add `--host <your origin>` to the sign-in command.
