import { join } from "node:path";
import { app, BrowserWindow, session, shell } from "electron";
import windowStateKeeper from "electron-window-state";
import log from "electron-log/main.js";
import updater from "electron-updater";
const { autoUpdater } = updater;
import { startSidecar, stopSidecar, type SidecarConnection } from "./sidecar";

// Pin userData to an appId-scoped dir BEFORE app.ready so every downstream
// consumer (electron-store, the sidecar's EXECUTOR_SCOPE_DIR, electron-log)
// agrees on the location. Without this, userData defaults to a path derived
// from package.json#name (`@executor-js/desktop`), which is ugly and changes
// if we ever rename the workspace package.
const APP_ID = "sh.executor.desktop";
app.setName("Executor");
app.setPath("userData", join(app.getPath("appData"), APP_ID));

log.initialize({ preload: true });
log.transports.file.level = "info";

let mainWindow: BrowserWindow | null = null;
let connection: SidecarConnection | null = null;

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

const installBasicAuthHeader = (origin: string, password: string) => {
  const credentials = Buffer.from(`executor:${password}`).toString("base64");
  const headerValue = `Basic ${credentials}`;
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [`${origin}/*`] },
    (details, callback) => {
      callback({
        requestHeaders: {
          ...details.requestHeaders,
          Authorization: headerValue,
        },
      });
    },
  );
};

const createWindow = async (conn: SidecarConnection) => {
  const windowState = windowStateKeeper({
    defaultWidth: 1280,
    defaultHeight: 800,
  });

  installBasicAuthHeader(conn.baseUrl, conn.authPassword);

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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  windowState.manage(mainWindow);

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  await mainWindow.loadURL(conn.baseUrl);
};

const boot = async () => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: top-level boot path translates failures into a user-facing error
  try {
    connection = await startSidecar();
    await createWindow(connection);

    if (app.isPackaged) {
      autoUpdater.logger = log;
      void autoUpdater.checkForUpdatesAndNotify();
    }
  } catch (error) {
    log.error("Failed to start executor sidecar", error);
    app.quit();
  }
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
