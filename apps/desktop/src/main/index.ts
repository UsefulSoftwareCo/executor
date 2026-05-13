import { existsSync } from "node:fs";
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
  startSidecar,
  stopSidecar,
  SidecarPortInUseError,
  type SidecarConnection,
} from "./sidecar";
import { getServerSettings, regeneratePassword, updateServerSettings } from "./settings";
import { SERVER_SETTINGS_USERNAME, type DesktopServerSettings } from "../shared/server-settings";

// Pin userData to a friendly app-name-scoped dir BEFORE app.ready so every
// Electron-side consumer (electron-store, electron-log, window-state) lands
// at a predictable spot. User-mutable executor state (data.db and the optional
// executor.jsonc plugin manifest) is pinned separately to ~/.executor in
// main/sidecar.ts — that path matches the CLI's default.
app.setName("Executor");
app.setPath("userData", join(app.getPath("appData"), "Executor"));

log.initialize({ preload: true });
log.transports.file.level = "info";

let mainWindow: BrowserWindow | null = null;
let connection: SidecarConnection | null = null;
let authHeaderUnsubscribe: (() => void) | null = null;

const PRELOAD_PATH = fileURLToPath(new URL("../preload/index.js", import.meta.url));

const ensureSingleInstance = () => {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  return true;
};

const installBasicAuthHeader = (origin: string, password: string | null) => {
  authHeaderUnsubscribe?.();
  authHeaderUnsubscribe = null;
  if (!password) return;
  const credentials = Buffer.from(`${SERVER_SETTINGS_USERNAME}:${password}`).toString("base64");
  const headerValue = `Basic ${credentials}`;
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [`${origin}/*`] },
    (details, callback) => {
      callback({
        requestHeaders: { ...details.requestHeaders, Authorization: headerValue },
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

  installBasicAuthHeader(conn.baseUrl, conn.authPassword);

  const linuxIcon = resolveLinuxIcon();

  mainWindow = new BrowserWindow({
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

  windowState.manage(mainWindow);

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  mainWindow.webContents.setWindowOpenHandler(({ url, disposition }) => {
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
            // Basic auth header injection (installBasicAuthHeader)
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

  await mainWindow.loadURL(conn.baseUrl);
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
    log.error("Failed to start executor sidecar", error);
    return null;
  }
};

const restartSidecarAndReload = async (): Promise<{ port: number; baseUrl: string }> => {
  if (connection) {
    await stopSidecar(connection.child);
    connection = null;
  }
  const next = await startWithCurrentSettings();
  if (!next) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: surfaces to renderer as a rejected IPC call
    throw new Error("Sidecar failed to restart — see Settings");
  }
  connection = next;
  installBasicAuthHeader(next.baseUrl, next.authPassword);
  if (mainWindow) await mainWindow.loadURL(next.baseUrl);
  return { port: next.port, baseUrl: next.baseUrl };
};

const registerIpcHandlers = () => {
  ipcMain.handle("executor:settings:get", (): DesktopServerSettings => getServerSettings());
  ipcMain.handle(
    "executor:settings:update",
    (_evt, patch: Partial<DesktopServerSettings>): DesktopServerSettings =>
      updateServerSettings(patch),
  );
  ipcMain.handle(
    "executor:settings:regenerate-password",
    (): DesktopServerSettings => regeneratePassword(),
  );
  ipcMain.handle("executor:server:restart", () => restartSidecarAndReload());
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
      // Stop the sidecar cleanly before Squirrel.Mac swaps the bundle.
      if (connection) {
        await stopSidecar(connection.child);
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

const installApplicationMenu = () => {
  const isMac = process.platform === "darwin";
  const appMenu: MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: "about" },
      { label: "Check for Updates…", click: () => void runUpdateCheck({ alertOnFail: true }) },
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
  connection = await startWithCurrentSettings();
  if (!connection) {
    // Even when the sidecar can't start, open the window so the user
    // reaches Settings to change the port. Pointing at the (unreachable)
    // baseUrl would just show ECONNREFUSED — a placeholder URL would be
    // worse. For now: quit with the dialog already shown.
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
    if (!connection) return;
    if (BrowserWindow.getAllWindows().length === 0) void createWindow(connection);
  });

  app.on("before-quit", async (event) => {
    if (!connection) return;
    event.preventDefault();
    await stopSidecar(connection.child);
    connection = null;
    app.exit(0);
  });
}
