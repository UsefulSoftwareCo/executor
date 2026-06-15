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
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: desktop launch should attach to the running daemon if automatic upgrade fails
    try {
      await installSupervisedService({
        port: settings.port,
        dataDir: DESKTOP_DATA_DIR,
      });
      return (await waitForSupervisedAttach(30_000, { port: settings.port })) ?? attached;
    } catch (error) {
      log.warn("Failed to replace older supervised daemon; attaching to the running daemon", error);
      return attached;
    }
  }

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

const stopSupervisedMonitor = () => {
  if (supervisedMonitorTimer) clearInterval(supervisedMonitorTimer);
  supervisedMonitorTimer = null;
  supervisedDaemonDown = false;
};

const armSupervisedMonitor = () => {
  stopSupervisedMonitor();
  supervisedMonitorTimer = setInterval(() => {
    void (async () => {
      const live = await attachToSupervisedDaemon();
      const window = liveMainWindow();
      if (!live) {
        if (!supervisedDaemonDown && window) {
          supervisedDaemonDown = true;
          const html = sidecarCrashHtml({ reported: errorReportingEnabled });
          void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        }
        return;
      }
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
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: "#0a0a0a",
    autoHideMenuBar: true,
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

  await window.loadURL(webUrlForConnection(conn));
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

  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    downloadedUpdateVersion = info.version;
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
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      appMenu,
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
};

const boot = async () => {
  installDockIcon();
  installApplicationMenu();
  setupAutoUpdater();
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
      await createWindow(supervised); // installs the bearer-auth header itself
      armSupervisedMonitor();
      void runUpdateCheck({ alertOnFail: false });
      return;
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
  await createWindow(connection);
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
