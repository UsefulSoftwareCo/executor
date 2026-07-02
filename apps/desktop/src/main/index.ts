import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  nativeImage,
  session,
  shell,
} from "electron";
import windowStateKeeper from "electron-window-state";
import log from "electron-log/main.js";
import updater from "electron-updater";
const { autoUpdater } = updater;
type UpdateInfo = { readonly version: string };
import {
  attachToSupervisedDaemon,
  startSidecar,
  stopSidecar,
  onUnexpectedSidecarExit,
  SidecarPortInUseError,
  type SidecarConnection,
} from "./sidecar";
import {
  errorReportingEnabled,
  exportDiagnostics,
  exportDiagnosticsInteractive,
  getCrashReportingConfig,
  initErrorReporting,
  reportAProblem,
} from "./diagnostics";
import { sidecarCrashHtml } from "./crash-screen";
import { replaceSupervisedDaemonForDesktop } from "./supervised-connection";
import {
  bundledExecutorPath,
  installSupervisedService,
  restartSupervisedService,
  supervisedServiceStatus,
  uninstallSupervisedService,
} from "./service";
import { announceBackup, confirmResetState, resetExecutorState } from "./reset-state";
import {
  getServerProfiles,
  getServerSettings,
  rotateServerToken,
  setServerProfiles,
  updateServerSettings,
} from "./settings";
import {
  type DesktopServerConnection,
  type DesktopServerSettings,
} from "../shared/server-settings";
import {
  type DesktopUpdateStatus,
  UPDATE_INSTALL_CHANNEL,
  UPDATE_STATUS_CHANNEL,
  UPDATE_STATUS_GET_CHANNEL,
} from "../shared/update";

// Pin userData to a friendly app-name-scoped dir BEFORE app.ready so every
// Electron-side consumer (electron-store, electron-log, window-state) lands
// at a predictable spot. User-mutable executor state (data.db and the optional
// executor.jsonc plugin manifest) is pinned separately to ~/.executor in
// main/sidecar.ts — that path matches the CLI's default.
app.setName("Executor");
app.setPath("userData", join(app.getPath("appData"), "Executor"));

log.initialize({ preload: true });
log.transports.file.level = "info";

// Crash reporting must attach before app.whenReady() so Crashpad covers
// every child process (renderer, GPU). Sentry-backed only when a DSN was
// baked in at build time; otherwise dumps stay local for the diagnostics
// export.
initErrorReporting();

let mainWindow: BrowserWindow | null = null;
let connection: SidecarConnection | null = null;
let authHeaderUnsubscribe: (() => void) | null = null;

const PRELOAD_PATH = fileURLToPath(new URL("../preload/index.js", import.meta.url));

const liveMainWindow = (): BrowserWindow | null => {
  const window = mainWindow;
  if (!window) return null;
  if (window.isDestroyed()) {
    mainWindow = null;
    return null;
  }
  return window;
};

const destroyWindow = (window: BrowserWindow) => {
  if (mainWindow === window) mainWindow = null;
  if (!window.isDestroyed()) window.destroy();
};

const focusMainWindow = () => {
  const window = liveMainWindow();
  if (!window) {
    if (connection) void createWindow(connection);
    return;
  }
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
};

const ensureSingleInstance = () => {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on("second-instance", focusMainWindow);
  return true;
};

/**
 * Stop the local server only when WE own it. A supervised daemon (launchd/etc.)
 * outlives this app by design — quitting, restarting the window, or resetting
 * state must never kill it. Spawned sidecars (`child` set) are stopped as before.
 */
const stopConnection = async (conn: SidecarConnection): Promise<void> => {
  if (conn.supervisedDaemon || !conn.child) return;
  await stopSidecar(conn.child);
};

const webUrlForConnection = (conn: SidecarConnection): string => {
  const url = new URL(conn.baseUrl);
  if (conn.authToken) url.searchParams.set("_token", conn.authToken);
  url.searchParams.set("_executor_desktop_launch", String(process.pid));
  return url.toString();
};

// The supervised daemon (and the desktop sidecar) own this data dir — the same
// path the CLI's `executor web`/daemon uses, so desktop and CLI share state.
const DESKTOP_DATA_DIR = join(homedir(), ".executor");

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const parseVersionParts = (version: string): readonly number[] | null => {
  const core = version.trim().split(/[+-]/, 1)[0];
  if (!core) return null;
  const parts = core.split(".").map((part) => Number.parseInt(part, 10));
  return parts.every((part) => Number.isInteger(part) && part >= 0) ? parts : null;
};

const compareVersions = (left: string, right: string): number | null => {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);
  if (!leftParts || !rightParts) return null;
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const l = leftParts[index] ?? 0;
    const r = rightParts[index] ?? 0;
    if (l !== r) return l > r ? 1 : -1;
  }
  return 0;
};

const shouldUpgradeDaemonForDesktop = (daemonVersion: string | null): boolean => {
  if (!daemonVersion) return false;
  const comparison = compareVersions(app.getVersion(), daemonVersion);
  return comparison !== null && comparison > 0;
};

const normalizedPath = (path: string): string => path.replaceAll("\\", "/");

const shouldReplaceDaemonForDesktop = (conn: SidecarConnection): boolean => {
  if (shouldUpgradeDaemonForDesktop(conn.ownerVersion)) return true;
  if (!app.isPackaged) return false;
  const ownerPath = conn.ownerExecutablePath;
  if (!ownerPath) return false;
  if (!existsSync(ownerPath)) return true;
  if (conn.ownerClient !== "desktop") return false;
  return normalizedPath(ownerPath) !== normalizedPath(bundledExecutorPath());
};

/** Poll for a reachable supervised daemon until the deadline. */
const waitForSupervisedAttach = async (
  timeoutMs: number,
  options: { readonly port?: number } = {},
): Promise<SidecarConnection | null> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const attached = await attachToSupervisedDaemon();
    if (attached && (options.port === undefined || attached.port === options.port)) return attached;
    if (Date.now() >= deadline) return null;
    await delay(300);
  }
};

const confirmEnableBackgroundService = async (): Promise<boolean> => {
  // EXECUTOR_TEST_AUTO_CONFIRM_BACKGROUND_SERVICE skips the modal, the same seam
  // as confirmResetState. Native dialogs are unreachable from CDP/Playwright, so
  // a first-run boot under automation otherwise blocks here forever with no way
  // to answer. "1" keeps the background service; any other value declines and
  // falls back to the managed sidecar.
  const autoConfirm = process.env.EXECUTOR_TEST_AUTO_CONFIRM_BACKGROUND_SERVICE;
  if (autoConfirm !== undefined) return autoConfirm === "1";
  const { response } = await dialog.showMessageBox({
    type: "question",
    title: "Keep Executor running in the background?",
    message: "Keep your connections available after you quit Executor?",
    detail:
      "Executor can run as a lightweight background service so your MCP tools keep working after you close this window or restart your computer. You can turn this off anytime in Settings.",
    buttons: ["Keep running in the background", "Not now"],
    defaultId: 0,
    cancelId: 1,
  });
  return response === 0;
};

/**
 * Resolve a connection to the OS-supervised daemon, installing it on first run
 * (with consent). Returns null when supervision is unavailable or the user
 * declined — the caller then falls back to managed-spawn.
 */
const ensureSupervisedConnection = async (): Promise<SidecarConnection | null> => {
  // 1. Already running → attach.
  const attached = await attachToSupervisedDaemon();
  if (attached) {
    if (!shouldReplaceDaemonForDesktop(attached)) return attached;
    const settings = getServerSettings();
    return replaceSupervisedDaemonForDesktop(attached, {
      install: () =>
        installSupervisedService({
          port: settings.port,
          dataDir: DESKTOP_DATA_DIR,
        }),
      waitForAttach: () => waitForSupervisedAttach(30_000, { port: settings.port }),
      attach: attachToSupervisedDaemon,
      onInstallFailure: (error) => {
        log.warn(
          "Failed to replace older supervised daemon; re-checking before falling back",
          error,
        );
      },
    });
  }

  // Headless/e2e: the first-run background-service prompt and the systemd/
  // launchd install both need a user (and a real session bus) present. With
  // this set, fall straight through to managed-spawn after the attach attempt
  // so the packaged app can be driven without a window server. Mirrors
  // EXECUTOR_TEST_AUTO_CONFIRM_RESET in reset-state.ts.
  if (process.env.EXECUTOR_TEST_SKIP_BACKGROUND_SERVICE === "1") return null;

  const status = await supervisedServiceStatus();
  if (!status.supported) return null;

  // 2. Registered but not currently serving → kick it and wait.
  if (status.registered) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: a restart failure just falls through to managed-spawn
    try {
      await restartSupervisedService();
    } catch (error) {
      log.warn("Failed to kickstart supervised service", error);
    }
    return waitForSupervisedAttach(15_000);
  }

  // 3. First run → ask, then install + start. The unit carries no secret; the
  // supervised daemon mints/loads its bearer from auth.json under DESKTOP_DATA_DIR.
  if (!(await confirmEnableBackgroundService())) return null;
  const settings = getServerSettings();
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: install failure falls back to managed-spawn so the app still launches
  try {
    await installSupervisedService({
      port: settings.port,
      dataDir: DESKTOP_DATA_DIR,
    });
  } catch (error) {
    log.error("Failed to install supervised service; using managed sidecar", error);
    return null;
  }
  return waitForSupervisedAttach(15_000);
};

// Crash monitor for the supervised daemon: the OS service manager restarts it
// on crash, but during that window the window's requests fail. Poll, show a
// reconnecting overlay while it's down, and reload once it's back.
let supervisedMonitorTimer: ReturnType<typeof setInterval> | null = null;
let supervisedDaemonDown = false;
let supervisedMonitorMisses = 0;
const SUPERVISED_MONITOR_MISSES_BEFORE_DOWN = 3;

const stopSupervisedMonitor = () => {
  if (supervisedMonitorTimer) clearInterval(supervisedMonitorTimer);
  supervisedMonitorTimer = null;
  supervisedDaemonDown = false;
  supervisedMonitorMisses = 0;
};

const armSupervisedMonitor = () => {
  stopSupervisedMonitor();
  supervisedMonitorTimer = setInterval(() => {
    void (async () => {
      const live = await attachToSupervisedDaemon();
      const window = liveMainWindow();
      if (!live) {
        supervisedMonitorMisses += 1;
        if (supervisedMonitorMisses < SUPERVISED_MONITOR_MISSES_BEFORE_DOWN) return;
        if (!supervisedDaemonDown && window) {
          supervisedDaemonDown = true;
          const html = sidecarCrashHtml({ reported: errorReportingEnabled });
          void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        }
        return;
      }
      supervisedMonitorMisses = 0;
      if (supervisedDaemonDown) {
        supervisedDaemonDown = false;
        connection = live;
        installBearerAuthHeader(live.baseUrl, live.authToken);
        if (window) void window.loadURL(webUrlForConnection(live));
      }
    })();
  }, 10_000);
};

const installBearerAuthHeader = (origin: string, token: string | null) => {
  authHeaderUnsubscribe?.();
  authHeaderUnsubscribe = null;
  if (!token) return;
  const headerValue = `Bearer ${token}`;
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [`${origin}/*`] },
    (details, callback) => {
      // Scope the bearer to the app's OWN renderer. OAuth popups run in this same
      // session but load third-party provider pages; auto-attaching the bearer to
      // any request they make to the sidecar would make it an ambient credential
      // (a CSRF vector) for untrusted content — the very thing the bearer model
      // exists to avoid. The popup only ever needs the bearer-exempt
      // /oauth/callback and hands its result back via same-origin browser
      // channels (localStorage/postMessage), so withholding the bearer from any
      // non-app webContents is safe. Requests with no webContentsId (main
      // process / network service) still get it.
      const fromOtherWebContents =
        details.webContentsId !== undefined &&
        (mainWindow === null || details.webContentsId !== mainWindow.webContents.id);
      if (fromOtherWebContents) {
        callback({ requestHeaders: details.requestHeaders });
        return;
      }
      callback({
        requestHeaders: {
          ...details.requestHeaders,
          Authorization: headerValue,
        },
      });
    },
  );
  authHeaderUnsubscribe = () => {
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, null);
  };
};

/**
 * Resolve the on-disk path to the Executor app icon. Packaged builds get
 * the .icns/.ico baked in by electron-builder, but in dev mode Electron
 * launches via the bare runtime binary with no bundled icon — so we set
 * it programmatically (dock on mac, BrowserWindow on linux/win).
 *
 * In dev `app.getAppPath()` returns the directory of the app's
 * `package.json` (i.e. `apps/desktop`), which is more robust than
 * relative path math from the compiled main bundle.
 */
const resolveSourceIconPath = (): string =>
  app.isPackaged
    ? join(process.resourcesPath, "icon.png")
    : join(app.getAppPath(), "build", "icon.png");

const resolveLinuxIcon = (): string | undefined => {
  if (process.platform !== "linux") return undefined;
  return resolveSourceIconPath();
};

/**
 * Set the macOS dock icon at runtime. Packaged builds already use the
 * bundle's .icns; this matters only in dev where the bare electron binary
 * defaults to the Electron diamond.
 *
 * `setIcon` accepts a file path but silently no-ops if the underlying
 * image fails to decode — we route through `nativeImage.createFromPath`
 * + an `isEmpty()` check so we can surface the bad-path case in the log.
 */
const installDockIcon = () => {
  if (process.platform !== "darwin") return;
  if (app.isPackaged) return;
  if (!app.dock) return;
  const iconPath = resolveSourceIconPath();
  if (!existsSync(iconPath)) {
    log.warn(`[dock-icon] file missing at ${iconPath}; skipping`);
    return;
  }
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    log.warn(`[dock-icon] failed to decode ${iconPath}; skipping`);
    return;
  }
  app.dock.setIcon(image);
  log.info(`[dock-icon] set to ${iconPath} (${image.getSize().width}×${image.getSize().height})`);
};

const createWindow = async (conn: SidecarConnection) => {
  const windowState = windowStateKeeper({
    defaultWidth: 1280,
    defaultHeight: 800,
  });

  installBearerAuthHeader(conn.baseUrl, conn.authToken);

  const linuxIcon = resolveLinuxIcon();

  const window = new BrowserWindow({
    x: windowState.x,
    y: windowState.y,
    width: windowState.width,
    height: windowState.height,
    // Keep the window at or above the responsive layout's mobile breakpoint
    // (Tailwind `md` = 768px). Below it the web shell switches to the mobile
    // header, whose far-left hamburger would render under the native macOS
    // traffic lights (issue #1125). Staying >= 768 means the desktop always
    // renders the sidebar layout, so the lights only ever sit over the sidebar
    // header, which is offset to clear them (.desktop-macos-titlebar).
    minWidth: 768,
    minHeight: 480,
    show: false,
    backgroundColor: "#0a0a0a",
    autoHideMenuBar: true,
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 16, y: 17 } }
      : {}),
    ...(linuxIcon ? { icon: linuxIcon } : {}),
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;

  windowState.manage(window);

  window.once("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) window.show();
  });

  window.webContents.setWindowOpenHandler(({ url, disposition }) => {
    // JS-initiated `window.open(url, name, "popup=1,...")` calls (OAuth
    // sign-in flow in packages/react/src/api/oauth-popup.ts:73) come in
    // with disposition "new-window" — allow them as Electron child
    // windows so the renderer's popup tracking (closed polling +
    // BroadcastChannel handoff) works. Plain `<a target="_blank">`
    // link clicks come in as "foreground-tab" / "background-tab" /
    // "other" and route to the user's default browser.
    if (disposition === "new-window") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: {
            // No preload, no nodeIntegration — popup loads third-party
            // OAuth provider pages, then a final navigation back to
            // 127.0.0.1:<port>/oauth/callback which the session-level
            // bearer header injection (installBearerAuthHeader)
            // catches automatically. The popup never needs the
            // executor IPC bridge.
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      };
    }
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // A supervised daemon can pass the health probe and still disappear before
  // navigation begins. Treat that as a failed connection instead of leaving the
  // user with a visible BrowserWindow that only shows the black background.
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: Electron navigation rejects when the sidecar vanishes during startup
  try {
    await window.loadURL(webUrlForConnection(conn));
  } catch (error) {
    log.error("Failed to load Executor web UI", error);
    destroyWindow(window);
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: caller decides whether to fall back or surface startup failure
    throw error;
  }
};

const showPortInUseDialog = async (port: number) => {
  await dialog.showMessageBox({
    type: "error",
    title: "Executor port in use",
    message: `Port ${port} is already taken.`,
    detail:
      "Another process is listening on that port. Quit it (or change the desktop server's port in Settings) and relaunch Executor.",
    buttons: ["OK"],
  });
};

// Last non-port-conflict sidecar startup failure, surfaced by boot() in a
// user-facing dialog instead of letting the app vanish without a window.
let lastSidecarStartError: unknown = null;

// A spawn aborts with this when another local server already owns ~/.executor:
// the bundled `executor daemon run` (packaged) or assertNoOtherLocalServerOwner
// (dev) both phrase it the same way. Treated as fatal historically, which
// wedged the app into the crash screen whenever a CLI `executor daemon run`
// (or a daemon a prior run left behind) held the data dir.
const isScopeOwnershipConflict = (error: unknown): boolean => {
  // oxlint-disable-next-line executor/no-instanceof-error, executor/no-unknown-error-message -- boundary: spawn-conflict failures arrive as plain Node errors from startSidecar; classified by message text
  const message = error instanceof Error ? error.message : String(error);
  return /already running|owns the current data directory/i.test(message);
};

const startWithCurrentSettings = async (): Promise<SidecarConnection | null> => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: bind failures surface as a user-facing dialog
  try {
    return await startSidecar();
  } catch (error) {
    // oxlint-disable-next-line executor/no-instanceof-tagged-error -- boundary: SidecarPortInUseError is a plain Node Error subclass, not an Effect tagged error
    if (error instanceof SidecarPortInUseError) {
      await showPortInUseDialog(error.port);
      return null;
    }
    // The data dir is already owned by another local daemon. If it's a healthy
    // cli-daemon, adopt it instead of failing — the same handoff boot() does up
    // front, applied here so the fallback and restart paths recover from a
    // mid-session daemon takeover. Poll briefly to ride out an owner that's
    // alive but still finishing its own startup (the health-probe vs.
    // scope-lock race that left the app wedged on the crash screen).
    if (isScopeOwnershipConflict(error)) {
      const adopted = await waitForSupervisedAttach(10_000);
      if (adopted) {
        log.info(
          "Adopted the local daemon that owns the data dir instead of spawning a second one",
        );
        return adopted;
      }
    }
    lastSidecarStartError = error;
    log.error("Failed to start executor sidecar", error);
    return null;
  }
};

const restartSidecarAndReload = async (): Promise<DesktopServerConnection> => {
  // A supervised daemon owns its own process lifetime. Re-installing the unit
  // rewrites settings such as the configured port, then launchd restarts it.
  if (connection?.supervisedDaemon) {
    const port = getServerSettings().port;
    await installSupervisedService({
      port,
      dataDir: DESKTOP_DATA_DIR,
    });
    const next = await waitForSupervisedAttach(30_000, { port });
    if (!next) {
      // oxlint-disable-next-line executor/no-error-constructor, executor/no-try-catch-or-throw -- boundary: surfaces to renderer as a rejected IPC call
      throw new Error("Supervised daemon failed to restart — see Settings");
    }
    connection = next;
    installBearerAuthHeader(next.baseUrl, next.authToken);
    const window = liveMainWindow();
    if (window) await window.loadURL(webUrlForConnection(next));
    return toDesktopServerConnection(next);
  }
  if (connection) {
    await stopConnection(connection);
    connection = null;
  }
  const next = await startWithCurrentSettings();
  if (!next) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: surfaces to renderer as a rejected IPC call
    throw new Error("Sidecar failed to restart — see Settings");
  }
  connection = next;
  // A restart can adopt a daemon that already owns the data dir (the
  // attach-on-conflict fallback). An adopted daemon has no child process, so
  // onUnexpectedSidecarExit can't see it die — watch it with the supervised
  // monitor instead. A freshly spawned sidecar keeps the child-exit path.
  if (next.supervisedDaemon) armSupervisedMonitor();
  else stopSupervisedMonitor();
  installBearerAuthHeader(next.baseUrl, next.authToken);
  const window = liveMainWindow();
  if (window) await window.loadURL(webUrlForConnection(next));
  return toDesktopServerConnection(next);
};

// The renderer's connection carries NO auth: the main process injects the
// bearer header at the session layer (installBearerAuthHeader), so the token
// never crosses the IPC boundary.
const toDesktopServerConnection = (conn: SidecarConnection): DesktopServerConnection => ({
  kind: "desktop-sidecar",
  key: "desktop-sidecar",
  origin: conn.baseUrl,
  apiBaseUrl: `${conn.baseUrl.replace(/\/+$/, "")}/api`,
  displayName: "Local Executor",
});

const registerIpcHandlers = () => {
  ipcMain.handle("executor:server:connection", (): DesktopServerConnection | null =>
    connection ? toDesktopServerConnection(connection) : null,
  );
  // The bearer token, exposed only for the "Connect an agent" install command
  // (an external agent needs it in plaintext). The renderer's own requests
  // never use it — the header is injected at the session layer.
  ipcMain.handle("executor:server:auth-token", (): string | null => connection?.authToken ?? null);
  ipcMain.handle("executor:settings:get", (): DesktopServerSettings => getServerSettings());
  ipcMain.handle(
    "executor:settings:update",
    (_evt, patch: Partial<DesktopServerSettings>): DesktopServerSettings =>
      updateServerSettings(patch),
  );
  // Rotate the bearer token (auth.json). A supervised daemon must be restarted
  // so it re-reads auth.json at boot, then re-attached; a managed sidecar is
  // restarted in-process. Either way the webview header is re-injected.
  ipcMain.handle("executor:server:rotate-token", async (): Promise<DesktopServerConnection> => {
    rotateServerToken();
    if (connection?.supervisedDaemon) {
      const previous = connection;
      await restartSupervisedService();
      const active = (await waitForSupervisedAttach(15_000)) ?? previous;
      connection = active;
      installBearerAuthHeader(active.baseUrl, active.authToken);
      const window = liveMainWindow();
      if (window) await window.loadURL(webUrlForConnection(active));
      return toDesktopServerConnection(active);
    }
    return restartSidecarAndReload();
  });
  // Background-service control surface — lets a Settings toggle enable or
  // disable the supervised daemon. Disabling tears down the service and falls
  // back to a managed sidecar on next launch.
  ipcMain.handle("executor:service:status", () => supervisedServiceStatus());
  ipcMain.handle(
    "executor:service:set-enabled",
    async (_evt, enabled: unknown): Promise<boolean> => {
      if (typeof enabled !== "boolean") return false;
      if (enabled) {
        const settings = getServerSettings();
        await installSupervisedService({
          port: settings.port,
          dataDir: DESKTOP_DATA_DIR,
        });
        const next = await waitForSupervisedAttach(15_000);
        if (next) {
          if (connection && !connection.supervisedDaemon) await stopConnection(connection);
          connection = next;
          armSupervisedMonitor();
          installBearerAuthHeader(next.baseUrl, next.authToken);
          const window = liveMainWindow();
          if (window) await window.loadURL(webUrlForConnection(next));
        }
        return true;
      }
      stopSupervisedMonitor();
      await uninstallSupervisedService(DESKTOP_DATA_DIR);
      return true;
    },
  );
  ipcMain.handle("executor:server-profiles:get", (): string | null => getServerProfiles());
  ipcMain.handle("executor:server-profiles:set", (_evt, value: unknown): void => {
    if (typeof value !== "string") return;
    setServerProfiles(value);
  });
  ipcMain.handle("executor:server:restart", () => restartSidecarAndReload());
  ipcMain.handle("executor:diagnostics:export", () => exportDiagnostics());
  ipcMain.handle("executor:crash-reporting:get", () => getCrashReportingConfig());
  // Crash-screen escape hatch: a recurring sidecar crash may already be
  // fixed upstream. Reuses the menu flow — staged updates prompt to install,
  // "no updates" / failures surface in their own dialogs.
  ipcMain.handle("executor:updates:check", () => runUpdateCheck({ alertOnFail: true }));
  ipcMain.handle(UPDATE_STATUS_GET_CHANNEL, (): DesktopUpdateStatus => updateStatus);
  ipcMain.handle(UPDATE_INSTALL_CHANNEL, async (): Promise<void> => {
    const version = "version" in updateStatus ? updateStatus.version : "";
    // Outside a packaged build there is no real bundle to swap, and quitting
    // would tear down the e2e harness — reflect "installing" so the renderer
    // can prove the wiring instead.
    if (!app.isPackaged) {
      setUpdateStatus({ state: "installing", version });
      return;
    }
    // Stop the sidecar cleanly before Squirrel.Mac swaps the bundle, matching
    // the native dialog's restart path.
    if (connection) {
      await stopConnection(connection);
      connection = null;
    }
    autoUpdater.quitAndInstall(false, true);
  });
  // Crash-screen last resort for damaged state: confirm, move the data dir
  // aside (never delete), then restart the sidecar against the fresh dir.
  // Returns false when the user cancelled.
  ipcMain.handle("executor:state:reset", async (): Promise<boolean> => {
    if (!(await confirmResetState())) return false;
    if (connection) {
      await stopConnection(connection);
      connection = null;
    }
    const { backupDir } = resetExecutorState();
    await restartSidecarAndReload();
    await announceBackup(backupDir);
    return true;
  });
  ipcMain.handle("executor:shell:open-external", async (_evt, rawUrl: unknown) => {
    if (typeof rawUrl !== "string") return;
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: untrusted renderer string, URL ctor throws on malformed input
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
      await shell.openExternal(parsed.toString());
    } catch {
      // Reject malformed URLs silently — renderer falls back to popup flow.
    }
  });
};

// ──────────────────────────────────────────────────────────────────────
// Auto-updates — opencode-style dialog flow.
//
// electron-updater's `checkForUpdatesAndNotify()` default swaps the app
// silently on quit, so users have no signal an update is ready until
// they relaunch and notice the version changed. We replace it with:
//
//   - autoDownload: true   — pull the next version in the background
//   - autoInstallOnAppQuit: false — never swap silently
//   - on 'update-downloaded' → native dialog with Restart now / Later
//   - "Check for Updates…" app menu item runs the same flow manually
//
// Auto-checks at boot stay quiet on failure / no-op. The manual menu
// invocation surfaces both outcomes explicitly via `alertOnFail`.
// ──────────────────────────────────────────────────────────────────────

let downloadedUpdateVersion: string | null = null;
let updateDialogOpen = false;

// Renderer-facing auto-update status. The web shell renders a desktop-native
// "Restart to update" card from this (in place of its npm card) — see
// ../shared/update.ts and packages/react/.../hooks/desktop-update.ts.
let updateStatus: DesktopUpdateStatus = { state: "idle" };
let pendingUpdateVersion: string | null = null;

type ProgressInfo = { readonly percent: number };

const broadcastUpdateStatus = () => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(UPDATE_STATUS_CHANNEL, updateStatus);
  }
};

const setUpdateStatus = (status: DesktopUpdateStatus) => {
  updateStatus = status;
  broadcastUpdateStatus();
};

// Dev/e2e seam: a packaged build is required for a REAL electron-updater
// release, so `EXECUTOR_DESKTOP_FAKE_UPDATE` (JSON like
// `{"state":"downloaded","version":"99.0.0"}`) seeds a status to exercise the
// renderer card and the install handler without one. Ignored in production.
const applyFakeUpdateFromEnv = () => {
  // Never honor the fake seam in a packaged build: a stray env var would seed a
  // phantom "downloaded" update whose install quits the app against nothing.
  if (app.isPackaged) return;
  const raw = process.env.EXECUTOR_DESKTOP_FAKE_UPDATE?.trim();
  if (!raw) return;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: dev-only env override is untrusted text; a malformed value is logged and ignored, not fatal
  try {
    // oxlint-disable-next-line executor/no-json-parse -- boundary: dev-only env override, shape-checked below
    const parsed = JSON.parse(raw) as { readonly state?: string; readonly version?: string };
    const version = typeof parsed.version === "string" ? parsed.version : "0.0.0";
    const state = parsed.state ?? "downloaded";
    if (
      state === "available" ||
      state === "downloaded" ||
      state === "downloading" ||
      state === "installing"
    ) {
      if (state === "downloaded") downloadedUpdateVersion = version;
      setUpdateStatus(
        state === "downloading" ? { state, version, percent: 100 } : { state, version },
      );
    }
  } catch (error) {
    log.warn("[updater] bad EXECUTOR_DESKTOP_FAKE_UPDATE", error);
  }
};

const promptInstallUpdate = async (version: string) => {
  if (updateDialogOpen) return;
  updateDialogOpen = true;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: dialog wrapper guarantees the open flag clears
  try {
    const response = await dialog.showMessageBox({
      type: "info",
      title: "Update ready",
      message: `Executor ${version} is ready to install.`,
      detail: "Restart now to apply the update, or keep working — we'll prompt again later.",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response.response === 0) {
      // Stop the sidecar cleanly before Squirrel.Mac swaps the bundle. A
      // supervised daemon is left running — it's independent of this bundle.
      if (connection) {
        await stopConnection(connection);
        connection = null;
      }
      autoUpdater.quitAndInstall(false, true);
    }
  } finally {
    updateDialogOpen = false;
  }
};

// Re-check periodically so a long-running session picks up releases
// without requiring a quit + relaunch. The boot-time check still runs;
// this interval is purely a self-heal for idle apps.
const UPDATE_POLL_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

const setupAutoUpdater = () => {
  if (!app.isPackaged) return;
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("update-available", (info: UpdateInfo) => {
    pendingUpdateVersion = info.version;
    setUpdateStatus({ state: "available", version: info.version });
  });
  autoUpdater.on("download-progress", (progress: ProgressInfo) => {
    if (pendingUpdateVersion) {
      setUpdateStatus({
        state: "downloading",
        version: pendingUpdateVersion,
        percent: Math.round(progress.percent ?? 0),
      });
    }
  });
  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    downloadedUpdateVersion = info.version;
    setUpdateStatus({ state: "downloaded", version: info.version });
    void promptInstallUpdate(info.version);
  });
  autoUpdater.on("error", (err: Error) => {
    log.warn("[updater] error", err);
  });

  setInterval(() => {
    if (downloadedUpdateVersion) return; // already staged; waiting on the user
    void runUpdateCheck({ alertOnFail: false });
  }, UPDATE_POLL_INTERVAL_MS);
};

interface UpdateCheckOptions {
  readonly alertOnFail: boolean;
}

const runUpdateCheck = async ({ alertOnFail }: UpdateCheckOptions) => {
  if (!app.isPackaged) {
    if (alertOnFail) {
      await dialog.showMessageBox({
        type: "info",
        title: "Updates unavailable",
        message: "Auto-update is only enabled in packaged builds.",
      });
    }
    return;
  }
  if (downloadedUpdateVersion) {
    await promptInstallUpdate(downloadedUpdateVersion);
    return;
  }
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: surface network/update failures only when the user asked
  try {
    const result = await autoUpdater.checkForUpdates();
    const newer = result?.isUpdateAvailable === true;
    if (!alertOnFail) return;
    if (newer) return; // 'update-downloaded' handler will fire the install dialog
    await dialog.showMessageBox({
      type: "info",
      title: "No updates",
      message: `You're on the latest version (${app.getVersion()}).`,
    });
  } catch (error) {
    log.warn("[updater] check failed", error);
    if (!alertOnFail) return;
    await dialog.showMessageBox({
      type: "error",
      title: "Update check failed",
      message: "Couldn't reach the update server.",
      detail: "Check your network and try again from the menu.",
    });
  }
};

// A sidecar that can't boot usually means a broken build or an incompatible
// data dir — both states the user can't see from a dock icon that bounces
// once and disappears. Surface the real error, and stage any available update
// so a dead-on-arrival release can heal itself: without the explicit check
// here, the boot-time update check never runs (it sits after a successful
// sidecar start), so a broken app could never self-update its way out.
const handleFatalSidecarFailure = async (error: unknown) => {
  if (app.isPackaged) {
    // Install whatever finishes downloading by the time the user quits the
    // failure dialog; if it downloads while the dialog is open, the regular
    // 'update-downloaded' prompt offers an immediate restart instead.
    autoUpdater.autoInstallOnAppQuit = true;
    void runUpdateCheck({ alertOnFail: false });
  }
  // oxlint-disable-next-line executor/no-instanceof-error, executor/no-unknown-error-message -- boundary: sidecar startup failures arrive as plain Node errors and render in a native dialog
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const { response } = await dialog.showMessageBox({
    type: "error",
    title: "Executor failed to start",
    message: "The local Executor server crashed during startup.",
    detail: `${detail.slice(0, 1800)}\n\nFull log: ${log.transports.file.getFile().path}`,
    buttons: ["Quit", "Reset data and retry…"],
    defaultId: 0,
    cancelId: 0,
  });
  // Damaged executor state (failed migration, corrupt SQLite) makes startup
  // fail forever — updating can't fix it. Offer the move-aside reset and one
  // immediate retry. Returns true when boot should be attempted again.
  if (response === 1 && (await confirmResetState())) {
    const { backupDir } = resetExecutorState();
    await announceBackup(backupDir);
    return true;
  }
  return false;
};

const installApplicationMenu = () => {
  const isMac = process.platform === "darwin";
  const appMenu: MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: "about" },
      {
        label: "Check for Updates…",
        click: () => void runUpdateCheck({ alertOnFail: true }),
      },
      {
        label: "Export Diagnostics…",
        click: () => void exportDiagnosticsInteractive(),
      },
      {
        label: "Report a Problem…",
        click: () => void reportAProblem(),
      },
      {
        label: "Documentation",
        click: () => void shell.openExternal("https://executor.sh/docs"),
      },
      { type: "separator" },
      ...(isMac
        ? ([
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
          ] as MenuItemConstructorOptions[])
        : []),
      { role: "quit" },
    ],
  };
  // The close-window accelerator (Cmd+W on macOS, Ctrl+W elsewhere) lives on
  // the `close` role, which the File menu carries. The Window menu's role only
  // provides Minimize/Zoom/Front, so without an explicit File menu nothing
  // binds Cmd+W and the window can't be closed from the keyboard.
  const fileMenu: MenuItemConstructorOptions = {
    label: "File",
    submenu: [{ role: "close" }],
  };
  // The web shell navigates with browser history (TanStack Router pushState),
  // but Electron binds none of the history shortcuts by default and the menu is
  // built from roles, none of which carry Back/Forward. So the standard macOS
  // Cmd+[ / Cmd+] (Ctrl+[ / Ctrl+] elsewhere) are dead keys inside the desktop
  // window, with no browser chrome to fall back on. Bind them here, driving the
  // focused window's navigation history. canGo* guards keep the keys no-ops at
  // the ends of the stack, matching how they behave in a browser.
  const navigateHistory = (direction: "back" | "forward") => {
    const nav = BrowserWindow.getFocusedWindow()?.webContents.navigationHistory;
    if (!nav) return;
    if (direction === "back") {
      if (nav.canGoBack()) nav.goBack();
    } else if (nav.canGoForward()) {
      nav.goForward();
    }
  };
  const historyMenu: MenuItemConstructorOptions = {
    label: "History",
    submenu: [
      {
        label: "Back",
        accelerator: "CmdOrCtrl+[",
        click: () => navigateHistory("back"),
      },
      {
        label: "Forward",
        accelerator: "CmdOrCtrl+]",
        click: () => navigateHistory("forward"),
      },
    ],
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      appMenu,
      fileMenu,
      { role: "editMenu" },
      { role: "viewMenu" },
      historyMenu,
      { role: "windowMenu" },
    ]),
  );
};

const boot = async () => {
  installDockIcon();
  installApplicationMenu();
  setupAutoUpdater();
  applyFakeUpdateFromEnv();
  registerIpcHandlers();
  // A sidecar that dies under a live window would leave the web UI failing
  // every request with no explanation. Swap in the crash screen — its
  // buttons drive the regular preload bridge (restart / export diagnostics).
  onUnexpectedSidecarExit(() => {
    const window = liveMainWindow();
    if (!window) return;
    const html = sidecarCrashHtml({ reported: errorReportingEnabled });
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    // A crashing sidecar may be a broken release — quietly stage any
    // available update so the install prompt appears on its own (same
    // self-heal as the fatal startup path).
    void runUpdateCheck({ alertOnFail: false });
  });
  // Prefer an OS-supervised daemon: attach to one that's running, kick one
  // that's installed, or offer to install on first run. Quitting the app then
  // leaves MCP serving. This is also the clean handoff that replaces the old
  // "another server owns the data dir → fatal error" path. Packaged builds only;
  // dev and unsupported platforms keep managed-spawn.
  if (app.isPackaged) {
    const supervised = await ensureSupervisedConnection();
    if (supervised) {
      connection = supervised;
      // createWindow installs the bearer-auth header itself.
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: supervised attach can race with daemon shutdown; fall back to managed spawn
      try {
        await createWindow(supervised);
        armSupervisedMonitor();
        void runUpdateCheck({ alertOnFail: false });
        return;
      } catch (error) {
        log.warn("Failed to load supervised daemon; falling back to managed sidecar", error);
        stopSupervisedMonitor();
        connection = null;
      }
    }
  }
  connection = await startWithCurrentSettings();
  if (!connection && lastSidecarStartError != null) {
    // Port conflicts already showed their dialog inside
    // startWithCurrentSettings; every other failure surfaces here so the app
    // never silently bounces-and-vanishes. The dialog offers a data reset
    // (move-aside, for damaged state) — when taken, retry the boot once
    // against the fresh dir.
    const retryAfterReset = await handleFatalSidecarFailure(lastSidecarStartError);
    if (retryAfterReset) {
      lastSidecarStartError = null;
      connection = await startWithCurrentSettings();
      if (!connection && lastSidecarStartError != null) {
        await handleFatalSidecarFailure(lastSidecarStartError);
      }
    }
  }
  if (!connection) {
    app.quit();
    return;
  }
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: renderer navigation failure must show the startup recovery dialog, not a black window
  try {
    await createWindow(connection);
    // The fallback can adopt a daemon that owns the data dir instead of
    // spawning (attach-on-conflict). Like the primary supervised path, watch an
    // adopted daemon with the supervised monitor — it has no child process for
    // onUnexpectedSidecarExit to observe.
    if (connection.supervisedDaemon) armSupervisedMonitor();
  } catch (error) {
    log.error("Failed to load managed sidecar web UI", error);
    const failedConnection = connection;
    connection = null;
    await stopConnection(failedConnection);

    const retryAfterReset = await handleFatalSidecarFailure(error);
    if (!retryAfterReset) {
      app.quit();
      return;
    }

    lastSidecarStartError = null;
    connection = await startWithCurrentSettings();
    if (!connection && lastSidecarStartError != null) {
      await handleFatalSidecarFailure(lastSidecarStartError);
    }
    if (!connection) {
      app.quit();
      return;
    }

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: one post-reset retry before giving the user the final startup failure
    try {
      await createWindow(connection);
    } catch (retryError) {
      log.error("Failed to load managed sidecar web UI after reset", retryError);
      const failedRetryConnection = connection;
      connection = null;
      await stopConnection(failedRetryConnection);
      await handleFatalSidecarFailure(retryError);
      app.quit();
      return;
    }
  }
  // Check at boot. If an update is available, autoDownload pulls it and
  // the 'update-downloaded' handler fires the install dialog. Silent on
  // no-update / failure so we don't bother users on every launch.
  void runUpdateCheck({ alertOnFail: false });
};

if (ensureSingleInstance()) {
  app.whenReady().then(boot);

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    focusMainWindow();
  });

  app.on("before-quit", async (event) => {
    if (!connection) return;
    // A supervised daemon must keep serving after the app quits — don't stop it,
    // and don't block the quit on teardown we don't need to do.
    if (connection.supervisedDaemon) {
      connection = null;
      return;
    }
    event.preventDefault();
    await stopConnection(connection);
    connection = null;
    app.exit(0);
  });
}
