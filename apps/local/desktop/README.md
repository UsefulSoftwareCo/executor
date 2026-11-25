# Executor desktop

Electron owns sandboxed windows onto the accounts a person uses: this computer's
own Executor, the background server the CLI uses, and any number of teams on Executor
Cloud or self-hosted servers ([Accounts](#accounts)). The windows use the same
dashboards, HTTP APIs, pairing exchange and account model as the browser. No Node
API or persistent API key is exposed to the renderer. The only bridges are the two in
[Installed apps](#installed-apps).

## First run

The local server starts only when the person uses it. A launch starts or joins it when
the data directory holds data (`installation.json` or a database, as the CLI's or an
earlier desktop's leave it, including an old desktop directory the move below takes
over), or when `desktop-accounts.json` in the Electron user-data directory records that
**Run locally** was chosen. Existing users therefore open straight to their local
dashboard. Otherwise, with no signed-in account either, the desktop shows a small
script-free welcome window: **Sign in** (browser sign-in to Executor Cloud,
`https://app.executor.sh`, or `EXECUTOR_DESKTOP_CLOUD_ORIGIN` for development and tests),
**Run locally**, and a **Customize** popover with a self-hosted server's address. Like
every desktop-owned page, its buttons are navigations to `executor-welcome:` that the
main process intercepts. While a sign-in waits for the browser the window says **Finish
signing in in your browser**, with **Open the page again** and **Cancel**; a sign-in that
is cancelled, declined, refused or cannot reach the server returns to the welcome page
with a short message. A Cloud-only desktop never starts the local server, and its File
menu has none of the local server's actions. An `executor://app` link to an app on this
computer's Executor, or an install link from it, shows the welcome window with a line
saying so instead of starting the server; an app link waits and opens once **Run locally**
is chosen. (Having chosen Run locally once, the server always starts with the desktop.) The desktop log is still written under the
data directory's `diagnostics/`.

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

- When the person uses it ([First run](#first-run)), the desktop shares the CLI's data
  directory and its one background server:
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
  intercepts; the page has no bridge. Reset is never offered when the OS
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

## Installed apps

An app with a UI can be installed as its own app on this computer. The dashboard window's
preload (`src/preload-host.ts`) exposes `__executorDesktopHost` (`DesktopHostBridge` in
`packages/apps/src/contracts/desktop.ts`) only while it shows the server's dashboard origin.
Installing shows one native dialog with the app's icon (or a monogram when it has none).
Installed apps and their permissions live only on this device, in `installed-apps.json` in
the Electron user-data directory, keyed by the account (the local server's ID from
`/.well-known/executor`, or `<server ID>.<organization ID>` for a team) and the app's ID; the app's address, name and icon are read again from the server each time it opens,
so renames survive. A local server that does not confirm its identity keeps installed apps
closed. Installs an earlier desktop kept under the server ID `local` move to the local server's
real ID once, the first time it answers, with their launchers rewritten for the new link. A file
the desktop cannot read, other than a missing one, is left untouched and
turns installing and opening apps off until it is fixed. Each install has its own ID and a
permission revision; a permission answer is saved only if neither changed while its dialog was
open, and every menu-bar item, shortcut, floating window and notification is checked against
the current grant right before it is applied.

- **Server connection.** Links to installed apps wait until the desktop has confirmed the
  server's identity and exchanged a pairing token for its own session cookie, so a launcher
  that starts Executor opens the app signed in. When the server goes away every installed
  app's windows, menu-bar item, shortcuts and floating end. Once the server is back, only the
  same server ID reopens them; each window's bridge is bound to that one running instance.

- **Launchers.** macOS gets a generated `.app` in `~/Applications/Executor Apps/` whose
  executable runs `open -b <Executor's bundle ID> executor://app/<server>/<app>`, with an
  `.icns` drawn from the app's `icon.svg` in a hidden window. Windows gets a Start Menu
  shortcut in `Executor Apps` with the app's own AppUserModelID and `.ico`, which starts
  Executor with the link. Linux gets no launcher. A name another file holds is never replaced:
  the desktop uses the first of `Name`, `Name <6 hex>` and `Name <16 hex>` that is free or
  already carries this app's bundle identifier or AppUserModelID. Removing an app moves its
  macOS launcher to the Trash or deletes its shortcut, only when it sits directly in
  `Executor Apps` and carries that identifier. A second launch with an `executor://app/…` link, or
  macOS's `open-url`, opens that app instead of the dashboard.
- **When it can't open.** An app whose account is signed out opens a page that says **Sign in
  again to open <App>** with a button that starts the sign-in; an app its server no longer has,
  or no longer gives a page, says **<App> is no longer available** with **Uninstall**; an app
  whose server does not answer, including the local server after it stopped, names the server
  and offers **Retry**. These pages are script-free and their buttons navigate to
  `executor-app-state:`.
- **Windows.** Each installed app opens in its own window on its app origin, in its account's
  dashboard session, so the app's normal sign-in completes without a prompt. The title is the
  app's name, followed by the organization's for a hosted server's app (`App — Team`). Top-level
  navigation stays on the app's origin and its server's `/app-auth` page; a redirect elsewhere
  is blocked. Another page, or a `window.open`, goes to the system
  browser only within five seconds of a click or key press in that window; otherwise it is
  blocked. Iframes load as on the web but get no bridge and never reach the system browser.
  A renderer that crashes releases the app's shortcuts, floating and menu-bar title and
  reloads, up to three times a minute; the fourth crash ends the app. Window bounds are
  remembered per app.
- **App bridge.** `src/preload-app.ts` exposes `__executorDesktop` (`DesktopAppBridge`) only
  when the main process confirms the page is an installed app's window or popover on that
  app's exact origin, and the main process checks this again on every call.
- **Permissions** (`menuBar`, `shortcuts`, `floating`, `startAtLogin`, `microphone`, `camera`,
  `systemAudio`, `clipboardRead`, `notifications`) are per app, off until first use, asked once
  in a native dialog and kept until changed in the app's menu, its menu-bar item's menu or the
  dashboard. `requestPermission` asks without using the capability, which is the only way to
  ask for `startAtLogin`. The web `Notification` API, `getUserMedia` (`microphone` for audio,
  `camera` for video) and `navigator.clipboard.readText()` (`clipboardRead`) work only for an
  app whose permission is granted, only in the app's own main document, and only while it runs;
  writing to the clipboard needs nothing. Revoking `microphone`, `camera` or `systemAudio`
  reloads the app's windows, which ends a recording in progress. The page's `Notification` is
  the desktop's own: with the permission granted, the main process shows it with Electron's
  `Notification` under a 36-character ID (Chromium's own notification ID, which Windows uses as
  the toast's tag, is too long for an app origin), relays `show`, `click`, `close` and `error`
  back to the page, and closes an earlier notification with the same `tag`; on Windows and
  macOS a notification the system refuses reports `error`. Clicking a shown notification
  focuses the app and, when the app created it with `data: { path }`, opens that path on the
  app's origin; a click a script dispatches does nothing.
- **macOS capture.** Packaged and development bundles carry `NSMicrophoneUsageDescription`,
  `NSCameraUsageDescription` and `NSAudioCaptureUsageDescription`
  (`assets/mac-usage-descriptions.json`), and the hardened runtime has the audio-input and
  camera entitlements. After the app's own prompt, macOS asks once for Executor itself
  (`systemPreferences.askForMediaAccess`); if the person refuses there, `getUserMedia` fails
  with `NotAllowedError`. The page's `getUserMedia` asks both before Chromium starts any capture,
  so neither prompt follows a device being touched.
- **System audio.** `desktop.audio.system()` asks for `systemAudio`, then calls
  `getDisplayMedia`; the session's display-media handler answers only an installed app's own
  main frame with that permission, with `audio: "loopback"` and the requesting frame itself as
  the video, which the client stops, so the app never sees the screen. Windows supports
  loopback; macOS 13 and later does through Chromium's `MacLoopbackAudioForScreenShare`
  feature, which the desktop enables, and needs Screen & System Audio Recording for Executor.
  When `systemPreferences.getMediaAccessStatus("screen")` is not `granted` the desktop shows
  **Allow Executor to record system audio** with **Open System Settings**, which registers
  Executor with a screen-source request and opens the Screen Recording pane, and the call
  rejects with `SystemAudioBlocked`. Linux and macOS before 13 report `systemAudio` as
  `unavailable`.
- **Window control.** `windowAction` shows, hides, focuses or toggles the window whose page
  called it. Focus restores a minimised window, shows it and activates it in front of other
  apps (`app.focus({ steal: true })` on macOS, a brief always-on-top on Windows). Each window
  sends its page `focus` and `blur` events. `openWindow` opens up to 8 more windows of the app
  at paths on its origin (reusing one that already shows the path), with the bridge, the app's
  guard, menus and taskbar identity; they close when the app ends.
- **Badge.** `setBadge` keeps a count per running app. Windows draws it as an overlay icon on
  each of the app's windows, whose taskbar button is the app's own (AppUserModelID). macOS and
  Linux have one Dock or launcher icon for Executor, since installed apps run in Executor's
  process and their launchers only open a link, so `app.setBadgeCount` shows the sum of every
  running app's count; Linux shows it only where the launcher supports counts. A count ends with
  its app.
- **Open at a path.** `executor://app/<server>/<app>/<path>?<query>` opens the app at that path
  on its origin, moving a running app's main window there; a link with a fragment, credentials or
  a port is refused.
- **Start at login.** While any installed app has `startAtLogin` granted, Executor has one login
  item that starts it with `--executor-login`: `app.setLoginItemSettings` on macOS (macOS 13
  may need it allowed in System Settings › General › Login Items, which the desktop offers to
  open) and Windows, and `~/.config/autostart/<name>-login.desktop` (`XDG_CONFIG_HOME`) on Linux.
  A login start shows no dashboard or welcome window: it picks the account a normal start would
  show, loads this computer's dashboard hidden when that is the one, opens a hosted account's
  dashboard only when Executor is activated, and starts the local server only if a normal start
  would. It opens each such app hidden once hosted accounts are loaded, where it keeps running without a window or menu-bar item until opened; an app
  that can't open then (signed out, unreachable) only logs it and shows its state page when
  opened. On macOS a login start is also recognised by `wasOpenedAtLogin`.
- **Downloads.** A download from an app window or popover (`<a download>`, a blob) asks where
  to save with `dialog.showSaveDialogSync`, starting at Downloads with the suggested name, parented
  to the window unless it is the popover; cancelling writes nothing, and on macOS the Downloads
  stack bounces when it finishes. Dashboard windows keep Electron's own handling.
- **Menu bar.** An app with a `ui/menubar.html` page asks for `menuBar` when it opens. Allowed,
  it gets a tray item (its title on macOS, its tooltip elsewhere) that toggles a frameless
  popover on `/_executor/menubar`, sized by `<meta name="executor:menubar"
content="width=…, height=…">` (default 320×400) and hidden when it loses focus. Its context
  menu opens, reloads or quits the app, changes permissions and removes the item. An app with
  a menu-bar item keeps running hidden when its window closes.
- **Shortcuts** are global and end when the app quits, crashes, is removed or loses the
  permission. Each needs CommandOrControl, Control, Command, Alt or Super (Shift alone is not
  enough), except F13 to F24 and media keys, and an app holds at most 8. The app's Permissions
  menu lists the ones it holds.

### Install links from a browser

A dashboard open in a browser has no host bridge. Its **Install as app** dialog shows the
homepage's download buttons (`DesktopDownload` in `packages/ui`, which the homepage uses too, so
platform detection and styling match), **Open in Executor**, which follows
`executor://install?server=<dashboard origin>&app=<app ID>`, with `&org=<organization ID>` on a
hosted server and the app's and team's names as `name` and `team` (`desktopInstallLink` and
`parseDesktopInstallLink` in `packages/apps/src/contracts/desktop.ts`), and **Nothing opened? Update
Executor**. On a phone or tablet, including an iPad that asks for desktop sites, it only says the
desktop app is for Mac and Windows. `server` must be `https`, or `http` on `localhost`,
`127.0.0.1` or `[::1]`; any other part, a repeated or unknown parameter, or an ID of another shape
refuses the link. `name` and `team` only label the desktop's prompt.

Any website can open such a link, so it grants nothing by itself. The desktop handles it like an
`executor://app/…` link (a second launch, macOS's `open-url`, or a cold start after the first
window opens), one link at a time: an identical link already waiting is ignored, and at most four
wait. It reads `GET {server}/.well-known/executor` without cookies, then:

- **This computer's server** (its `serverId` matches the local one; a cold start waits for it):
  shows the usual install dialog. A link naming an organization, another computer's local server,
  or a desktop that does not run locally is refused.
- **A team this computer is signed in to:** shows the usual install dialog, reading the app's name
  and icon with that account's token.
- **No account on that server:** a desktop-owned modal, **Sign in to install <App>**, names the
  team and host (on a local-only desktop: "You're using Executor on this computer… Your local apps
  stay as they are."), with **Not now** and **Sign in**. Sign in runs browser sign-in; the
  install dialog follows when the chosen team is the link's.
- **Another team on a server it is signed in to:** **<App> is in <Team>**, with the team's mark on
  the app's tile, offers **Sign in to <Team>**; the other team stays signed in.
- **A team that must sign in again:** the same modal with **Sign in again**.
- **No identity, a malformed link, an app it cannot reach, or one that does not exist, is not the
  person's or has no page:** a modal says why.

A link to an app that is already installed opens it. Otherwise the app opens once the install
dialog is accepted. Modals are script-free pages whose buttons navigate to `executor-prompt:`.

`e2e/tests/desktop-apps.spec.ts` covers local links with the recovery scenarios; the hosted cases
are in `e2e/tests/desktop-servers.spec.ts`.

## Accounts

Beside this computer's Executor, the desktop holds any number of accounts on hosted Executor
servers (Cloud or self-hosted): one per team, keyed by the server's `serverId` and the
organization ID, so several teams on one server (Acme and Northwind on Cloud) are separate
accounts, each with its own session partition and installs. `servers.json` (version 2) lists
them. `desktop-accounts.json` records whether Run locally was chosen and the account used last,
which the next launch opens.

An account's dashboard origin is fixed once it is signed in. A sign-in or install link from a
server whose `serverId` an account already holds at another origin is refused, as is a server
that says it is Cloud (`kind: "cloud"`, or a `cloud-…` ID) anywhere but the Cloud origin the
desktop is configured with, and a `serverId` that does not start with its kind. An installed app
keeps the origin its permissions were granted on; when the server names another origin for it,
its permissions are cleared and its running windows close before it opens there.

The dashboards' bottom-left account button opens the switcher, a menu the desktop draws itself:
a frameless child window anchored above the button, built like the desktop's other pages (a
`data:` page with no script whose buttons navigate to `executor-account-menu:` actions), closed by
Escape, a click elsewhere or a choice. The dashboard only reads its own account through the host
bridge's `account` and `watchAccount` and asks for the menu with `openAccountMenu` and where its
button is; it never sees the other accounts, and switching, signing out and removing happen only
in the desktop's own windows (browser dashboards are unchanged). The menu lists every account with
its state (the current one checked), **Add account** (Sign in to Executor Cloud, Run locally when
it does not run, Self-hosted server…), Account settings, **Sign out of <team>** and **Remove from
this computer…**; a local-only desktop shows Sign in to Executor Cloud and Self-hosted server…
directly, and **Add account** opens its choices in the menu with a way back. Account settings
closes the menu and the dashboard opens its own settings page. Switching opens the account's dashboard in a window at the same place and closes the
previous one. States: **Sign in again** (its sign-in ended; its apps stay closed; the row signs
in), **Can't reach <host>** (its server did not answer; **Retry** asks again; still selectable),
and **Waiting for your browser…** (a sign-in in progress; **Cancel** ends it, and it stays until
then even if the browser closes). **Sign out** revokes the refresh token, closes the team's
windows and clears its partition, and keeps its installed apps, which ask to sign in again when
opened. **Remove** (from the menu, or right-clicking another team's row) also uninstalls its apps
and removes their launchers and permissions here; nothing changes on the server. Both confirm in
a desktop prompt window. The bridge only accepts calls from a dashboard window of a held account,
as every host call is origin- and session-checked, and it sets a permission to `denied` or
`prompt` at once but grants one only after the same native prompt an app's own request shows,
which names the app, its team and its host.

Signing in to a hosted server works as follows; the welcome window's Customize popover is the
form, with plain `http` accepted without asking only on loopback (`127.0.0.0/8`, `[::1]`,
`localhost` and `*.localhost`); any other `http` address shows "This server isn't encrypted. Your
sign-in would travel in plain text on this network." and signs in only once **Sign in without
encryption** is checked. The desktop then:

1. reads `GET /.well-known/executor` at the address entered and keys the server by its
   `serverId`; a local Executor is refused, and signing in again refuses an address that answers
   with another `serverId`. The answer's `origins` names the server's `dashboard`, `api` and
   `auth` (OAuth issuer) origins: one origin on local and self-host, Cloud's `app.`, `api.` and
   edge hosts. Each must use the entered address's scheme, and over `http` must be that address
   itself. When the dashboard is another origin, as when the apex is entered on Cloud, the
   dashboard must answer `/.well-known/executor` with the same server ID and origins. The record
   keeps the dashboard origin, whichever address was entered;
2. reads `/.well-known/oauth-protected-resource/api/desktop` on the API origin, whose resource
   must be `<api>/api/desktop` and whose issuer must be on the `auth` origin, and the issuer's
   `/.well-known/oauth-authorization-server/<issuer path>` on that origin. Every endpoint must be
   on the dashboard origin, where session links, `GET /api/auth/desktop/account` and the
   dashboard windows also live. Anything else is refused before the desktop registers;
3. listens on `http://127.0.0.1:<ephemeral port>/callback` and registers a client for that
   exact redirect. The listener answers 400 to any request whose `state` does not match
   (compared in constant time) or that carries neither `code` nor `error`, accepts only the first
   matching one and shows the signed-in page only for it, or for an exact repeat of it: Cloud's
   consent page navigates to the callback twice. Every other request after that gets 400, and the
   listener closes two seconds after the sign-in finishes, letting the browser's last request
   complete. Each sign-in registers again: a stored registration would need a fixed port
   that another program could hold, and the server already replaces the grants of an earlier
   registration with the same name and loopback redirect;
4. opens the system browser on the authorization endpoint with PKCE (S256), `scope=desktop
offline_access`, the resource and a state; the person picks the organization on the consent
   page;
5. exchanges the code, reads `GET /api/auth/desktop/account` (user and organization) with the
   access token, and saves the record in `servers.json` in the Electron user-data directory (mode
   `0600`): server ID, kind, dashboard origin, organization, account, endpoints and the refresh
   token sealed with Electron `safeStorage`. On a Linux session with no credential store,
   `safeStorage` falls back to its fixed-key text encryption, so the token is then protected only by
   the file's permissions, as `keys.json` is for the local server.

On a Linux session where `safeStorage` would use that fallback, the form says so.

Access tokens stay in memory and are refreshed (with rotation) when they expire or a call answers
401, one refresh at a time per account. Every write to `servers.json` checks that the record still
has the partition the caller read, so a refresh, a removal or a new sign-in never writes over
another. A refresh the server refuses (400 or 401) marks the account **Sign in again**: its
dashboard and app windows close, its partition's cookies and storage are cleared, its apps say so
instead of opening, and nothing falls back to another account. Signing in again must sign in the
same person to the same team on the same server, or it is refused and the new grant revoked.
Signing in to a team already held as another person replaces that account's sign-in (and revokes
the previous one) but keeps its installs.

Each account gets its own in-memory Electron session partition, never shared with the local
dashboard or another account. Opening its dashboard (switching to it, and after sign-in) mints a
bound session link (`POST /api/auth/desktop/session-link`), sets the binding cookie in that
partition (`__Host-executor-desktop-link` and `Secure` on https, `executor-desktop-link` on http,
host-only, `HttpOnly`, `SameSite=Lax`, expiring with the link) and loads the link in a window on that
partition, which gets the same host bridge as the local dashboard with `server` set to the
account's key. The link is loaded with the request header `X-Executor-Desktop-Link: 1`, which the
server requires: a page can't add a header to a navigation, so a link a page leads a browser to is
refused even over plain `http`, where browsers send no `Sec-Fetch-Site`. The binding cookie expires at the link's `expiresAt` or 60 seconds from now,
whichever is sooner. Checking the partition's session, minting a link, setting its cookie and
loading it run under one lock per account, so a dashboard and any number of apps opening at once
mint one link between them, and a dashboard that already has a session opens without one. A link
that lands on `/login` refreshes the access token: only a refused refresh marks the server
**Sign in again**. A request that cannot reach the server marks the account **Can't reach
<host>** until one succeeds or Retry finds it. Opening an installed hosted app reads its address with
`GET /api/organizations/:org/apps/:app/ui`, refuses an address on another scheme than the
server's, and, when the partition has no dashboard session for the account, redeems a fresh link
in a hidden window first.

The server records every session a link signs in against the desktop's grant, in Better Auth's
verification table (`executor-grant-session:v1:<session ID>`, valued with the grant ID, expiring
with the session and moved with it when it is extended). Revoking the desktop under Connected
agents, or deleting its consent, ends those sessions, so its windows are signed out on the server
too, and a link redeemed while the grant is revoked signs no one in. Such a session is pinned to
the organization the desktop was consented to: the server refuses its requests for any other
organization, lists only that one, and refuses creating or joining another. One grant mints at
most 20 links and reads its account at most 20 times a minute; a link that fails because the
server can't read or write its records answers 503 instead of sending the window to `/login`.

**Remove from this computer…** revokes the refresh token at the server's revocation endpoint (best
effort, and the result is logged) while holding the account's refresh lock, stops any dashboard
still opening, closes the account's windows, menu-bar items and shortcuts, uninstalls its apps from
this device with their launchers, and only then forgets the record and clears the partition's
storage. If the apps cannot all be removed the record stays and the removal says so. At startup,
installs kept for a hosted account (`self-host-…` or `cloud-…`) that `servers.json` no longer
holds are removed, unless `servers.json` is unreadable.

`e2e/tests/desktop-servers.spec.ts` covers this against a self-hosted server it starts beside the
desktop, two teams on one server against a small Cloud-shaped server (self-host holds one
organization), and discovery against a small fake server. The `e2e-desktop-servers` job of `checks.yml`
runs it when a file `e2e/desktop-servers-inputs.ts` lists changes: once with no credential store,
and once with a GNOME keyring unlocked on a private D-Bus session. It needs `bun run e2e:prepare`
and the built desktop entry:

````sh
node apps/local/desktop/scripts/build.mjs
xvfb-run -a bun run e2e:desktop-servers
``` Where a notification server answers, a granted notification must be
shown; a Linux session without one, such as Xvfb, records the granted case as unverified.

## Settings and diagnostics

**File → Server port…** opens a script-free form in its own sandboxed window. Submitting it is a
navigation to `executor-settings:` that the parent intercepts; the form has no preload or IPC
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
retained builds, the browser profile and the telemetry collector's store are never read. Logs are already
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

Executor keeps its existing same-origin HTTP/cookie protocol. Ordinary dashboard
operations use no preload or IPC bridge; only installing apps does. Distribution builds,
notarization, updates, and platform-specific release artifacts remain separate
from this workspace launcher. Windows and Linux have not been verified.

## Persistent diagnostics

The background server runs the telemetry collector and persists traces and logs under the
data directory's `diagnostics/`. The Electron parent records startup, connections,
recovery and renderer messages in `executor-desktop.jsonl` beside them. See
[telemetry](../../../notes/telemetry.md#frontend-lifetime-and-local-diagnostics)
for retention, query URLs, and the JSONL files an agent can inspect.

## Packaged preview

Build the CLI runtime with `bun run release:cli`, then run `bun run release:desktop`; both
build the version recorded in `apps/cli/package.json`. Add `--dir` to build an unpacked
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
````
