/** Electron composition root. No Electron or Node capability is exposed to the renderer. */
import { resolve } from "node:path";
import { app, BrowserWindow, dialog, Menu, session, shell } from "electron";
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
  Schema,
  Stream,
} from "effect";
import { OAuthCallbackPath } from "@executor-js/local-server/contracts";
import { DesktopFailed, externalUrl } from "./contracts/desktop.ts";
import { startBackend } from "./implementation/backend.ts";
import { release } from "../../../../scripts/releases/config.ts";
import { makeUpdateAction } from "./implementation/updates.ts";
import { makeOpenBrowserAction } from "./implementation/browser.ts";
import { startupUrl } from "./implementation/startup.ts";

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

let installUpdate: (() => void) | undefined;

const desktop = Effect.gen(function* () {
  const quit = yield* Deferred.make<void, DesktopFailed>();
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* Config.String("EXECUTOR_DESKTOP_DATA_DIR").pipe(
    Config.withDefault(
      app.isPackaged
        ? path.join(app.getPath("userData"), "data")
        : path.join(root, ".local/desktop"),
    ),
  );
  yield* fs.makeDirectory(directory, { recursive: true });
  const file = yield* rotatingJsonLogger(path.join(directory, "diagnostics"), "executor-desktop");
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
        browserSession.setPermissionRequestHandler((_contents, _permission, callback) =>
          callback(false),
        );
        browserSession.setPermissionCheckHandler(() => false);
        const windowOptions = {
          width: 1180,
          height: 800,
          minWidth: 760,
          minHeight: 540,
          title: "Executor",
          backgroundColor: "#111111",
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
        const startupWindow = yield* Effect.acquireRelease(
          Effect.sync(() => new BrowserWindow(windowOptions)),
          (current) =>
            Effect.sync(() => {
              if (!current.isDestroyed()) current.destroy();
            }),
        );
        startupWindow.once("closed", stop);
        startupWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        yield* Effect.tryPromise({
          try: () => startupWindow.loadURL(startupUrl),
          catch: () => new DesktopFailed({ stage: "window" }),
        });
        if (!startupWindow.isDestroyed()) startupWindow.show();
        yield* Effect.logInfo("Starting the local server");
        const token = Redacted.make(
          Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join(""),
        );
        const backend = yield* startBackend({
          executable: app.isPackaged
            ? path.join(root, "node", process.platform === "win32" ? "node.exe" : "node")
            : process.execPath,
          entry: path.join(
            root,
            app.isPackaged ? "desktop-server.mjs" : "apps/local/desktop/src/server.ts",
          ),
          cwd: root,
          directory: path.resolve(directory),
          collectorBundle: app.isPackaged
            ? path.join(root, "node_modules/@executor-js/telemetry/dist/motel")
            : path.join(__dirname, "motel"),
          development: !app.isPackaged && process.argv.includes("--dev"),
          token,
        });
        let window: BrowserWindow | undefined;
        let firstWindow = true;
        let pendingOAuthState: string | undefined;
        const openExternal = (value: string) => {
          const url = externalUrl(value);
          if (url === undefined) return;
          const redirect = url.searchParams.get("redirect_uri");
          const state = url.searchParams.get("state");
          if (redirect === `${backend.origin}${OAuthCallbackPath}` && state !== null)
            pendingOAuthState = state;
          void shell.openExternal(url.href).catch(() => {
            if (!Deferred.isDoneUnsafe(quit)) failed("oauth");
          });
        };
        const createWindow = () => {
          if (window !== undefined && !window.isDestroyed()) {
            window.show();
            window.focus();
            return;
          }
          const current = firstWindow ? startupWindow : new BrowserWindow(windowOptions);
          window = current;
          if (process.argv.includes("--devtools"))
            current.webContents.openDevTools({ mode: "detach" });
          current.once("ready-to-show", () => {
            if (!current.isDestroyed()) current.show();
          });
          current.webContents.once("did-finish-load", () => {
            if (!current.isDestroyed()) current.webContents.setBackgroundThrottling(true);
          });
          current.once("closed", () => {
            if (window === current) window = undefined;
          });
          current.webContents.on("will-attach-webview", (event) => event.preventDefault());
          current.webContents.on("will-navigate", (event, url) => {
            if (new URL(url).origin !== backend.origin) {
              event.preventDefault();
              openExternal(url);
            }
          });
          current.webContents.on("will-redirect", (event, url) => {
            if (new URL(url).origin !== backend.origin) {
              event.preventDefault();
              openExternal(url);
            }
          });
          current.webContents.setWindowOpenHandler(({ url }) => {
            openExternal(url);
            return { action: "deny" };
          });
          current.webContents.on("render-process-gone", (_event, details) => {
            run(Effect.logError("Desktop renderer exited", details));
            failed("window");
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
          const url = firstWindow ? backend.pairingUrl : backend.origin;
          firstWindow = false;
          void current.loadURL(url).catch(() => {
            if (!current.isDestroyed()) failed("window");
          });
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
        const checkForUpdates = yield* makeUpdateAction((install) => {
          installUpdate = install;
          stop();
        });
        const openBrowser = yield* makeOpenBrowserAction(browserSession, backend.origin);
        Menu.setApplicationMenu(
          Menu.buildFromTemplate([
            ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
            {
              label: "File",
              submenu: [
                { label: "Open in browser", click: () => run(openBrowser) },
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
          ]),
        );
        createWindow();
        startupWindow.removeListener("closed", stop);
        yield* backend.callbacks.pipe(
          Stream.runForEach(({ url }) =>
            Effect.gen(function* () {
              const callback = new URL(Redacted.value(url));
              if (
                callback.origin !== backend.origin ||
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
          Effect.annotateLogs({ origin: backend.origin }),
        );
        yield* backend.exited;
      }),
      Deferred.await(quit),
    );
  }).pipe(
    Effect.tapCause((cause) => Effect.logError("Desktop stopped", cause)),
    Effect.provide(Logger.layer([Logger.withConsoleError(Logger.formatJson), file])),
  );
});

if (!app.requestSingleInstanceLock()) app.quit();
else
  void Effect.runPromiseExit(Effect.scoped(desktop).pipe(Effect.provide(NodeServices.layer))).then(
    (result) => {
      if (Exit.isFailure(result)) {
        const error = Cause.findErrorOption(result.cause);
        const stage =
          Option.isSome(error) && Schema.is(DesktopFailed)(error.value)
            ? error.value.stage
            : "configuration";
        console.error(`Executor desktop failed at ${stage}.`);
        dialog.showErrorBox(
          "Executor could not continue",
          app.isPackaged
            ? "The desktop window or its local server stopped. Check the configured keys and restart Executor Preview."
            : "The desktop window or its local server stopped. Check the configured keys and restart with bun run desktop:dev.",
        );
      }
      if (Exit.isSuccess(result) && installUpdate !== undefined) installUpdate();
      else app.exit(Exit.isFailure(result) ? 1 : 0);
    },
  );
