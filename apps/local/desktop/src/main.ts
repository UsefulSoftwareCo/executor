/** Electron composition root. No Electron or Node capability is exposed to the renderer. */
import { resolve } from "node:path";
import { app, BrowserWindow, dialog, Menu, nativeTheme, session, shell } from "electron";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { rotatingJsonLogger } from "@executor-js/telemetry/files";
import { startProcessMetrics } from "@executor-js/telemetry/process";
import {
  Cause,
  Config,
  Deferred,
  Effect,
  Exit,
  FiberSet,
  FileSystem,
  Logger,
  Option,
  Path,
  Redacted,
  Ref,
  Schema,
  Stream,
} from "effect";
import { OAuthCallbackPath } from "@executor-js/local-server/contracts";
import { DesktopFailed, externalUrl, type DesktopRecovery } from "./contracts/desktop.ts";
import { startBackend } from "./implementation/backend.ts";
import { release } from "../../../../scripts/releases/config.ts";
import { makeUpdater } from "./implementation/updates.ts";
import { makeOpenBrowserAction } from "./implementation/browser.ts";
import { startupUrl } from "./implementation/startup.ts";
import { makeSupervisor } from "./implementation/supervisor.ts";
import {
  isRecoveryLink,
  recoveryAction,
  recoveryActions,
  recoveryUrl,
} from "./implementation/recovery.ts";
import { makeResetAction } from "./implementation/reset.ts";
import { makePortAction, readSettings, type PortSource } from "./implementation/settings.ts";
import { makeExportDiagnosticsAction } from "./implementation/diagnostics.ts";
import { makeRotateKeyAction, rotateAfterStop } from "./implementation/rotation.ts";
import type { ChildProcessSpawner } from "effect/process";

const root = app.isPackaged
  ? resolve(process.resourcesPath, "runtime")
  : resolve(__dirname, "../../../..");
app.setName(app.isPackaged ? release.desktop.productName : "Executor (Dev)");
if (process.env.EXECUTOR_DESKTOP_PROFILE_DIR !== undefined)
  app.setPath("userData", resolve(process.env.EXECUTOR_DESKTOP_PROFILE_DIR));
else
  app.setPath(
    "userData",
    app.isPackaged
      ? resolve(app.getPath("appData"), release.desktop.dataName)
      : resolve(root, ".local/desktop-shell"),
  );

/** Renderer crashes reload the window this many times per window before the app gives up. */
const rendererReloads = 3;
const rendererReloadWindowMillis = 60_000;

/** The dashboard's `--background` token for the system appearance, painted before content loads. */
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff");

/** Electron's `loadURL` rejection names the URL whose main-frame load failed. */
const FailedLoad = Schema.Struct({ url: Schema.String });

/** What the window shows. A pairing link is one-use, so it is cleared once loaded. */
type View =
  | { readonly kind: "starting" }
  | { readonly kind: "ready"; readonly origin: string; readonly pairing: string | undefined }
  | { readonly kind: "recovery"; readonly recovery: DesktopRecovery };

const desktop = Effect.gen(function* () {
  const quit = yield* Deferred.make<void, DesktopFailed>();
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const directory = path.resolve(
    yield* Config.String("EXECUTOR_DESKTOP_DATA_DIR").pipe(
      Config.withDefault(
        app.isPackaged
          ? path.join(app.getPath("userData"), "data")
          : path.join(root, ".local/desktop"),
      ),
    ),
  );
  const diagnostics = path.join(directory, "diagnostics");
  // Beside the data directory, so a reset is a same-volume rename.
  const backups = path.join(path.dirname(directory), "backups");
  yield* fs.makeDirectory(directory, { recursive: true });
  const log = yield* rotatingJsonLogger(diagnostics, "executor-desktop");
  const environmentPort = yield* Config.String("EXECUTOR_PORT").pipe(Config.option);
  const source: PortSource = Option.isSome(environmentPort)
    ? { kind: "environment", port: environmentPort.value }
    : Option.match(
        yield* readSettings(directory).pipe(
          Effect.mapError(() => new DesktopFailed({ stage: "configuration" })),
        ),
        {
          onNone: () => ({ kind: "default" }),
          onSome: (settings) => ({ kind: "setting", port: settings.port }),
        },
      );
  const backendEntry = {
    executable: app.isPackaged
      ? path.join(root, "node", process.platform === "win32" ? "node.exe" : "node")
      : process.execPath,
    entry: path.join(
      root,
      app.isPackaged ? "desktop-server.mjs" : "apps/local/desktop/src/server.ts",
    ),
    cwd: root,
    directory,
  };
  return yield* Effect.gen(function* () {
    yield* startProcessMetrics("executor-desktop");
    const run = yield* FiberSet.makeRuntime();
    yield* Effect.logInfo("Starting Executor desktop");
    const onException = (error: Error) => {
      run(Effect.logError("Desktop uncaught exception", Cause.die(error)));
    };
    process.on("uncaughtExceptionMonitor", onException);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => process.removeListener("uncaughtExceptionMonitor", onException)),
    );
    // Updates, restarts and key rotation run after every window and the local server have shut
    // down. Each yields the final synchronous step that ends this process.
    const afterStop = yield* Ref.make(
      Option.none<Effect.Effect<() => void, never, ChildProcessSpawner.ChildProcessSpawner>>(),
    );
    const relaunch = () => {
      app.relaunch();
      app.exit(0);
    };
    const stop = () => {
      Effect.runSync(Deferred.succeed(quit, undefined));
    };
    const failed = (stage: (typeof DesktopFailed.Type)["stage"]) => {
      Effect.runSync(Deferred.fail(quit, new DesktopFailed({ stage })));
    };
    const beforeQuit = (event: Electron.Event) => {
      event.preventDefault();
      stop();
    };
    app.on("before-quit", beforeQuit);
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        app.removeListener("before-quit", beforeQuit);
        process.removeListener("SIGTERM", stop);
        process.removeListener("SIGINT", stop);
      }),
    );
    yield* Effect.raceFirst(
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => app.whenReady(),
          catch: () => new DesktopFailed({ stage: "window" }),
        });
        const browserSession = session.fromPartition("executor-desktop");
        const windowOptions = {
          width: 1180,
          height: 800,
          minWidth: 760,
          minHeight: 540,
          title: "Executor",
          show: false,
          webPreferences: {
            backgroundThrottling: false,
            session: browserSession,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
          },
        };

        let view: View = { kind: "starting" };
        let everReady = false;
        let window: BrowserWindow | undefined;
        let pendingOAuthState: string | undefined;
        const origin = () => (view.kind === "ready" ? view.origin : undefined);
        // The dashboard's copy buttons need clipboard writes; every other permission stays denied.
        browserSession.setPermissionRequestHandler((_contents, permission, callback, details) =>
          callback(
            permission === "clipboard-sanitized-write" &&
              new URL(details.requestingUrl).origin === origin(),
          ),
        );
        browserSession.setPermissionCheckHandler(() => false);
        const viewUrl = () => {
          switch (view.kind) {
            case "starting":
              return startupUrl;
            case "recovery":
              return recoveryUrl(view.recovery);
            case "ready": {
              const url = view.pairing ?? view.origin;
              view = { ...view, pairing: undefined };
              return url;
            }
          }
        };
        // A newer load supersedes an older one; only the current load's failure matters.
        let loads = 0;
        const load = (current: BrowserWindow, url: string) => {
          const generation = ++loads;
          void current.loadURL(url).catch((error: unknown) => {
            if (current.isDestroyed() || generation !== loads) return;
            // The dashboard may be mid-restart. Its own failure can name its normalized or
            // redirected URL, so any failure is reported.
            if (!url.startsWith("data:")) {
              run(Effect.logWarning("Desktop window could not load the dashboard"));
              return;
            }
            // The app's own documents must load. Electron rejects a load when any main-frame load
            // fails before it finishes, also the replaced document's: on Windows a dashboard still
            // loading when its server exits reports its abort after this page has committed. A
            // data: document never redirects, so a failure naming another URL is not its own.
            if (Schema.is(FailedLoad)(error) && !error.url.startsWith("data:")) return;
            failed("window");
          });
        };
        const showView = () => {
          if (window !== undefined && !window.isDestroyed()) load(window, viewUrl());
        };

        const openExternal = (value: string) => {
          const url = externalUrl(value);
          if (url === undefined) return;
          const redirect = url.searchParams.get("redirect_uri");
          const state = url.searchParams.get("state");
          if (redirect === `${origin()}${OAuthCallbackPath}` && state !== null)
            pendingOAuthState = state;
          void shell.openExternal(url.href).catch(() => {
            if (!Deferred.isDoneUnsafe(quit)) failed("oauth");
          });
        };
        const showLogs = () =>
          shell.showItemInFolder(path.join(diagnostics, "executor-desktop.jsonl"));

        const supervisor = yield* makeSupervisor({
          start: (token) =>
            startBackend({
              ...backendEntry,
              port: source.kind === "setting" ? source.port : undefined,
              collectorBundle: app.isPackaged
                ? path.join(root, "packages/telemetry/dist/motel")
                : path.join(__dirname, "motel"),
              development: !app.isPackaged && process.argv.includes("--dev"),
              token,
            }),
          quitting: Deferred.isDone(quit),
          onStarting: Effect.sync(() => {
            const shown = window !== undefined && !window.isDestroyed() ? window : undefined;
            view = { kind: "starting" };
            if (shown !== undefined && shown.webContents.getURL() !== startupUrl) showView();
          }),
          onReady: (backend, ready) =>
            Effect.gen(function* () {
              view = { kind: "ready", origin: ready, pairing: backend.pairingUrl(ready) };
              everReady = true;
              showView();
              yield* backend.callbacks.pipe(
                Stream.runForEach(({ url }) =>
                  Effect.gen(function* () {
                    const callback = new URL(Redacted.value(url));
                    if (
                      callback.origin !== ready ||
                      callback.pathname !== OAuthCallbackPath ||
                      pendingOAuthState === undefined ||
                      callback.searchParams.get("state") !== pendingOAuthState
                    )
                      return;
                    pendingOAuthState = undefined;
                    const current = window;
                    if (current === undefined || current.isDestroyed()) return;
                    yield* Effect.tryPromise({
                      try: () =>
                        current.loadURL(callback.href, {
                          extraHeaders: "x-executor-desktop-return: 1\r\n",
                        }),
                      catch: () => new DesktopFailed({ stage: "oauth" }),
                    });
                    current.show();
                    current.focus();
                  }),
                ),
                Effect.catch((error) => Deferred.fail(quit, error)),
                Effect.forkScoped,
              );
              yield* Effect.logInfo("Executor desktop ready").pipe(
                Effect.annotateLogs({ origin: ready }),
              );
            }),
          onRecovery: (recovery) =>
            Effect.gen(function* () {
              yield* Effect.logWarning("Showing desktop recovery").pipe(
                Effect.annotateLogs({ recovery }),
              );
              view = { kind: "recovery", recovery };
              createWindow();
            }),
        });
        const reset = yield* makeResetAction({
          supervisor,
          directory,
          backups,
          appVersion: app.getVersion(),
          whileMoving: log.whileMoving,
          window: () => window,
        });

        const recover = (current: BrowserWindow, url: string) => {
          const action = recoveryAction(url);
          // Only the recovery page itself can trigger its actions, and only those it offered.
          if (
            Option.isNone(action) ||
            view.kind !== "recovery" ||
            current.webContents.getURL() !== recoveryUrl(view.recovery) ||
            !recoveryActions(view.recovery).includes(action.value)
          )
            return;
          switch (action.value) {
            case "restart":
              return run(supervisor.start);
            case "logs":
              return showLogs();
            case "reset":
              return run(reset);
            case "quit":
              return stop();
          }
        };

        const followAppearance = () => {
          if (window !== undefined && !window.isDestroyed())
            window.setBackgroundColor(windowBackground());
        };
        nativeTheme.on("updated", followAppearance);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => nativeTheme.removeListener("updated", followAppearance)),
        );
        const createWindow = () => {
          if (window !== undefined && !window.isDestroyed()) {
            showView();
            window.show();
            window.focus();
            return;
          }
          const current = new BrowserWindow({
            ...windowOptions,
            backgroundColor: windowBackground(),
          });
          window = current;
          if (process.argv.includes("--devtools"))
            current.webContents.openDevTools({ mode: "detach" });
          current.once("ready-to-show", () => {
            if (!current.isDestroyed()) current.show();
          });
          current.webContents.on("did-finish-load", () => {
            if (!current.isDestroyed() && origin() !== undefined)
              current.webContents.setBackgroundThrottling(true);
          });
          current.once("closed", () => {
            if (window === current) window = undefined;
            // Closing the window before the server was ever ready ends the launch.
            if (!everReady) stop();
          });
          current.webContents.on("will-attach-webview", (event) => event.preventDefault());
          const navigate = (event: Electron.Event, url: string) => {
            if (isRecoveryLink(url)) {
              event.preventDefault();
              recover(current, url);
              return;
            }
            if (new URL(url).origin !== origin()) {
              event.preventDefault();
              openExternal(url);
            }
          };
          current.webContents.on("will-navigate", navigate);
          current.webContents.on("will-redirect", navigate);
          current.webContents.setWindowOpenHandler(({ url }) => {
            openExternal(url);
            return { action: "deny" };
          });
          const crashes: number[] = [];
          current.webContents.on("render-process-gone", (_event, details) => {
            run(Effect.logError("Desktop renderer exited", details));
            if (details.reason === "clean-exit" || current.isDestroyed()) return;
            const now = Date.now();
            crashes.splice(
              0,
              crashes.length,
              ...crashes.filter((at) => now - at < rendererReloadWindowMillis),
              now,
            );
            if (crashes.length > rendererReloads) return failed("renderer");
            load(current, view.kind === "ready" ? view.origin : viewUrl());
          });
          current.webContents.on("console-message", (details) => {
            run(
              Effect.logInfo(details.message).pipe(
                Effect.annotateLogs({
                  process: "renderer",
                  level: details.level,
                  source: details.sourceId,
                  line: details.lineNumber,
                }),
              ),
            );
          });
          load(current, viewUrl());
        };
        const allClosed = () => {
          if (process.platform !== "darwin") stop();
        };
        app.on("activate", createWindow);
        app.on("second-instance", createWindow);
        app.on("window-all-closed", allClosed);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            app.removeListener("activate", createWindow);
            app.removeListener("second-instance", createWindow);
            app.removeListener("window-all-closed", allClosed);
            for (const current of BrowserWindow.getAllWindows()) current.destroy();
          }),
        );
        const after = (
          step: Effect.Effect<() => void, never, ChildProcessSpawner.ChildProcessSpawner>,
        ) => {
          Effect.runSync(Ref.set(afterStop, Option.some(step)));
          stop();
        };
        const checkForUpdates = yield* makeUpdater((install) => after(Effect.succeed(install)));
        const openBrowser = yield* makeOpenBrowserAction(browserSession, origin);
        const changePort = yield* makePortAction({
          directory,
          current: () => {
            const current = origin();
            return current === undefined ? undefined : Number(new URL(current).port);
          },
          source,
          parent: () => window,
          restart: () => after(Effect.succeed(relaunch)),
        });
        const rotateKey = yield* makeRotateKeyAction(() =>
          after(rotateAfterStop(backendEntry).pipe(Effect.as(relaunch))),
        );
        const exportDiagnostics = yield* makeExportDiagnosticsAction({
          directory,
          origin,
          source,
        });
        Menu.setApplicationMenu(
          Menu.buildFromTemplate([
            ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
            {
              label: "File",
              submenu: [
                { label: "Open in browser", click: () => run(openBrowser) },
                { type: "separator" },
                { label: "Server port…", click: () => run(changePort) },
                { label: "Rotate local API key…", click: () => run(rotateKey) },
                { type: "separator" },
                { role: process.platform === "darwin" ? "close" : "quit" },
              ],
            },
            ...(app.isPackaged
              ? [
                  {
                    label: "Updates",
                    submenu: [{ label: "Check for updates…", click: () => run(checkForUpdates) }],
                  },
                ]
              : []),
            { role: "editMenu" },
            { role: "viewMenu" },
            { role: "windowMenu" },
            {
              role: "help",
              submenu: [
                { label: "Show diagnostics folder", click: () => void shell.openPath(diagnostics) },
                { label: "Export diagnostics…", click: () => run(exportDiagnostics) },
                { type: "separator" },
                { label: "Reset Executor data…", click: () => run(reset) },
              ],
            },
          ]),
        );
        createWindow();
        yield* supervisor.start;
        return yield* Effect.never;
      }),
      Deferred.await(quit),
    );
    return yield* Ref.get(afterStop);
  }).pipe(
    Effect.tapCause((cause) => Effect.logError("Desktop stopped", cause)),
    // Said before the scope closes, while the diagnostics location is known.
    Effect.tapErrorTag("DesktopFailed", (error) =>
      error.stage === "renderer"
        ? Effect.sync(() =>
            dialog.showErrorBox(
              "Executor could not continue",
              `The Executor window kept crashing, so Executor quit. Its diagnostics are in:\n\n${diagnostics}`,
            ),
          )
        : Effect.void,
    ),
    Effect.provide(Logger.layer([Logger.withConsoleError(Logger.formatJson), log.logger])),
  );
});

if (!app.requestSingleInstanceLock()) app.quit();
else
  void Effect.runPromiseExit(
    Effect.scoped(desktop).pipe(
      // The step runs after the desktop scope closed, so the backend no longer holds its directory.
      Effect.flatMap(Effect.transposeOption),
      Effect.provide(NodeServices.layer),
    ),
  ).then((result) => {
    if (Exit.isFailure(result)) {
      const error = Cause.findErrorOption(result.cause);
      const stage =
        Option.isSome(error) && Schema.is(DesktopFailed)(error.value)
          ? error.value.stage
          : "configuration";
      console.error(`Executor desktop failed at ${stage}.`);
      // Server failures show the recovery page and a renderer crash loop has its own box.
      if (stage !== "renderer")
        dialog.showErrorBox(
          "Executor could not continue",
          app.isPackaged
            ? "The Executor window stopped. Restart Executor Preview."
            : "The Executor window stopped. Restart with bun run desktop:dev.",
        );
    }
    if (Exit.isSuccess(result) && Option.isSome(result.value)) result.value.value();
    else app.exit(Exit.isFailure(result) ? 1 : 0);
  });
