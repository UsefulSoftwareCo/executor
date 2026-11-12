# Executor desktop

Electron owns a sandboxed window onto the background Executor server that the CLI
uses. The desktop starts that server, or joins the one already running for the
CLI's data directory, and shows its dashboard. The window uses the same dashboard,
HTTP API, pairing exchange, and account model as the browser app. No Node API or
persistent API key is exposed to the renderer.

Release installers include the official Node distribution matching the CLI build
toolchain. The builder verifies its upstream checksum and retains its license
notices. The packaged app runs the background server with that executable;
development runs the CLI from source with the Node on `PATH`.

## Run

Use Node 22.23+. No configuration is needed: `scripts/local-dev.ts` supplies a
development key pair from the checkout's ignored `.local/dev/`. Variables that
you set, such as the [local server configuration](../server/README.md#configuration),
win over these defaults. Run from the repository root:

```sh
bun install
bun run desktop:dev
```

This builds the Electron main entry, creates a locally signed macOS development
bundle, and launches the app. A background server it starts serves the dashboard
through Vite with hot reload. The background server outlives the app, so after
changes to server source run `bun run executor service stop`, then
`bun run desktop:dev` again. A server that `bun run executor` started serves the
built dashboard; stop it first to get hot reload. After changes to Electron
source, rerun `bun run desktop:dev`.

On macOS, reopen `.local/desktop-runtime/Executor Dev.app` from Finder. Its launcher
loads the same `scripts/local-dev.ts` defaults each time. The bundle remains attached to this
workspace, like T3 Code's development launcher. It is not a release installer.
Finder launches write diagnostics to `.local/desktop.log`.

To use the built dashboard instead of Vite:

```sh
bun run desktop:start
```

A second launch focuses the existing app. Closing the last macOS window keeps the
app running; reopening from the Dock restores the dashboard. **Quit Executor**
and Ctrl+C in a terminal launch stop the app only: the background server keeps
running for the CLI and MCP clients until `executor service stop`.

Use **File → Open in browser** to connect your system browser to the same server.
It opens an authenticated dashboard with a one-use link. No CLI is needed;
MCP clients can then use that browser for local consent.

## Runtime

- The desktop shares the CLI's data directory and its one background server:
  `~/.executor/v2/cli` when packaged, and `bun run executor`'s `.local/dev/local`
  in development. `EXECUTOR_DESKTOP_DATA_DIR` chooses another directory.
- Desktops before the background service kept their own data in
  `<user data>/data` (`.local/dev/desktop` in development). The first launch
  moves it into the shared directory once, before any server uses it. The port
  follows the desktop's data: its saved port, or 4312 when it saved none. The
  CLI's other `service.json` settings are carried over, except the `env`
  variables tied to the CLI's own data (`EXECUTOR_PORT`, `EXECUTOR_KEY_STORAGE`,
  `EXECUTOR_API_KEY` and `EXECUTOR_ENCRYPTION_KEY`) and `disabled`: the desktop
  always runs the background server, which `executor` would otherwise find
  holding the data. They are read just before the copy moves into place, so a
  move resumed on a later launch uses the settings the CLI has then. Whatever
  was in the shared directory moves to `backups/cli-data-<time>` beside it, with
  its original `service.json`. When that held the CLI's data, or the move
  changed the CLI's port or left settings out, a notice names the folder and
  those settings once the window first shows the dashboard or the recovery page. The shared
  directory ends with mode `0700`, whatever the old directory's was. Until it has
  been answered, the notice is kept with the move's record in `migration.json`,
  so a launch that ends first shows it next time. Only an old
  directory with a database moves; one without, as after a first start that
  failed, is left where it is and the shared directory is not touched. Both
  directories stay locked, as a server locks them, from before the copy until
  the renames are done, so no server starts in either meanwhile. Each lock
  records the desktop as its owner, so servers treat it as held while the
  desktop runs and take it over at once if the desktop crashed. A lock lost
  before its directory moved stops the copy, no rename runs without its lock,
  and the move rolls back as after any failure. The window opens
  first and says the data is moving while it does; its menu then has none of the
  app's own actions, which need the data. Quitting meanwhile, or closing the
  window, ends the app once the move is done.
  A directory chosen with `EXECUTOR_DESKTOP_DATA_DIR` only takes over an old one
  chosen with `EXECUTOR_DESKTOP_LEGACY_DATA_DIR`. If the move fails, nothing is
  deleted, no server starts and the recovery page explains what to fix.
- The Electron user-data directory (`.local/desktop-shell/` in development) holds
  Chromium's profile and, when packaged, `runtime/<version>-<build>/`: the bundled
  server runtime copied out of the app once per build. The server runs from that
  copy, so it keeps running while an installer replaces the app or an AppImage
  unmounts. A copy is used only once `.staged.json`, written last, names its
  build; a copy without it, as after an interrupted removal, is staged again. On
  Windows, renames and removals that a virus scanner briefly blocks are retried
  for a few seconds. Copies other versions no longer use are removed after the
  desktop's own version runs. Browser session cookies use an in-memory partition
  and are replaced by a new pairing on launch.
- On launch the desktop replaces a background server of another version with its
  own, as an interactive `executor` does. It then pairs the window: `POST
/auth/pair` with the server's registered password as the bearer, and loads the
  one-use link. A dashboard load that fails, or has not finished after 30
  seconds, is tried again with a fresh link two seconds later; after three
  attempts in a row the window shows its own recovery page with the failure. The
  server still runs, so that page offers no reset: **Restart** joins the server
  and loads the dashboard again. A load that another navigation of the window
  replaced, such as an OAuth return, is left to it, also while a retry waits.
- The desktop checks every second that the registered server still answers. When
  another client replaces it, the desktop joins the new one and pairs the window
  again. A server that stops answering while it is still registered, as after a
  crash, counts as lost: the desktop joins whichever server runs then, starting
  one if none does, and three losses within a minute show the recovery page
  instead. A server stopped on purpose, as by `executor service stop` or
  `executor service set …`, says it is stopping until it exits and removes its
  registration, however long that takes, and is not counted or started again:
  the window says **The background Executor was stopped**, and
  the desktop joins the next server that registers and answers, as after
  `executor` or `executor service restart`. **Start** there starts one.
- The background server runs with the desktop's environment, without Electron's
  own `ELECTRON_*` variables. It keeps the rest, such as Windows's `SystemRoot`,
  which Windows programs need. In an AppImage it also drops `APPDIR`, `APPIMAGE`,
  `ARGV0` and `OWD` and every entry inside the AppImage's mount from `PATH`,
  `LD_LIBRARY_PATH`, `XDG_DATA_DIRS`, `GSETTINGS_SCHEMA_DIR` and any other
  variable: the mount is removed once the app quits, while the server keeps
  running, and another local user could then create that path.
- The desktop starts or joins the server from the server starter, a short-lived
  Electron utility process that runs the CLI's start logic, reports the server and
  exits. The server outlives the app, so it must not keep the app's streams or
  files open. Electron's main process keeps its standard streams inheritable, and
  on Windows a child inherits every inheritable handle, so a server started there
  would keep the app's stdout and stderr open after it quits: whatever waits for
  them to close, such as a terminal or a launcher, would wait until the server
  stopped. Chromium starts the utility process with only the handles it names, and
  Node there makes its standard streams non-inheritable. One handle is still
  inherited on Windows: the starter's end of its channel to the app, which
  Chromium creates inheritable, so a server holds it for as long as it runs. That
  keeps none of the app's streams or files open, and Electron still notices the
  starter exiting, even when it is ended from outside. A starter that hangs
  instead never reports, so the desktop gives the starter three minutes, beyond
  the CLI's two-minute start deadline, before it fails the start and shows the
  recovery page. On Linux the starter still holds descriptors Chromium gave it
  without close-on-exec, such as Electron's V8 snapshot, which is inside an
  AppImage's mount, so the server starts through Bash, which closes every
  descriptor above stderr first. Without `/bin/bash` the server starts directly
  and keeps them, so an AppImage's mount stays in use while it runs. The starter's
  channel to the app is close-on-exec on Linux, so a server never holds it there.
  macOS starts each child with only the descriptors it names. The starter reports
  each start attempt it begins and when that attempt exits. If the starter does
  not exit when told to, the desktop first ends its attempts that still run,
  except the registered server, as the CLI's start logic would, and then kills it.
  It ends them only while the starter itself still runs, hung or stopped: once the
  starter has exited, even before the system has reaped it, an attempt's process
  ID may name another process, so the attempts of a starter that is gone are left
  to finish.
- The server listens on `EXECUTOR_PORT`, else the `port` in the data directory's
  `service.json`, else 4312. **File → Server port…** edits `service.json`; an
  `EXECUTOR_PORT` locks it.
- OAuth consent opens in the system browser. Before it opens, the desktop tells the
  server to expect the authorization's `state`. The server keeps the provider's
  callback for an expected state, shows the browser a page asking to return to
  Executor, and hands the callback to the desktop, which waits for it with an
  authenticated long poll. The desktop loads it in the original window, keeping
  its session and return intent. At most 16 states and callbacks are kept, for 15
  minutes each. Callbacks for other states, including every OAuth a browser
  starts, complete in that browser.
- External HTTP(S) links open in the system browser. Other schemes and embedded
  Node access are disabled. App-origin launch links also open in the browser.
- Desktop warms the entry graph and keeps the renderer unthrottled during startup.
  HMR uses a separate ephemeral loopback listener and Vite cache, so it can
  run alongside the browser development server.
- Start and key-setup failures show the same script-free recovery page, with what
  the server said. A server whose key setup refuses to start writes its reason as
  one line on stderr before its message; the desktop reads it from the start
  failure and chooses the page's actions from it. Its buttons navigate to
  `executor-recovery:start|restart|logs|reset|quit`, which the main process
  intercepts; there is still no preload or IPC. Reset is never offered when the OS
  credential store is unavailable or denies access, when `EXECUTOR_KEY_STORAGE` or
  supplied keys do not match the data, or when the data is locked by a process
  that is not its background server, including an Executor from before the
  background service that its `server.json` names. A denied store offers
  **Restart**, which prompts again.
- A crashed renderer reloads up to three times per minute. After that the app
  says the window kept crashing, names the diagnostics folder and quits. The native
  error box is otherwise used only when the window itself fails.

## Reset with backup

**Help → Reset Executor data…** and the recovery page's **Reset data…** ask for
confirmation (Cancel is the default). Reset then stops the background server, waits
for its telemetry collector to exit and takes the data directory's server and
bootstrap locks, so no other client starts a server meanwhile. It takes the
server lock as a server does, so a lock left by a server that crashed or was
killed is taken over, and records the desktop as its owner, so servers treat it
as held while the desktop runs. It refuses, moving nothing, while an Executor from before
the background service uses the data: that server holds no lock and the desktop
cannot stop it; key rotation refuses then too.
It renames the whole data directory, which the CLI shares, to
`backups/data-<time>-<random>` beside it (`~/.executor/v2/backups/` when packaged);
on Windows, where a server that was just stopped or killed keeps its files open
for a moment, the rename is retried for a few seconds. It then writes `executor-backup.json` there: app version, time, source path,
installation ID, key source and, for the OS credential store, its service/account.
It never contains a key. Executor starts the server again with fresh data and
names the backup, with **Show in folder**.

Nothing is deleted. The old OS credential entry stays where it is, still paired
with the backup through its installation ID; a `keys.json` moves with the backup. To restore, quit Executor and move the
backup directory back to the data path. There is no restore UI or automatic cleanup.
If the rename fails, for example because another program holds a file open on
Windows, the data stays in place and Executor starts the server on it again. The
desktop log continues in a new `executor-desktop.jsonl` under the fresh data
directory.

**Help → Show diagnostics folder** opens the directory holding the desktop,
server and collector logs.

## Recovery scenarios

`e2e/tests/desktop-recovery.spec.ts` drives the desktop against real background
servers: sharing one with the CLI, staying stopped after `executor service stop`
and joining the server the CLI starts next, replacing a crashed one, the recovery
page, reset and the data migration. Each scenario uses its own temporary data
directory and port, runs the CLI on the same directory, and stops every server it
left. A failed scenario keeps a screenshot of each desktop window and the
desktop's and its servers' logs in a `failed-<time>-<pid>` folder under
`EXECUTOR_E2E_DESKTOP_SCREENSHOTS` (`.local/desktop-recovery` by default). The
release workflow runs it against each packaged desktop, whose CLI is the
runtime it staged. Locally, build the entry and run it, under `xvfb-run -a` on
Linux; set `EXECUTOR_E2E_DESKTOP_EXECUTABLE` to test a packaged app:

```sh
bun run apps:build && bun run e2e:apps && bun run telemetry:build && bun run web:build
node apps/local/desktop/scripts/build.mjs
bunx vitest run --config e2e/desktop-recovery.config.ts
```

## Settings and diagnostics

**File → Server port…** opens a script-free form in its own sandboxed window. Submitting it is a
navigation to `executor-settings:` that the parent intercepts; there is still no preload or IPC
bridge. The parent accepts ports 1024 to 65535, refuses one another program is listening on,
saves it as `port` in `service.json`, keeping its other settings, and restarts the background
server. A bind can still race another process after the check. An invalid `service.json` locks
the form and names the file.

**File → Rotate local API key…** confirms, stops the background server, runs `executor service
rotate-key` with the same runtime and starts the server again. That replaces the API key where the
data directory keeps it (OS credential store or `keys.json`) and retains the encryption key, so
saved accounts and MCP sign-ins still work. Browser sessions are unaffected; scripts and clients
that send the old key must be updated. Outstanding account-connection links are signed with the
old key and stop working. Supplied `EXECUTOR_API_KEY`/`EXECUTOR_ENCRYPTION_KEY` are never stored,
so the menu explains that they must be changed where they are set.

**Help → Export diagnostics…** writes `executor-diagnostics-<UTC stamp>.zip` to Downloads and
reveals it. It contains a manifest (versions, platform, origin, port source, data directory) and
the allowlisted files from `diagnostics/`: the rotating `executor-*.jsonl` logs and
`collector.json`, at most 50 MiB each and 14 days old. Keys, `installation.json`, databases,
retained builds, the browser profile and Motel's trace store are never read. Logs are already
redacted at the source; the export additionally masks bearer values, `pair`/`token`/`code`/`state`
URL parameters, 64-digit hex runs and credential-named JSON fields.

## References

The background service follows OpenCode's desktop (`packages/desktop/src/main/service/`,
MIT): stage the bundled CLI outside the app, then start or join the service with the
bundled version winning on launch.

Reviewed `pingdotgg/t3code` at `93e04160` (2026-09-18). The ignored checkout is
`.reference/t3code-desktop/`. The main references are:

- `apps/desktop/src/window/DesktopWindow.ts`: sandboxed window and native lifecycle.
- `apps/desktop/vite.config.ts`: bundled CommonJS main entry with Electron external.
- `apps/web/vite.config.ts` and `apps/web/vite/tailwind.ts`: bundled development,
  entry warmup, and Tailwind hooks for Rolldown.
- `apps/desktop/scripts/electron-launcher.mjs`: a branded development bundle with
  framework-relative symlinks preserved and local code signing.
- `scripts/build-desktop-artifact.ts`: reference for the later release pipeline.

Executor keeps its existing same-origin HTTP/cookie protocol. It does not need a
preload or an IPC bridge for ordinary dashboard operations. Distribution builds,
notarization, updates, and platform-specific release artifacts remain separate
from this workspace launcher. Windows and Linux have not been verified.

## Persistent diagnostics

The background server runs the Motel collector and persists traces and logs under the
data directory's `diagnostics/`. The Electron parent records startup, connections,
recovery and renderer messages in `executor-desktop.jsonl` beside them. See
[telemetry](../../../notes/telemetry.md#frontend-lifetime-and-local-diagnostics)
for retention, query URLs, and the JSONL files an agent can inspect.

## Packaged preview

Build the CLI runtime with `bun run release:cli`, then run
`bun run release:desktop 0.0.0-preview.local`. Add `--dir` to build an unpacked
application for inspection. Output lives in `.local/releases/`.

The preview is named **Executor Preview**, with a separate app ID and persistent
Electron user-data directory. It contains the server, dashboard, framework,
compiler, Git, SDK dependencies and collector, and `desktop-runtime.json`, which
names the build so each rebuild is staged again. It does not load `.env` files,
call 1Password, require a workspace or use the original Executor updater. Installing
an update quits the app only; the next launch replaces the running server with the
new version.

The server uses `EXECUTOR_PORT`, the `service.json` port or 4312, so MCP clients keep
the same URL across restarts. Use another fixed port when running a second data
directory.

Windows and Linux builds, and signed macOS builds, include the channel feed in
`app-update.yml`. Unsigned macOS builds have none, and their **Updates** menu
points to the download page. See [desktop update channels](../../../RELEASING.md#desktop-update-channels).

On first launch the background server creates its keys in the OS credential store,
or `keys.json` where there is none. See
[first launch](../../../notes/installable-releases.md#first-launch-os-credential-store-then-key-file).
