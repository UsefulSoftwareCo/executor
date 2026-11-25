import { homedir } from "node:os";
import { resolve } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session, shell } from "electron";
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
import {
  type DesktopUpdate,
  desktopUpdateRestartUrl,
  desktopUpdateScript,
} from "../../web/src/contracts/desktop-update.ts";
import { makeOpenBrowserAction } from "./implementation/browser.ts";
import { movingUrl, startupUrl } from "./implementation/startup.ts";
import { makeConnection, type Connection } from "./implementation/connection.ts";
import {
  holdsData,
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
import { makeInstalledApps } from "./implementation/installed-apps.ts";
import { launchedAtLogin } from "./implementation/login-item.ts";
import { makeHostedServers, serverOrigin } from "./implementation/hosted-servers.ts";
import { isInstallLink, makeInstallLinks } from "./implementation/install-links.ts";
import { makeAccounts, readPreferences } from "./implementation/accounts.ts";
import { cloudDashboardOrigin, cloudOriginVariable } from "./contracts/servers.ts";
import { desktopChannels } from "./contracts/bridge-channels.ts";
import { appProtocol, parseAppLink } from "./contracts/installed-apps.ts";

const root = app.isPackaged
  ? resolve(process.resourcesPath, "runtime")
  : resolve(__dirname, "../../../..");
app.setName(app.isPackaged ? release.desktop.productName : "Executor (Dev)");
if (app.isPackaged && process.platform === "win32") app.setAppUserModelId(release.desktop.appId);
if (process.env.EXECUTOR_DESKTOP_PROFILE_DIR !== undefined)
  app.setPath("userData", resolve(process.env.EXECUTOR_DESKTOP_PROFILE_DIR));
else
  app.setPath(
    "userData",
    app.isPackaged
      ? resolve(app.getPath("appData"), release.desktop.dataName)
      : resolve(root, ".local/desktop-shell"),
  );

if (process.platform === "darwin")
  app.commandLine.appendSwitch("enable-features", "MacLoopbackAudioForScreenShare");

const quitting = makeQuitRecord();
process.on("uncaughtExceptionMonitor", quitting.exception);

const appLinks = (values: ReadonlyArray<string>) =>
  values.filter((value) => parseAppLink(value) !== undefined || isInstallLink(value));

const rendererReloads = 3;
const rendererReloadWindowMillis = 60_000;

const dashboardAttempts = 3;
const dashboardLoadTimeout = Duration.seconds(30);
const dashboardRetryDelay = Duration.seconds(2);

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
      preload: resolve(__dirname, "preload-host.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

// external: Electron destroys a closing window's page, and fails its pending load, before the window reports isDestroyed().
const windowGone = (window: BrowserWindow) =>
  window.isDestroyed() || window.webContents.isDestroyed();

const FailedLoad = Schema.Struct({ url: Schema.String });
const LoadError = Schema.Struct({ code: Schema.String, errno: Schema.Number });
type LoadError = typeof LoadError.Type;

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

interface EarlyPage {
  readonly url: string;
  readonly loading: Promise<void>;
  failed: boolean;
}

type View =
  | { readonly kind: "starting" }
  | {
      readonly kind: "ready";
      readonly origin: string;
      readonly pairing: string | undefined;
      readonly signedIn: boolean;
    }
  | { readonly kind: "recovery"; readonly recovery: DesktopRecovery };

const dataDirectories = Effect.gen(function* () {
  const path = yield* Path.Path;
  const chosen = yield* Config.String("EXECUTOR_DESKTOP_DATA_DIR").pipe(Config.option);
  const shared = Option.isSome(chosen)
    ? chosen.value
    : app.isPackaged
      ? path.join(homedir(), ".executor", "v2", "cli")
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
  const launchLinks = appLinks(process.argv);
  let openLink = (url: string) => {
    launchLinks.push(url);
  };
  const openUrl = (event: Electron.Event, url: string) => {
    event.preventDefault();
    openLink(url);
  };
  app.on("open-url", openUrl);
  yield* Effect.addFinalizer(() => Effect.sync(() => app.removeListener("open-url", openUrl)));
  const quit = yield* Deferred.make<void, DesktopFailed>();
  const path = yield* Path.Path;
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const { directory, legacy } = yield* dataDirectories;
  const diagnostics = path.join(directory, "diagnostics");
  const backups = path.join(path.dirname(directory), "backups");
  const stop = (reason: string) => {
    quitting.began(reason);
    Effect.runSync(Deferred.succeed(quit, undefined));
  };
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
  let hostServer = (_event: Electron.IpcMainEvent): string | null => null;
  const answerHostServer = (event: Electron.IpcMainEvent) => {
    event.returnValue = hostServer(event);
  };
  ipcMain.on(desktopChannels.hostServer, answerHostServer);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => ipcMain.removeListener(desktopChannels.hostServer, answerHostServer)),
  );
  if (app.isPackaged && (process.platform === "darwin" || process.platform === "win32"))
    app.setAsDefaultProtocolClient(appProtocol);
  Menu.setApplicationMenu(applicationMenu({ file: [], updates: [], help: [] }));
  const atLogin = launchedAtLogin();
  const profile = app.getPath("userData");
  const preferences = yield* readPreferences(profile);
  const localData =
    (yield* holdsData(directory)) || (Option.isSome(legacy) && (yield* holdsData(legacy.value)));
  let localRunning = preferences.local || localData;
  const hostedFirst = preferences.lastUsed !== null && preferences.lastUsed !== "local";
  let early: BrowserWindow | undefined = localRunning ? newWindow(browserSession) : undefined;
  const painted = new WeakSet<BrowserWindow>();
  const opening = early;
  opening?.once("ready-to-show", () => {
    painted.add(opening);
    if (!opening.isDestroyed() && !hostedFirst && !atLogin) opening.show();
  });
  const stay = (event: Electron.Event) => event.preventDefault();
  opening?.webContents.on("will-navigate", stay);
  opening?.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  let earlyPage: EarlyPage | undefined;
  const showEarly = (url: string) => {
    if (opening === undefined || opening.isDestroyed()) return;
    const page: EarlyPage = { url, loading: opening.loadURL(url), failed: false };
    page.loading.catch(() => {
      page.failed = true;
    });
    earlyPage = page;
  };
  showEarly(startupUrl);
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
            if (opening !== undefined && !opening.isDestroyed()) opening.show();
          }),
        }),
      ),
  }).pipe(
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
  const log = Result.isSuccess(migration)
    ? Option.some(yield* rotatingJsonLogger(diagnostics, "executor-desktop"))
    : Option.none();
  if (Option.isSome(log)) quitting.useLog(path.join(diagnostics, "executor-desktop.jsonl"));
  const closing = (name: string) =>
    Effect.addFinalizer(() => Effect.sync(() => quitting.closing(name)));
  yield* closing("its log and quit listeners");
  const environmentPort = yield* Config.String("EXECUTOR_PORT").pipe(Config.option);
  return yield* Effect.gen(function* () {
    yield* startProcessMetrics("executor-desktop");
    yield* closing("its process metrics");
    const run = yield* FiberSet.makeRuntime<
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >();
    yield* closing("its running menu, window and recovery actions");
    let rebuildMenu = () => {};
    let accountsChanged = () => {};
    let signInAgain = (_account: string) => {};
    let askToRunLocally = (_message: string) => {};
    let dashboardClosed = (_account: string, _byDesktop: boolean) => {};
    let localWindow = (): BrowserWindow | undefined => undefined;
    let openLocal = (_bounds: Electron.Rectangle | undefined): BrowserWindow | undefined =>
      undefined;
    let startLocal = () => {};
    const changed = () => {
      rebuildMenu();
      accountsChanged();
    };
    const cloudOrigin = yield* Config.String(cloudOriginVariable).pipe(
      Config.withDefault(cloudDashboardOrigin),
      Effect.map((value) => serverOrigin(value)?.origin ?? cloudDashboardOrigin),
    );
    const installedApps = yield* makeInstalledApps({
      session: browserSession,
      profile,
      changed,
      signInAgain: (account) => signInAgain(account),
      askToRunLocally: (message) => askToRunLocally(message),
    });
    const hostedServers = yield* makeHostedServers({
      profile,
      installedApps,
      cloudOrigin,
      changed,
      dashboardClosed: (account, byDesktop) => dashboardClosed(account, byDesktop),
    });
    const accounts = yield* makeAccounts({
      profile,
      preferences,
      hosted: hostedServers,
      installedApps,
      local: {
        running: () => localRunning,
        start: () => startLocal(),
        window: () => localWindow(),
        painted: (window) => painted.has(window),
        open: (bounds) => openLocal(bounds),
      },
    });
    accountsChanged = accounts.push;
    signInAgain = accounts.signInAgain;
    askToRunLocally = accounts.askToRunLocally;
    dashboardClosed = accounts.dashboardClosed;
    const installLinks = yield* makeInstallLinks({
      installedApps,
      hostedServers,
      localRunning: () => localRunning,
      prompt: accounts.prompt,
      askToRunLocally: accounts.askToRunLocally,
      signIn: accounts.signInForLink,
    });
    hostServer = installedApps.hostServer;
    const handleLink = (url: string) =>
      isInstallLink(url) ? installLinks.open(url) : installedApps.openLink(url);
    yield* closing("its installed apps");
    yield* Effect.logInfo("Starting Executor desktop").pipe(Effect.annotateLogs({ directory }));
    if (Result.isFailure(migration))
      yield* Effect.logError("Executor could not move the desktop's data", migration.failure).pipe(
        Effect.annotateLogs(moved),
      );
    else if (migration.success.kind !== "none")
      yield* Effect.logInfo("Moved the desktop's data").pipe(
        Effect.annotateLogs({ ...migration.success, ...moved }),
      );
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
    if (yield* Deferred.isDone(quit)) return Option.none<() => void>();
    yield* Effect.raceFirst(
      Effect.gen(function* () {
        let view: View = { kind: "starting" };
        let everReady = false;
        let window: BrowserWindow | undefined;
        const activeWindow = () => (accounts.isActive("local") ? window : undefined);
        const origin = () => (view.kind === "ready" ? view.origin : undefined);
        installedApps.attachSession(browserSession, origin);
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
        let loads = 0;
        let requested: string | undefined;
        let dashboardFailures = 0;
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
            const replaced = () => windowGone(current) || generation !== loads;
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
              if (view.signedIn) return showView();
              const pairing = yield* connection.pairWindow.pipe(Effect.option);
              if (replaced() || view.kind !== "ready") return;
              if (Option.isSome(pairing)) {
                view = { ...view, pairing: pairing.value };
                return showView();
              }
              failure = "the background Executor did not give the window a pairing link";
            }
          });
        const follow = (current: BrowserWindow, url: string, loading: Promise<void>) => {
          const generation = ++loads;
          requested = url;
          if (!url.startsWith("data:")) {
            run(followDashboard(current, generation, loading));
            return;
          }
          void loading.catch((error: unknown) => {
            if (windowGone(current) || generation !== loads) return;
            if (Schema.is(FailedLoad)(error) && error.url !== url) return;
            failed("window");
          });
        };
        const load = (current: BrowserWindow, url: string) =>
          follow(current, url, current.loadURL(url));
        const showView = () => {
          if (window === undefined || window.isDestroyed()) return;
          const url = viewUrl();
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
            if (window === undefined || window.isDestroyed()) {
              if (accounts.isActive("local") || early !== undefined) createWindow(undefined);
            } else showView();
            announceReplaced();
          });

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
              const parent = activeWindow();
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
                installedApps.serverGone();
                view = { kind: "starting" };
                showView();
              }),
              onStopped: Effect.sync(() => {
                installedApps.serverGone();
                view = { kind: "recovery", recovery: { stage: "stopped" } };
                showView();
              }),
              onReady: ({ origin: ready, pairing }) =>
                Effect.gen(function* () {
                  const signedIn = yield* installedApps.serverReady(
                    ready,
                    connection === undefined
                      ? Effect.fail(new DesktopFailed({ stage: "pairing" }))
                      : connection.pairWindow,
                  );
                  view = {
                    kind: "ready",
                    origin: ready,
                    pairing: signedIn ? undefined : pairing,
                    signedIn,
                  };
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
                  accounts.showLocal();
                }),
              onRecovery: showRecovery,
            });
        yield* closing("its background server connection");

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
                window: activeWindow,
              })
            : undefined;

        const recover = (current: BrowserWindow, url: string) => {
          const action = recoveryAction(url);
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
              return connection === undefined ? after(relaunch) : run(connection.start);
            case "logs":
              return showLogs();
            case "reset":
              return reset === undefined ? undefined : run(reset);
            case "quit":
              return stop("recovery page");
          }
        };

        const showsDashboard = (current: BrowserWindow) => {
          const dashboard = origin();
          if (current.isDestroyed() || dashboard === undefined) return false;
          return URL.parse(current.webContents.getURL())?.origin === dashboard;
        };
        let update = Option.none<DesktopUpdate>();
        const showUpdate = (current: BrowserWindow) => {
          if (!showsDashboard(current)) return;
          const script = desktopUpdateScript(Option.getOrUndefined(update));
          run(
            Effect.tryPromise(() => current.webContents.executeJavaScript(script)).pipe(
              Effect.catch(() => Effect.logWarning("Desktop window could not show the update")),
            ),
          );
        };
        let menu: ((update: Option.Option<DesktopUpdate>) => Menu) | undefined;
        const updater = yield* makeUpdater({
          restart: after,
          show: (next) => {
            update = next;
            if (window !== undefined) showUpdate(window);
            if (menu !== undefined) installedApps.setBaseMenu(menu(update));
          },
        });
        yield* closing("its updater");

        const followAppearance = () => {
          if (window !== undefined && !window.isDestroyed())
            window.setBackgroundColor(windowBackground());
        };
        nativeTheme.on("updated", followAppearance);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => nativeTheme.removeListener("updated", followAppearance)),
        );
        const createWindow = (bounds: Electron.Rectangle | undefined) => {
          if (window !== undefined && !window.isDestroyed()) {
            showView();
            return window;
          }
          const adopted = early !== undefined && !early.isDestroyed() ? early : undefined;
          const current = adopted ?? newWindow(browserSession);
          if (adopted === undefined && bounds !== undefined) current.setBounds(bounds);
          const shownEarly = adopted === undefined ? undefined : earlyPage;
          early = undefined;
          current.webContents.removeListener("will-navigate", stay);
          window = current;
          if (process.argv.includes("--devtools"))
            current.webContents.openDevTools({ mode: "detach" });
          current.once("ready-to-show", () => {
            painted.add(current);
            if (
              !current.isDestroyed() &&
              accounts.isActive("local") &&
              !(atLogin && adopted !== undefined)
            )
              current.show();
          });
          current.webContents.on("dom-ready", () => showUpdate(current));
          current.webContents.on("did-finish-load", () => {
            if (!current.isDestroyed() && origin() !== undefined)
              current.webContents.setBackgroundThrottling(true);
          });
          current.once("closed", () => {
            if (window === current) window = undefined;
            if (!everReady && accounts.isActive("local")) stop("window closed before ready");
          });
          current.webContents.on("will-attach-webview", (event) => event.preventDefault());
          const navigate = (event: Electron.Event, url: string) => {
            if (isRecoveryLink(url)) {
              event.preventDefault();
              recover(current, url);
              return;
            }
            if (url === desktopUpdateRestartUrl) {
              event.preventDefault();
              if (showsDashboard(current)) run(updater.install);
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
          const url = viewUrl();
          if (shownEarly !== undefined && shownEarly.url === url && !shownEarly.failed)
            follow(current, url, shownEarly.loading);
          else load(current, url);
          return current;
        };
        localWindow = () => (window === undefined || window.isDestroyed() ? undefined : window);
        openLocal = createWindow;
        const allClosed = () => {
          if (process.platform !== "darwin") stop("last window closed");
        };
        const showCurrent = () => accounts.showCurrent();
        const secondInstance = (_event: Electron.Event, argv: ReadonlyArray<string>) => {
          const links = appLinks(argv);
          if (links.length === 0) return showCurrent();
          for (const link of links) openLink(link);
        };
        app.on("activate", showCurrent);
        app.on("second-instance", secondInstance);
        app.on("window-all-closed", allClosed);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            app.removeListener("activate", showCurrent);
            app.removeListener("second-instance", secondInstance);
            app.removeListener("window-all-closed", allClosed);
            for (const current of BrowserWindow.getAllWindows()) current.destroy();
          }),
        );
        yield* closing("its windows");

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
                  parent: activeWindow,
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
        menu = (current) =>
          applicationMenu({
            file: localRunning
              ? [{ label: "Open in browser", click: () => run(openBrowser) }, ...dataActions]
              : [],
            updates: [
              ...Option.toArray(Option.filter(current, ({ state }) => state === "ready")).map(
                ({ version }) => ({
                  label: `Restart to update (v${version})`,
                  click: () => run(updater.install),
                }),
              ),
              ...(app.isPackaged || updater.configured
                ? [{ label: "Check for updates…", click: () => run(updater.check) }]
                : []),
            ],
            help: [
              { label: "Show diagnostics folder", click: () => void shell.openPath(diagnostics) },
              { label: "Export diagnostics…", click: () => run(exportDiagnostics) },
              ...(reset === undefined || !localRunning
                ? []
                : [
                    { type: "separator" as const },
                    { label: "Reset Executor data…", click: () => run(reset) },
                  ]),
            ],
          });
        rebuildMenu = () => {
          if (menu !== undefined) installedApps.setBaseMenu(menu(update));
        };
        rebuildMenu();
        if (Result.isFailure(migration)) {
          view = {
            kind: "recovery",
            recovery: { stage: "migration", detail: migration.failure.message },
          };
          localRunning = true;
          rebuildMenu();
        }
        startLocal = () => {
          localRunning = true;
          rebuildMenu();
          if (connection !== undefined) run(connection.start);
          else after(relaunch);
        };
        yield* accounts.launch({ hidden: atLogin });
        openLink = handleLink;
        for (const url of launchLinks.splice(0)) openLink(url);
        if (atLogin) yield* hostedServers.prepared.pipe(Effect.andThen(installedApps.openAtLogin));
        if (!accounts.isActive("local") && early !== undefined) {
          const unused = early;
          early = undefined;
          if (!unused.isDestroyed()) unused.destroy();
        }
        if (localRunning && connection !== undefined) yield* connection.start;
        return yield* Effect.never;
      }),
      Deferred.await(quit),
    );
    return yield* Ref.get(afterStop);
  }).pipe(
    Effect.tapCause((cause) => Effect.logError("Desktop stopped", cause)),
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
    },
  );
