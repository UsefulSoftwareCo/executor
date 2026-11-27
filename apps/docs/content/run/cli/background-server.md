---
title: Background server and key storage
description: "Start, stop, configure, pair, and rotate keys for the local background Executor server with executor service."
---

By default, local `executor` commands and the desktop app share one background Executor server per data directory (**Local** only; **Self-host** runs in Docker and **Cloud** is managed for you).

Run `executor service start` to start the background server without opening a browser, and `executor service status` to inspect its URL, version, and process ID.

**Prerequisites:** Install the [Executor CLI](/docs/run/cli) version 2.0.0-beta.79 to run these commands. The desktop app can share its server and data directory. When using an OS credential store (macOS Keychain, Windows Credential Manager, or Linux Secret Service), unlock it or grant access if prompted on first launch.

**You'll know it worked when** `executor service start` prints `http://127.0.0.1:4312` (or your configured port) and `executor service status` prints `http://127.0.0.1:4312 (version 2.0.0-beta.79, process <pid>)`.

## Manage the background server

With the background service enabled, the first hostless command that needs Local starts it. It keeps running until you stop it or restart your computer.

| Command | Purpose |
| --- | --- |
| `executor service start` | Start the background server, or confirm it is running, and print its URL. |
| `executor service stop` | Stop the background server. |
| `executor service restart` | Stop the background server and start this installed version. |
| `executor service status` | Print its URL, version, and process ID (`starting`, `stopping`, or `not responding` while transitioning), or `stopped`. |
| `executor service get [<key>] [<name>]` | Print all settings as JSON, one setting (`port`, `env`, or `disabled`), or one `env` variable. |
| `executor service set <key> <value> [<env-value>]` | Change a setting. Changing `port` or `env`, or setting `disabled true`, stops the background server so the next start picks it up; setting `disabled false` only saves the setting. |
| `executor service unset <key> [<name>]` | Remove a setting (or one `env` variable). Unsetting `port` or `env` stops the background server; unsetting `disabled` only saves the setting. |
| `executor service pair` | Create and print a one-use dashboard connection link (valid for five minutes) for the running background server. |
| `executor service rotate-key` | Replace the saved managed local API key (leaving the encryption key unchanged). Run `executor service restart` to apply it, then update clients that used the old key. |

`executor service pair` creates a one-use dashboard grant in server memory without starting Executor. Keep the link private and use it within five minutes. The CLI uses the registered per-start credential by default. For client commands that accept a supplied `EXECUTOR_API_KEY`, that key takes precedence.

To rotate an externally supplied API key, change it at its source and restart the server. `executor service rotate-key` rotates managed Local keys.

### Settings stored in `service.json`

| Setting | Purpose |
| --- | --- |
| `port` | Listening port (`1`–`65535`; default `4312`). The effective `EXECUTOR_PORT` takes precedence. Each data directory needs its own port. |
| `env` | Extra environment variables stored in `service.json` and passed to the background server: `executor service set env <name> <value>` and `executor service unset env <name>`. |
| `disabled` | Set to `true` to make `executor` and hostless client commands run a temporary private server (like `--standalone`) instead of the background server. `executor service start`, `executor service pair`, and the desktop app still use the background server. |

Changing or removing `port` or `env`, or setting `disabled true`, stops the running background server so the next start picks up the change; re-enabling the background server (`set disabled false` or `unset disabled`) only saves the setting. Values set in `service.json`'s `env` override the launching shell's values for the same variable, and the resulting `EXECUTOR_PORT` overrides `port`. Because `executor service set env` writes values as JSON in `service.json` and `executor service get` can print them, use `env` for non-secret settings such as `EXECUTOR_BROWSER_ORIGIN` and keep secrets out of service settings. `EXECUTOR_API_KEY` and `EXECUTOR_ENCRYPTION_KEY` are forwarded to the background server only when both are set; `EXECUTOR_API_KEY` alone is dropped when launching a background process and is used only as a caller credential on commands that consume it.

Inside the data directory (default `~/.executor/v2/cli`), `service.json` stores `port`, `env`, and `disabled`, `server.json` records the running URL and PID, and `.server.lock` prevents a second server from opening the same directory. New key, service settings, and registration files request POSIX mode `0600`.

### Foreground, standalone, and remote modes

- `executor serve` runs the local server in your terminal until Ctrl+C without opening a browser (stop the background server first). Other local commands use it while it runs.
- `executor --standalone` runs a temporary standalone server on a free port for one command until Ctrl+C, reading its configuration from the launching process (without the persisted `service.json` `env` overlay). Stop the background server first or set `EXECUTOR_DATA_DIR` to another folder.
- `executor --server <url>` opens the dashboard of an already-running local server at `<url>`.

### Sharing with the desktop app

The desktop app shares the same background server and `~/.executor/v2/cli` data directory by default (desktop can override its directory independently). Stopping it from the CLI (`executor service stop` or changing a setting) shows it as stopped in the desktop app without restarting it automatically; it reconnects when a CLI command starts it or you click **Start**.

Older desktop releases kept a separate data folder. Desktop can migrate a nonempty legacy data directory into `~/.executor/v2/cli` once, without merging. It moves existing shared CLI data (with apps, accounts, and `service.json`) to `~/.executor/v2/backups/cli-data-<time>`. It carries over a saved port from a readable legacy `desktop.json`; otherwise the shared port uses its default. It also carries over the CLI's `env` settings except `EXECUTOR_PORT`, `EXECUTOR_KEY_STORAGE`, `EXECUTOR_API_KEY`, and `EXECUTOR_ENCRYPTION_KEY`. Migration also clears `disabled`. Keep the original key source with each backup, and check the shared service settings after migration. The old desktop folder moves to `~/.executor/v2/backups/desktop-data-<time>` (or stays in place on another drive). If the legacy directory is missing or empty, CLI data is untouched.

## Configure it

| Variable | Purpose |
| --- | --- |
| `EXECUTOR_PORT` | Port to listen on (`1`–`65535`). Overrides `port` in `service.json`; default `4312`. |
| `EXECUTOR_DATA_DIR` | Data directory path. Default `~/.executor/v2/cli`. |
| `EXECUTOR_KEY_STORAGE` | `file` or `os`: choose key storage for a brand-new data directory. |
| `EXECUTOR_API_KEY` | Supplied Local API key. Pair with `EXECUTOR_ENCRYPTION_KEY` for server startup; set alone for client requests. |
| `EXECUTOR_ENCRYPTION_KEY` | Supplied credential encryption key (exactly 64 hexadecimal characters). Must be paired with `EXECUTOR_API_KEY`. |
| `EXECUTOR_BROWSER_ORIGIN` | Exact HTTPS origin used when generating browser links. |
| `EXECUTOR_WEBHOOK_ORIGIN` | Exact HTTPS origin used when generating public app webhook URLs. Forward incoming webhook requests to the Local server if you use an external origin. |
| `EXECUTOR_NO_UPDATE_CHECK` | Set to `1` to skip the daily npm check for a newer release. |
| `DO_NOT_TRACK` or `EXECUTOR_DISABLE_ANALYTICS` | Set to `1` before startup to disable product [usage analytics](/docs/run/usage-analytics) and feedback (local tracing and log collection are separate). |

## Key storage

Executor encrypts saved account fields in PGlite (`EXECUTOR_DATA_DIR/executor.pglite`) with AES-256-GCM using a 64-hex-character key and a fresh random nonce, binding each record to its account ID. On first launch of a new data directory, Executor generates a local API key and credential encryption key and tries the OS credential store (macOS Keychain, Windows Credential Manager, or Linux Secret Service).

- **Absent OS credential store:** When the OS credential store is absent (for example on headless Linux without Secret Service, or Windows without a logon session) and `EXECUTOR_KEY_STORAGE=os` is not forced, Executor can save newly generated keys in `keys.json` (POSIX mode `0600`) inside a new data directory. Keep that directory private.
- **Locked or denied OS store:** A locked store or denied access can prevent startup. Unlock the store or grant access and try again.
- **Explicit choice on a new directory:** Set `EXECUTOR_KEY_STORAGE=file` to force `keys.json`, or `EXECUTOR_KEY_STORAGE=os` to require the OS store. An initialized directory keeps its recorded key source.
- **Supplied keys:** Supply both `EXECUTOR_API_KEY` and `EXECUTOR_ENCRYPTION_KEY` (exactly 64 hexadecimal characters) from your secret manager before first start and on every start. Server startup leaves supplied keys in their original source. Saving them through `executor service set env` writes them to `service.json` and lets `executor service get` print them — keep secrets out of service settings.

## Back up your data and keys

Stop the background server and back up the whole data directory with its original key source. Depending on the installation, keep the original OS credential, the `keys.json` inside the directory, or both original supplied keys. Restore that key source with the data directory and keep the original encryption key to read stored account fields.

## Example

Start the background server, change its port and an environment variable, rotate its local API key, and verify status:

```bash
executor service start
executor service status
executor service set port 14312
executor service set env EXECUTOR_NO_UPDATE_CHECK 1
executor service get env EXECUTOR_NO_UPDATE_CHECK
executor service rotate-key
executor service restart
executor service status
```

Expected output from `executor service status` after restart:

```text
http://127.0.0.1:14312 (version 2.0.0-beta.79, process 3488)
```

To restore the default port and stop the server:

```bash
executor service unset port
executor service stop
executor service status
# stopped
```

## Limits

- The background server does not auto-start on OS boot; MCP clients connecting to `http://127.0.0.1:4312/mcp` receive connection refused after a reboot until you run `executor` or `executor service start`.
- Bare `executor` and `executor service restart` switch a running background server to the invoked version; other local client subcommands reuse a responsive registered server on whichever version is running.
- On Windows, package managers (`npm`, `pnpm`, `bun`, `yarn`) cannot replace binaries of a running process; run `executor service stop` before upgrading outside `executor upgrade`.
- `executor service set` takes positional arguments (`executor service set port 14312`), not flags.

## Related

- [Command line](/docs/run/cli)
- [Use Executor from a shell](/docs/run/cli/from-a-shell)
- [Upgrade and migrate from Executor 1](/docs/run/cli/upgrade)
- [Desktop troubleshooting](/docs/desktop/troubleshooting)
- [Usage analytics](/docs/run/usage-analytics)
