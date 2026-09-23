# Executor desktop

Electron owns a sandboxed window and a separate local server process. The window
uses the same dashboard, HTTP API, pairing exchange, and account model as the
browser app. No Node API or persistent API key is exposed to the renderer.

Release installers include the official Node distribution matching the CLI build
toolchain. The builder verifies its upstream checksum and retains its license
notices. The packaged backend runs with that executable; development continues
to use Electron in Node mode.

## Run

Use Node 22.23+ and an authenticated 1Password CLI. Create an ignored
`.env.development.op` in the repository root with 1Password references for
`EXECUTOR_API_KEY` and `EXECUTOR_ENCRYPTION_KEY`. The resolved values must meet
the [local server configuration](../server/README.md#configuration) requirements.
Then run from the repository root:

```sh
bun install
bun run desktop:dev
```

This builds the Electron main entry, creates a locally signed macOS development
bundle, and launches the app with Vite hot reload. Electron supplies the backend's
Node runtime. After changes to Electron or server source, rerun
`bun run desktop:dev` to rebuild and restart.

On macOS, reopen `.local/desktop-runtime/Executor Dev.app` from Finder. Its launcher
resolves the repository's ignored `.env.development.op` through `op run` each time.
It writes no resolved credentials to disk. The bundle remains attached to this
workspace, like T3 Code's development launcher. It is not a release installer.
Finder launches write diagnostics to `.local/desktop.log`.

To use the built dashboard instead of Vite:

```sh
bun run desktop:start
```

Quit the current instance before switching modes. A second launch focuses the
existing app. Closing the last macOS window keeps the server running; reopening
from the Dock restores the dashboard. **Quit Executor** stops both the app and
its server. Ctrl+C also stops a terminal launch.

Use **File → Open in browser** to connect your system browser to this desktop's
server. It opens an authenticated dashboard with a one-use link. No CLI is needed;
MCP clients can then use that browser for local consent.

## Runtime

- `.local/desktop/` holds the desktop database and retained builds. Set
  `EXECUTOR_DESKTOP_DATA_DIR` to choose another directory. Do not point two running
  hosts at the same data directory.
- `.local/desktop-shell/` holds Chromium's application profile. Browser session
  cookies use an in-memory partition and are replaced by a new pairing on launch.
- The backend uses port 4312 unless `EXECUTOR_PORT` selects another port. Its URL, also the MCP base URL, is
  printed after readiness. It uses the existing explicitly configured API and
  encryption keys; startup does not generate persistent keys.
- Private fd3 carries a one-use bootstrap token. Stdout carries only readiness.
  Electron waits for the parsed ready message before loading its window.
- Private fd4 returns OAuth callbacks from the system browser. The parent accepts
  only the currently pending state and loads the callback in the original window,
  retaining its session and return intent. The server still validates the OAuth
  attempt and credentials. Closing that window during consent requires retrying.
- External HTTP(S) links open in the system browser. Other schemes and embedded
  Node access are disabled. App-origin launch links also open in the browser.
- Desktop warms the entry graph and keeps the renderer unthrottled during startup.
  HMR uses a separate ephemeral loopback listener and Vite cache, so it can
  run alongside the browser development server.
- Failed startup, server exit, and renderer failure produce a safe native error.
  Shutdown is scoped and force-kills an unresponsive backend after four seconds.

## T3 Code reference

Reviewed `pingdotgg/t3code` at `93e04160` (2026-09-18). The ignored checkout is
`.reference/t3code-desktop/`. The main references are:

- `apps/desktop/src/backend/DesktopBackendManager.ts`: scoped backend process,
  private bootstrap pipe, readiness, and bounded shutdown.
- `apps/desktop/src/backend/DesktopBackendConfiguration.ts`: run Electron's binary
  in Node mode for the server.
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

## Verification

```sh
node --test apps/local/desktop/test/server.test.ts
```

The integration test starts the real server with isolated test data. It checks
one-use pairing, session authentication, private OAuth relay, callback rendering,
and listener shutdown. Live provider consent is a separate check; the relay test
does not claim Google or another provider has authorized an account.

## Persistent diagnostics

Startup builds and copies the standalone Motel collector into `dist/motel`.
The backend owns it and persists traces/logs under its data directory's
`diagnostics/`. The Electron parent records startup, backend stderr, exits and
renderer messages in `executor-desktop.jsonl`; stdout and private callback
pipes remain protocol-only. See [telemetry](../../../notes/telemetry.md#frontend-lifetime-and-local-diagnostics)
for retention, query URLs, and the JSONL files an agent can inspect.

## Packaged preview

Build the CLI runtime with `bun run release:cli`, then run
`bun run release:desktop 0.0.0-preview.local`. Add `--dir` to build an unpacked
application for inspection. Output lives in `.local/releases/`.

The preview is named **Executor Preview**, with a separate app ID and persistent
Electron user-data directory. It contains the server, dashboard, framework,
compiler, Git, SDK dependencies and collector. It does not load `.env` files, call 1Password,
require a workspace or use the original Executor updater. The parent still owns
private bootstrap/callback pipes and waits for backend shutdown before updating.

The backend uses the local server's default port, 4312, or an explicit `EXECUTOR_PORT`.
It keeps the same MCP URL after a restart. Use another fixed port when running a
second installation. Development and tests can explicitly request port 0.

Artifacts are unsigned and have no update feed. The **Updates** menu states that
clearly. The updater requires explicit download and restart confirmation once a
signed build has a configured feed. macOS signing/notarization, Windows signing,
and the public release feed remain release gates, not automatic build behavior.

For now start the executable with explicitly supplied API/encryption keys in its
environment. That works independently of the repository, but a complete Finder
first-run setup is still needed. See [the pending first-launch decision](../../../notes/installable-releases.md#first-launch-storage-decision-pending).
