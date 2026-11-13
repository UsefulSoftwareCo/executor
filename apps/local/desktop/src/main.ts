/**
 * Electron composition root. The desktop shares the CLI's background Executor: it starts or joins
 * the server for the CLI's data directory and shows its dashboard. No Electron or Node capability
 * is exposed to the renderer.
 */
import { resolve } from "node:path";
import { app, BrowserWindow, dialog, Menu, nativeTheme, session, shell } from "electron";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { rotatingJsonLogger } from "@executor-js/telemetry/files";
import { startProcessMetrics } from "@executor-js/telemetry/process";
import {
  Cause,
  Config,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  FiberSet,
  FileSystem,
  Logger,
  Option,
  Path,
  Redacted,
  Ref,
  Result,
  Schema,
} from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { OAuthCallbackPath } from "@executor-js/local-server/contracts";
import { desktopReturnHeader } from "../../server/src/contracts/desktop-return.ts";
import { ServiceFailed } from "../../server/src/contracts/service.ts";
import { DesktopFailed, externalUrl, type DesktopRecovery } from "./contracts/desktop.ts";
import { release } from "../../../../scripts/releases/config.ts";
import { makeUpdater } from "./implementation/updates.ts";
import { makeOpenBrowserAction } from "./implementation/browser.ts";
import { movingUrl, startupUrl } from "./implementation/startup.ts";
import { makeConnection, type Connection } from "./implementation/connection.ts";
import {
  migrateDesktopData,
  type MoveNotice,
  noticeShown,
  pendingNotice,
} from "./implementation/migration.ts";
import { developmentRuntime, packagedRuntime } from "./implementation/runtime.ts";
import {
  isRecoveryLink,
  recoveryAction,
  recoveryActions,
  recoveryUrl,
} from "./implementation/recovery.ts";
import { makeResetAction } from "./implementation/reset.ts";
import { legacyPort, makePortAction, portSource } from "./implementation/settings.ts";
import { makeExportDiagnosticsAction } from "./implementation/diagnostics.ts";
import { makeQuitRecord } from "./implementation/quitting.ts";
import { announceRotation, makeRotateKeyAction, rotateKey } from "./implementation/rotation.ts";

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

/**
 * The desktop's record of its quit. Its uncaught exceptions are recorded for the whole life of the
 * process, also while the desktop's scope closes, after its own logger has stopped.
 */
const quitting = makeQuitRecord();
process.on("uncaughtExceptionMonitor", quitting.exception);

/** Renderer crashes reload the window this many times per window before the app gives up. */
const rendererReloads = 3;
const rendererReloadWindowMillis = 60_000;

/**
 * The dashboard is loaded this many times in a row, each time with a fresh pairing link, before
 * the window shows recovery. A load that has not finished within `dashboardLoadTimeout`, from a
 * server on this machine, is stuck. Each attempt after the first waits `dashboardRetryDelay`, so
 * a server that stopped answering, which the connection notices within three seconds, is followed
 * there instead of being reported here.
 */
const dashboardAttempts = 3;
const dashboardLoadTimeout = Duration.seconds(30);
const dashboardRetryDelay = Duration.seconds(2);

/** The dashboard's `--background` token for the system appearance, painted before content loads. */
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff");

const newWindow = (browserSession: Electron.Session) =>
  new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 760,
    minHeight: 540,
    title: "Executor",
    show: false,
    backgroundColor: windowBackground(),
    webPreferences: {
      backgroundThrottling: false,
      session: browserSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

/** Electron's `loadURL` rejection names the URL whose main-frame load failed. */
const FailedLoad = Schema.Struct({ url: Schema.String });
/**
 * Why a main-frame load failed, as Electron's `loadURL` rejection says it. `ERR_ABORTED` is also
 * how it reports a load that another navigation of the window replaced.
 */
const LoadError = Schema.Struct({ code: Schema.String, errno: Schema.Number });
type LoadError = typeof LoadError.Type;

/**
 * The application menu, with the desktop's own items in it. Updates and Help are left out while
 * they have none; File always ends with Quit (Close on macOS).
 */
const applicationMenu = (items: {
  readonly file: ReadonlyArray<Electron.MenuItemConstructorOptions>;
  readonly updates: ReadonlyArray<Electron.MenuItemConstructorOptions>;
  readonly help: ReadonlyArray<Electron.MenuItemConstructorOptions>;
}) =>
  Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        ...items.file,
        ...(items.file.length === 0 ? [] : [{ type: "separator" as const }]),
        { role: process.platform === "darwin" ? "close" : "quit" },
      ],
    },
    ...(items.updates.length === 0 ? [] : [{ label: "Updates", submenu: [...items.updates] }]),
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    ...(items.help.length === 0 ? [] : [{ role: "help" as const, submenu: [...items.help] }]),
  ]);

/** A page the window that opens before the data moves was asked to show, and that load. */
interface EarlyPage {
  readonly url: string;
  readonly loading: Promise<void>;
  failed: boolean;
}

/** What the window shows. A pairing link is one-use, so it is cleared once loaded. */
type View =
  | { readonly kind: "starting" }
  | { readonly kind: "ready"; readonly origin: string; readonly pairing: string | undefined }
  | { readonly kind: "recovery"; readonly recovery: DesktopRecovery };

/**
 * The data directories. The desktop uses the CLI's, so both share one background server: the
 * CLI's default when packaged, and `bun run executor`'s in development. EXECUTOR_DESKTOP_DATA_DIR
 * chooses another. Desktops before the background service kept their own data, which only the
 * migration reads; a chosen directory migrates only an old one chosen with
 * EXECUTOR_DESKTOP_LEGACY_DATA_DIR, so a throwaway directory never takes a real one's data.
 */
const dataDirectories = Effect.gen(function* () {
  const path = yield* Path.Path;
  const chosen = yield* Config.String("EXECUTOR_DESKTOP_DATA_DIR").pipe(Config.option);
  const shared = Option.isSome(chosen)
    ? chosen.value
    : app.isPackaged
      ? path.join(app.getPath("home"), ".executor", "v2", "cli")
      : yield* Config.String("EXECUTOR_DATA_DIR").pipe(
          Config.withDefault(path.join(root, ".local/dev/local")),
        );
  const legacy = yield* Config.String("EXECUTOR_DESKTOP_LEGACY_DATA_DIR").pipe(Config.option);
  return {
    directory: path.resolve(shared),
    legacy: Option.isSome(legacy)
      ? Option.some(path.resolve(legacy.value))
      : Option.isSome(chosen)
        ? Option.none<string>()
        : Option.some(
            app.isPackaged
              ? path.join(app.getPath("userData"), "data")
              : path.join(root, ".local/dev/desktop"),
          ),
  };
});

const desktop = Effect.gen(function* () {
  const quit = yield* Deferred.make<void, DesktopFailed>();
  const path = yield* Path.Path;
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const { directory, legacy } = yield* dataDirectories;
  const diagnostics = path.join(directory, "diagnostics");
  // Beside the data directory, so a reset or the migration is a same-volume rename.
  const backups = path.join(path.dirname(directory), "backups");
  const stop = (reason: string) => {
    quitting.began(reason);
    Effect.runSync(Deferred.succeed(quit, undefined));
  };
  // From before the data moves: quitting meanwhile ends the app once the move is done.
  const beforeQuit = (event: Electron.Event) => {
    event.preventDefault();
    stop("before-quit");
  };
  const onSignal = (signal: NodeJS.Signals) => stop(signal);
  app.on("before-quit", beforeQuit);
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      app.removeListener("before-quit", beforeQuit);
      process.removeListener("SIGTERM", onSignal);
      process.removeListener("SIGINT", onSignal);
    }),
  );
  yield* Effect.tryPromise({
    try: () => app.whenReady(),
    catch: () => new DesktopFailed({ stage: "window" }),
  });
  const browserSession = session.fromPartition("executor-desktop");
  // The app's own menu is in place before its first window opens. Until the desktop is set up it
  // has none of the desktop's items, which need its data.
  Menu.setApplicationMenu(applicationMenu({ file: [], updates: [], help: [] }));
  // The window opens on the startup page before the data moves, which can take a while, and says
  // so meanwhile. It becomes the app's window once the desktop is set up (see `createWindow`). If
  // the app's first page is the one it was last asked to show, that load becomes the window's own
  // instead of loading the page again, unless it already failed; a failure before then is not
  // reported.
  let early: BrowserWindow | undefined = newWindow(browserSession);
  const opening = early;
  opening.once("ready-to-show", () => {
    if (!opening.isDestroyed()) opening.show();
  });
  // Nothing it shows until then may navigate it or open another window.
  const stay = (event: Electron.Event) => event.preventDefault();
  opening.webContents.on("will-navigate", stay);
  opening.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  let earlyPage: EarlyPage | undefined;
  const showEarly = (url: string) => {
    if (opening.isDestroyed()) return;
    const page: EarlyPage = { url, loading: opening.loadURL(url), failed: false };
    page.loading.catch(() => {
      page.failed = true;
    });
    earlyPage = page;
  };
  showEarly(startupUrl);
  // Before anything uses the shared directory, the desktop's old data moves into it, once.
  let movingSince = Option.none<DateTime.Utc>();
  const migration = yield* Option.match(legacy, {
    onNone: () => Effect.succeed({ kind: "none" as const }),
    onSome: (legacyDirectory) =>
      Effect.flatMap(legacyPort(legacyDirectory), (port) =>
        migrateDesktopData({
          platform: process.platform,
          legacyDirectory,
          sharedDirectory: directory,
          backups,
          legacyPort: port,
          onMoving: Effect.gen(function* () {
            movingSince = Option.some(yield* DateTime.now);
            yield* Effect.logInfo("Moving the desktop's data");
            showEarly(movingUrl);
          }),
        }),
      ),
  }).pipe(
    // The desktop's log is in the shared directory, which the move must find as it was, so until
    // the move is done its lines go to stderr only. The log records it once the move is done.
    Effect.provide(Logger.layer([Logger.withConsoleError(Logger.formatJson)])),
    Effect.result,
  );
  const moved = yield* Option.match(movingSince, {
    onNone: () => Effect.succeed({}),
    onSome: (since) =>
      Effect.map(DateTime.now, (now) => ({
        startedAt: DateTime.formatIso(since),
        seconds: Duration.toSeconds(DateTime.distance(since, now)),
      })),
  });
  // A failed migration may resume next launch, so it must find the shared directory as it was.
  const log = Result.isSuccess(migration)
    ? Option.some(yield* rotatingJsonLogger(diagnostics, "executor-desktop"))
    : Option.none();
  if (Option.isSome(log)) quitting.useLog(path.join(diagnostics, "executor-desktop.jsonl"));
  // Finalizers run in reverse, so each marker runs just before the finalizers of what was set up
  // before it, and a quit that does not finish says which ones it waits on.
  const closing = (name: string) =>
    Effect.addFinalizer(() => Effect.sync(() => quitting.closing(name)));
  yield* closing("its log and quit listeners");
  const environmentPort = yield* Config.String("EXECUTOR_PORT").pipe(Config.option);
  return yield* Effect.gen(function* () {
    yield* startProcessMetrics("executor-desktop");
    yield* closing("its process metrics");
    // Menu, window and recovery actions run in the desktop's scope, with its platform services.
    const run = yield* FiberSet.makeRuntime<
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >();
    yield* closing("its running menu, window and recovery actions");
    yield* Effect.logInfo("Starting Executor desktop").pipe(Effect.annotateLogs({ directory }));
    if (Result.isFailure(migration))
      yield* Effect.logError("Executor could not move the desktop's data", migration.failure).pipe(
        Effect.annotateLogs(moved),
      );
    else if (migration.success.kind !== "none")
      yield* Effect.logInfo("Moved the desktop's data").pipe(
        Effect.annotateLogs({ ...migration.success, ...moved }),
      );
    // Installing an update or relaunching runs once every window has closed. Each is the final
    // synchronous step that ends this process; the background server keeps running.
    const afterStop = yield* Ref.make(Option.none<() => void>());
    const after = (step: () => void) => {
      Effect.runSync(Ref.set(afterStop, Option.some(step)));
      stop("restart");
    };
    const relaunch = () => {
      app.relaunch();
      app.exit(0);
    };
    const failed = (stage: (typeof DesktopFailed.Type)["stage"]) => {
      quitting.began(`failed at ${stage}`);
      Effect.runSync(Deferred.fail(quit, new DesktopFailed({ stage })));
    };
    // Quitting while the data moved ends the app now, before any server starts.
    if (yield* Deferred.isDone(quit)) return Option.none<() => void>();
    yield* Effect.raceFirst(
      Effect.gen(function* () {
        let view: View = { kind: "starting" };
        let everReady = false;
        let window: BrowserWindow | undefined;
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
        /** The page the window was last asked to show. */
        let requested: string | undefined;
        /** Dashboard loads that failed in a row, since one loaded or a server was joined. */
        let dashboardFailures = 0;
        /**
         * Follow the window's load `generation` of the dashboard. One that fails, or does not
         * finish in time, while it is still the window's current load is tried again with a fresh
         * pairing link, since the one it used is spent; after `dashboardAttempts` the window shows
         * the dashboard recovery page with the failure, whose Restart joins the server and loads
         * the dashboard again. Its failure can name its normalized or redirected URL, so any
         * failure counts, except a load that another navigation of the window replaced, such as an
         * OAuth return, which shows its own page, also while a retry waits. A server that stops
         * meanwhile is the connection's to follow (see `dashboardRetryDelay`). The failure's URL is
         * never logged: it holds the link.
         */
        const followDashboard = (
          current: BrowserWindow,
          generation: number,
          loading: Promise<void>,
        ) =>
          Effect.gen(function* () {
            const outcome = yield* Effect.tryPromise({
              try: () => loading,
              catch: Schema.decodeUnknownOption(LoadError),
            }).pipe(Effect.timeoutOption(dashboardLoadTimeout), Effect.result);
            const replaced = () => current.isDestroyed() || generation !== loads;
            if (replaced()) return;
            if (Result.isSuccess(outcome) && Option.isSome(outcome.success)) {
              dashboardFailures = 0;
              return;
            }
            const error = Result.isFailure(outcome) ? outcome.failure : Option.none<LoadError>();
            if (Option.isSome(error) && error.value.code === "ERR_ABORTED") return;
            let failure = Result.isSuccess(outcome)
              ? `it did not finish loading within ${Duration.toSeconds(dashboardLoadTimeout)} seconds`
              : Option.match(error, {
                  onNone: () => "its load failed",
                  onSome: ({ code, errno }) => `${code} (${errno})`,
                });
            while (view.kind === "ready" && connection !== undefined) {
              dashboardFailures += 1;
              yield* Effect.logWarning("Desktop window could not load the dashboard").pipe(
                Effect.annotateLogs({ failure, attempt: dashboardFailures }),
              );
              if (dashboardFailures >= dashboardAttempts)
                return yield* showRecovery({
                  stage: "dashboard",
                  detail: `The Executor window could not load the dashboard from ${view.origin} ${dashboardFailures} times in a row. The last time: ${failure}.`,
                });
              yield* Effect.sleep(dashboardRetryDelay);
              if (replaced()) return;
              const pairing = yield* connection.pairWindow.pipe(Effect.option);
              if (replaced() || view.kind !== "ready") return;
              if (Option.isSome(pairing)) {
                view = { ...view, pairing: pairing.value };
                return showView();
              }
              failure = "the background Executor did not give the window a pairing link";
            }
          });
        /** `loading` is the window's load of `url`, which it now shows. */
        const follow = (current: BrowserWindow, url: string, loading: Promise<void>) => {
          const generation = ++loads;
          requested = url;
          if (!url.startsWith("data:")) {
            run(followDashboard(current, generation, loading));
            return;
          }
          void loading.catch((error: unknown) => {
            if (current.isDestroyed() || generation !== loads) return;
            // The app's own documents must load. Electron rejects a load when any main-frame load
            // fails before it finishes, also the replaced document's: on Windows a dashboard still
            // loading when its server exits reports its abort after this page has committed, and
            // so can a status page this one replaced before it finished. A data: document never
            // redirects, so a failure naming another URL is not its own. Loading the same page
            // again while it loads would make that abort name this URL, so a status page the
            // window was last asked to show is never loaded again (see `showView`).
            if (Schema.is(FailedLoad)(error) && error.url !== url) return;
            failed("window");
          });
        };
        const load = (current: BrowserWindow, url: string) =>
          follow(current, url, current.loadURL(url));
        const showView = () => {
          if (window === undefined || window.isDestroyed()) return;
          const url = viewUrl();
          // A status page the window already shows, or still loads, is not loaded again.
          if (url.startsWith("data:") && url === requested) return;
          load(window, url);
        };
        const showLogs = () =>
          shell.showItemInFolder(path.join(diagnostics, "executor-desktop.jsonl"));
        const showRecovery = (recovery: DesktopRecovery) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("Showing desktop recovery").pipe(
              Effect.annotateLogs({
                recovery: {
                  stage: recovery.stage,
                  ...("reason" in recovery ? { reason: recovery.reason } : {}),
                },
              }),
            );
            view = { kind: "recovery", recovery };
            createWindow();
            announceReplaced();
          });

        // When the migration replaced the CLI's data, or changed its settings, say where they went,
        // once, over the first page the window settles on: the dashboard, or recovery if no server
        // runs. The migration's record keeps the notice until it has been shown, so a launch that
        // ends first, as one quit while the data moved, leaves it for the next.
        let replacedNotice =
          Option.isSome(legacy) && Result.isSuccess(migration)
            ? yield* pendingNotice(legacy.value).pipe(
                Effect.catch((error) =>
                  Effect.as(
                    Effect.logWarning(
                      "Could not read whether the moved data notice was shown",
                      error,
                    ),
                    Option.none<MoveNotice>(),
                  ),
                ),
              )
            : Option.none<MoveNotice>();
        const announceReplaced = () => {
          if (Option.isNone(replacedNotice)) return;
          const { archived, detail } = replacedNotice.value;
          replacedNotice = Option.none();
          run(
            Effect.gen(function* () {
              yield* Effect.logInfo("Showing the moved data notice").pipe(
                Effect.annotateLogs({ archived }),
              );
              const box: Electron.MessageBoxOptions = {
                type: "info",
                title: "Executor now shares its data with the CLI",
                message: "Executor moved its data to the folder the Executor CLI uses.",
                detail,
                buttons: ["Show in folder", "OK"],
                defaultId: 1,
                cancelId: 1,
              };
              const parent = window;
              const answer = yield* Effect.promise(() =>
                parent === undefined || parent.isDestroyed()
                  ? dialog.showMessageBox(box)
                  : dialog.showMessageBox(parent, box),
              );
              if (Option.isSome(legacy))
                yield* noticeShown(process.platform, legacy.value).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning(
                      "Could not record that the moved data notice was shown",
                      error,
                    ),
                  ),
                );
              if (answer.response === 0) shell.showItemInFolder(archived);
            }),
          );
        };

        // The server, and the actions that use its data, exist once the data is in place.
        const runtime = app.isPackaged
          ? yield* packagedRuntime({
              source: root,
              staging: path.join(app.getPath("userData"), "runtime"),
            })
          : yield* developmentRuntime(root);
        yield* closing("its server runtime");
        const connection: Connection | undefined = Result.isFailure(migration)
          ? undefined
          : yield* makeConnection({
              directory,
              runtime,
              onStarting: Effect.sync(() => {
                view = { kind: "starting" };
                showView();
              }),
              // Shown in the window if one is open; a stop on purpose opens none.
              onStopped: Effect.sync(() => {
                view = { kind: "recovery", recovery: { stage: "stopped" } };
                showView();
              }),
              onReady: ({ origin: ready, pairing }) =>
                Effect.gen(function* () {
                  view = { kind: "ready", origin: ready, pairing };
                  everReady = true;
                  dashboardFailures = 0;
                  showView();
                  yield* Effect.logInfo("Executor desktop ready").pipe(
                    Effect.annotateLogs({ origin: ready }),
                  );
                  announceReplaced();
                }),
              onReturn: (url) =>
                Effect.gen(function* () {
                  const callback = new URL(Redacted.value(url));
                  const current = window;
                  if (
                    callback.origin !== origin() ||
                    callback.pathname !== OAuthCallbackPath ||
                    current === undefined ||
                    current.isDestroyed()
                  )
                    return;
                  // It replaces the window's load, so a dashboard load waiting to be tried again
                  // leaves it. With the header the server completes the callback, in the window's
                  // session.
                  loads += 1;
                  requested = callback.href;
                  yield* Effect.tryPromise({
                    try: () =>
                      current.loadURL(callback.href, {
                        extraHeaders: `${desktopReturnHeader}: 1\r\n`,
                      }),
                    catch: () => new DesktopFailed({ stage: "oauth" }),
                  }).pipe(
                    Effect.catch(() =>
                      Effect.logWarning("Desktop window could not load an OAuth return"),
                    ),
                  );
                  current.show();
                  current.focus();
                }),
              onRecovery: showRecovery,
            });
        yield* closing("its background server connection");

        /**
         * The server keeps the callback of an OAuth authorization that returns to this window's
         * origin for the desktop, so it must expect that callback before the browser opens.
         */
        const openExternal = (value: string) => {
          const url = externalUrl(value);
          if (url === undefined) return;
          const state = url.searchParams.get("state");
          const current = origin();
          const returns =
            current !== undefined &&
            url.searchParams.get("redirect_uri") === `${current}${OAuthCallbackPath}`;
          run(
            Effect.gen(function* () {
              if (returns && state !== null && connection !== undefined) {
                const expected = yield* connection.expectReturn(state).pipe(Effect.result);
                if (Result.isFailure(expected)) {
                  yield* Effect.logWarning("The background Executor did not expect the sign-in");
                  yield* Effect.promise(() =>
                    dialog.showMessageBox({
                      type: "error",
                      message: "Executor could not start this sign-in.",
                      detail:
                        "Its local server did not answer. Wait for Executor to finish starting, then try again.",
                    }),
                  );
                  return;
                }
              }
              yield* Effect.tryPromise(() => shell.openExternal(url.href)).pipe(
                Effect.catch(() =>
                  Effect.sync(() => {
                    if (!Deferred.isDoneUnsafe(quit)) failed("oauth");
                  }),
                ),
              );
            }),
          );
        };

        const reset =
          connection !== undefined && Option.isSome(log)
            ? yield* makeResetAction({
                connection,
                directory,
                backups,
                appVersion: app.getVersion(),
                whileMoving: log.value.whileMoving,
                window: () => window,
              })
            : undefined;

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
            case "start":
            case "restart":
              // A failed migration runs again when the app starts again.
              return connection === undefined ? after(relaunch) : run(connection.start);
            case "logs":
              return showLogs();
            case "reset":
              return reset === undefined ? undefined : run(reset);
            case "quit":
              return stop("recovery page");
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
          // The window that opened before the data moved, if it is still open, is set up first.
          const adopted = early !== undefined && !early.isDestroyed() ? early : undefined;
          const current = adopted ?? newWindow(browserSession);
          const shownEarly = adopted === undefined ? undefined : earlyPage;
          early = undefined;
          current.webContents.removeListener("will-navigate", stay);
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
            // Closing the window before the dashboard was ever ready ends the launch.
            if (!everReady) stop("window closed before ready");
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
          // A page the early window already shows or still loads is not loaded again.
          const url = viewUrl();
          if (shownEarly !== undefined && shownEarly.url === url && !shownEarly.failed)
            follow(current, url, shownEarly.loading);
          else load(current, url);
        };
        // Closing the last window quits the app on Windows and Linux; the server keeps running.
        const allClosed = () => {
          if (process.platform !== "darwin") stop("last window closed");
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
        yield* closing("its windows");

        const checkForUpdates = yield* makeUpdater(after);
        yield* closing("its updater");
        const openBrowser = yield* makeOpenBrowserAction(browserSession, origin);
        const exportDiagnostics = yield* makeExportDiagnosticsAction({
          directory,
          origin,
          portSource: portSource(directory, environmentPort).pipe(Effect.provideContext(services)),
        });
        const dataActions =
          connection === undefined
            ? []
            : yield* Effect.gen(function* () {
                const changePort = yield* makePortAction({
                  directory,
                  platform: process.platform,
                  environment: environmentPort,
                  current: () => {
                    const current = origin();
                    return current === undefined ? undefined : Number(new URL(current).port);
                  },
                  parent: () => window,
                  restart: () => run(connection.whileStopped(Effect.void).pipe(Effect.ignore)),
                });
                const rotate = connection
                  .whileStopped(
                    Effect.flatMap(runtime.program, ({ command, env }) =>
                      rotateKey({ command, env, directory }),
                    ),
                  )
                  .pipe(
                    Effect.catch((error) =>
                      Effect.succeed({
                        rotated: false,
                        message:
                          Schema.is(ServiceFailed)(error) && error.reason === "directory-in-use"
                            ? `${error.message} The API key was not changed.`
                            : "Executor's background server did not stop. The API key was not changed.",
                      }),
                    ),
                    Effect.flatMap(announceRotation),
                  );
                const rotateKeyAction = yield* makeRotateKeyAction(() => run(rotate));
                return [
                  { type: "separator" as const },
                  { label: "Server port…", click: () => run(changePort) },
                  { label: "Rotate local API key…", click: () => run(rotateKeyAction) },
                ];
              });
        Menu.setApplicationMenu(
          applicationMenu({
            file: [{ label: "Open in browser", click: () => run(openBrowser) }, ...dataActions],
            updates: app.isPackaged
              ? [{ label: "Check for updates…", click: () => run(checkForUpdates) }]
              : [],
            help: [
              { label: "Show diagnostics folder", click: () => void shell.openPath(diagnostics) },
              { label: "Export diagnostics…", click: () => run(exportDiagnostics) },
              ...(reset === undefined
                ? []
                : [
                    { type: "separator" as const },
                    { label: "Reset Executor data…", click: () => run(reset) },
                  ]),
            ],
          }),
        );
        if (Result.isFailure(migration))
          view = {
            kind: "recovery",
            recovery: { stage: "migration", detail: migration.failure.message },
          };
        createWindow();
        if (connection !== undefined) yield* connection.start;
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
    Effect.provide(
      Logger.layer([
        Logger.withConsoleError(Logger.formatJson),
        ...Option.toArray(log).map(({ logger }) => logger),
      ]),
    ),
  );
});

if (!app.requestSingleInstanceLock()) app.quit();
else
  void Effect.runPromiseExit(Effect.scoped(desktop).pipe(Effect.provide(NodeServices.layer))).then(
    (result) => {
      quitting.closed(Exit.isFailure(result) ? "failure" : "success");
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
      // The step runs after the desktop scope closed, once every window is gone.
      if (Exit.isSuccess(result) && Option.isSome(result.value)) result.value.value();
      else app.exit(Exit.isFailure(result) ? 1 : 0);
    },
  );
