import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  session,
  type MenuItemConstructorOptions,
} from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve, basename } from "node:path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  appendFileSync,
} from "node:fs";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 14788;
const DEV_SERVER_URL = process.env.EXECUTOR_DEV_URL || "http://executor-local.localhost:1355";
const SERVER_STARTUP_TIMEOUT_MS = 30_000;
const SETTINGS_DIR = join(homedir(), ".executor");
const SETTINGS_PATH = join(SETTINGS_DIR, "desktop-settings.json");

const CLI_BIN_DIR = join(SETTINGS_DIR, "bin");
const CLI_BIN_PATH = join(CLI_BIN_DIR, process.platform === "win32" ? "executor.exe" : "executor");

const htmlEscape = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// ---------------------------------------------------------------------------
// CLI install — copy sidecar to ~/.executor/bin and patch shell PATH
// ---------------------------------------------------------------------------

const getCliVersion = (path: string): string | null => {
  if (!existsSync(path)) return null;
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    return execFileSync(path, ["--version"], {
      timeout: 5000,
      encoding: "utf-8",
    }).trim();
  } catch {
    return null;
  }
};

const getInstalledCliVersion = (): string | null => getCliVersion(CLI_BIN_PATH);

const installCli = (): void => {
  if (isDev) return;

  const sidecar = join(process.resourcesPath, binaryName);
  if (!existsSync(sidecar)) return;

  // Check if installed version is already same or newer
  const bundledVersion = getCliVersion(sidecar) ?? app.getVersion();
  const installedVersion = getInstalledCliVersion();
  if (installedVersion) {
    const parse = (v: string) =>
      v
        .replace(/^v/, "")
        .split(/[.-]/)
        .map((s) => {
          const n = parseInt(s, 10);
          return isNaN(n) ? 0 : n;
        });
    const installed = parse(installedVersion);
    const bundled = parse(bundledVersion);
    const len = Math.max(installed.length, bundled.length);
    let cmp = 0;
    for (let i = 0; i < len && cmp === 0; i++) {
      cmp = (installed[i] ?? 0) - (bundled[i] ?? 0);
    }
    if (cmp >= 0) return; // Already up to date or newer
  }

  // Copy binary
  mkdirSync(CLI_BIN_DIR, { recursive: true });
  copyFileSync(sidecar, CLI_BIN_PATH);
  try {
    chmodSync(CLI_BIN_PATH, 0o755);
  } catch {}
  console.log(
    `Installed executor CLI ${bundledVersion} to ${CLI_BIN_PATH}` +
      (installedVersion ? ` (was ${installedVersion})` : ""),
  );

  // Copy WASM if present
  const wasm = join(process.resourcesPath, "emscripten-module.wasm");
  if (existsSync(wasm)) {
    copyFileSync(wasm, join(CLI_BIN_DIR, "emscripten-module.wasm"));
  }

  // Patch shell profiles with PATH
  if (process.platform === "win32") {
    // Add bin dir to the user PATH via registry so new terminals pick it up
    const result = spawn("reg", ["query", "HKCU\\Environment", "/v", "Path"], { stdio: "pipe" });
    let out = "";
    result.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    result.on("close", (code) => {
      // Exit codes: 0 = value exists, 1 = value missing (treat as empty).
      // Anything else (2 = access denied, etc.) is an unexpected failure —
      // bail rather than risk writing a malformed PATH.
      if (code !== 0 && code !== 1) {
        console.warn(`executor: reg query failed (code ${code}), skipping PATH update`);
        return;
      }
      let current = "";
      if (code === 0) {
        const match = out.match(/Path\s+REG(?:_EXPAND)?_SZ\s+(.+)/i);
        if (!match) {
          // reg query succeeded but the output didn't parse — this means the
          // format changed and we can't safely rewrite PATH. Bail.
          console.warn("executor: could not parse reg query output, skipping PATH update");
          return;
        }
        current = match[1].trim();
      }
      if (!current.toLowerCase().includes(CLI_BIN_DIR.toLowerCase())) {
        const updated = current ? `${current};${CLI_BIN_DIR}` : CLI_BIN_DIR;
        spawn("reg", [
          "add",
          "HKCU\\Environment",
          "/v",
          "Path",
          "/t",
          "REG_EXPAND_SZ",
          "/d",
          updated,
          "/f",
        ]);
      }
    });
    return;
  }

  const pathLine = `export PATH="${CLI_BIN_DIR}:$PATH"`;
  const profiles = [
    join(homedir(), ".zshrc"),
    join(homedir(), ".bashrc"),
    join(homedir(), ".bash_profile"),
  ];

  // Fish uses a different syntax
  const fishConfig = join(homedir(), ".config", "fish", "config.fish");
  const fishLine = `fish_add_path "${CLI_BIN_DIR}"`;

  for (const profile of profiles) {
    if (!existsSync(profile)) continue;
    const content = readFileSync(profile, "utf-8");
    if (content.includes(CLI_BIN_DIR)) continue;
    appendFileSync(profile, `\n# Added by Executor desktop app\n${pathLine}\n`);
  }

  if (existsSync(fishConfig)) {
    const content = readFileSync(fishConfig, "utf-8");
    if (!content.includes(CLI_BIN_DIR)) {
      appendFileSync(fishConfig, `\n# Added by Executor desktop app\n${fishLine}\n`);
    }
  }
};

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

interface Settings {
  recentScopes: string[];
  lastScope: string | null;
  windowBounds?: { x: number; y: number; width: number; height: number };
}

const loadSettings = (): Settings => {
  try {
    if (existsSync(SETTINGS_PATH)) {
      return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    }
  } catch {}
  return { recentScopes: [], lastScope: null };
};

const saveSettings = (settings: Settings): void => {
  mkdirSync(SETTINGS_DIR, { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
};

const addRecentScope = (settings: Settings, scopePath: string): void => {
  settings.recentScopes = [
    scopePath,
    ...settings.recentScopes.filter((s) => s !== scopePath),
  ].slice(0, 10);
  settings.lastScope = scopePath;
  saveSettings(settings);
};

// ---------------------------------------------------------------------------
// Server process management
// ---------------------------------------------------------------------------

let serverProcess: ChildProcess | null = null;
let currentScope: string | null = null;
let currentPort = DEFAULT_PORT;

const isDev = !app.isPackaged;

const binaryName = process.platform === "win32" ? "executor.exe" : "executor";

/**
 * Returns { command, args, cwd } for spawning the server.
 * - In dev mode: uses `bun run` with the CLI source
 * - In production: uses the bundled sidecar binary
 */
const resolveServerCommand = (): { command: string; args: string[] } => {
  if (isDev) {
    const cliMain = resolve(__dirname, "../../cli/src/main.ts");
    if (existsSync(cliMain)) {
      return { command: "bun", args: ["run", cliMain] };
    }
    throw new Error("Could not find executor CLI entry point for dev mode");
  }

  // Production: sidecar binary bundled via extraResources
  const sidecar = join(process.resourcesPath, binaryName);
  if (existsSync(sidecar)) {
    return { command: sidecar, args: [] };
  }

  throw new Error(`Sidecar binary not found at ${sidecar}`);
};

const isServerReady = async (port: number): Promise<boolean> => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/docs`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
};

const stopServer = (): Promise<void> => {
  return new Promise((resolve) => {
    if (!serverProcess) {
      resolve();
      return;
    }
    const proc = serverProcess;
    serverProcess = null;

    proc.once("exit", () => resolve());
    proc.kill("SIGTERM");

    // Force kill after 5s
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
      resolve();
    }, 5000);
  });
};

const startServer = async (scopePath: string, port: number): Promise<void> => {
  await stopServer();

  currentScope = scopePath;
  currentPort = port;

  const server = resolveServerCommand();
  const args = [...server.args, "web", "--port", String(port)];

  // In dev mode, run from repo root so bun can resolve workspace deps.
  // In production, the sidecar is self-contained.
  const cwd = isDev ? resolve(__dirname, "../../..") : scopePath;

  serverProcess = spawn(server.command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, EXECUTOR_SCOPE_DIR: scopePath },
  });

  serverProcess.stdout?.on("data", (data: Buffer) => {
    console.log(`[server] ${data.toString().trim()}`);
  });

  serverProcess.stderr?.on("data", (data: Buffer) => {
    console.error(`[server] ${data.toString().trim()}`);
  });

  serverProcess.on("exit", (code) => {
    console.log(`[server] exited with code ${code}`);
    if (serverProcess === null) return; // intentional stop
    serverProcess = null;
    // Server died unexpectedly — quit the app
    app.quit();
  });

  // Wait for server to become ready
  const deadline = Date.now() + SERVER_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isServerReady(port)) return;
    await new Promise((r) => setTimeout(r, 200));
  }

  throw new Error(`Server failed to start within ${SERVER_STARTUP_TIMEOUT_MS / 1000}s`);
};

// ---------------------------------------------------------------------------
// Window management
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let settings = loadSettings();

const createWindow = (): BrowserWindow => {
  const bounds = settings.windowBounds ?? {
    width: 1200,
    height: 800,
  };

  const win = new BrowserWindow({
    ...bounds,
    minWidth: 800,
    minHeight: 600,
    title: "Executor",
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff",
  });

  win.on("close", () => {
    const b = win.getBounds();
    settings.windowBounds = b;
    saveSettings(settings);
  });

  // Open DevTools in development
  if (process.env.NODE_ENV === "development") {
    win.webContents.openDevTools();
  }

  // Log renderer errors to main process console
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[renderer] ${message} (${sourceId}:${line})`);
  });

  // Inject CSS to account for traffic light buttons and enable scrolling
  win.webContents.on("did-finish-load", () => {
    win.webContents.insertCSS(`
      /* Drag region for the titlebar area */
      body::before {
        content: '';
        display: block;
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        height: 38px;
        -webkit-app-region: drag;
        z-index: 9999;
        pointer-events: none;
      }

      /* Make interactive elements inside the titlebar area clickable */
      a, button, input, select, textarea, [role="button"] {
        -webkit-app-region: no-drag;
      }

      /* Push sidebar content below traffic lights */
      aside > :first-child {
        margin-top: 38px !important;
      }

      /* Push main content mobile bar below traffic lights */
      main > :first-child {
        margin-top: 38px !important;
      }
    `);
  });

  return win;
};

const loadScope = async (scopePath: string): Promise<void> => {
  if (!mainWindow) return;

  mainWindow.setTitle(`Executor — ${basename(scopePath)}`);

  if (isDev) {
    // In dev mode, the Vite dev server (via portless) handles both UI and API.
    // Just set the scope env var and load the dev URL.
    currentScope = scopePath;
    process.env.EXECUTOR_SCOPE_DIR = scopePath;
    addRecentScope(settings, scopePath);
    buildMenu();
    mainWindow.loadURL(DEV_SERVER_URL);
    return;
  }

  // Show loading state
  mainWindow.loadURL(`data:text/html,${encodeURIComponent(loadingHTML(scopePath))}`);

  try {
    await startServer(scopePath, currentPort);
    addRecentScope(settings, scopePath);
    buildMenu();
    mainWindow.loadURL(`http://127.0.0.1:${currentPort}`);
  } catch (err) {
    mainWindow.loadURL(`data:text/html,${encodeURIComponent(errorHTML(String(err)))}`);
  }
};

const selectFolder = async (): Promise<void> => {
  if (!mainWindow) return;

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Select Scope Directory",
    message: "Choose a folder to use as the executor scope",
  });

  if (result.canceled || result.filePaths.length === 0) return;

  await loadScope(result.filePaths[0]);
};

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

const buildMenu = (): void => {
  const recentItems: MenuItemConstructorOptions[] = settings.recentScopes.map((scopePath) => ({
    label: `${basename(scopePath)}  —  ${scopePath}`,
    click: () => loadScope(scopePath),
    enabled: scopePath !== currentScope,
  }));

  const template: MenuItemConstructorOptions[] = [
    {
      role: "appMenu",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "Open Scope...",
          accelerator: "CmdOrCtrl+O",
          click: selectFolder,
        },
        { type: "separator" },
        ...(recentItems.length > 0
          ? [
              { label: "Recent Scopes", enabled: false } as MenuItemConstructorOptions,
              ...recentItems,
              { type: "separator" as const },
              {
                label: "Clear Recent",
                click: () => {
                  settings.recentScopes = [];
                  saveSettings(settings);
                  buildMenu();
                },
              } as MenuItemConstructorOptions,
            ]
          : []),
        { type: "separator" },
        { role: "close" as const },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

const setupIPC = (): void => {
  ipcMain.handle("select-scope", async () => {
    await selectFolder();
    return currentScope;
  });

  ipcMain.handle("get-current-scope", () => currentScope);

  ipcMain.handle("get-recent-scopes", () => settings.recentScopes);

  ipcMain.handle("switch-scope", async (_event, scopePath: string) => {
    if (existsSync(scopePath)) {
      await loadScope(scopePath);
    }
    return currentScope;
  });
};

// ---------------------------------------------------------------------------
// HTML templates for loading/error states
// ---------------------------------------------------------------------------

const loadingHTML = (scopePath: string): string => {
  const isDark = nativeTheme.shouldUseDarkColors;
  const bg = isDark ? "#0a0a0a" : "#ffffff";
  const fg = isDark ? "#e5e5e5" : "#171717";
  const muted = isDark ? "rgba(255,255,255,0.3)" : "rgba(0,0,0,0.25)";
  const subtle = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.03)";
  const barColor = isDark ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.4)";
  const barTrack = isDark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.06)";
  const folder = htmlEscape(basename(scopePath.replace(/[/\\]+$/, "")) || scopePath);

  return `<!DOCTYPE html>
<html>
<head>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=Instrument+Serif&display=swap" rel="stylesheet" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: "Inter", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    display: flex; align-items: center; justify-content: center;
    height: 100vh;
    background: ${bg};
    color: ${fg};
    -webkit-app-region: drag;
    overflow: hidden;
  }

  .container {
    display: flex; flex-direction: column; align-items: center;
    animation: fadeUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* Wordmark */
  .wordmark {
    font-family: "Instrument Serif", Georgia, serif;
    font-size: 28px;
    font-weight: 400;
    letter-spacing: -0.01em;
    margin-bottom: 28px;
    opacity: 0.85;
  }

  /* Progress bar */
  .bar-wrap {
    width: 120px;
    height: 2px;
    border-radius: 1px;
    background: ${barTrack};
    overflow: hidden;
    margin-bottom: 24px;
  }

  .bar {
    height: 100%;
    width: 40%;
    border-radius: 1px;
    background: ${barColor};
    animation: slide 1.2s cubic-bezier(0.4, 0, 0.2, 1) infinite;
  }

  @keyframes slide {
    0%   { transform: translateX(-100%); }
    100% { transform: translateX(350%); }
  }

  /* Scope badge */
  .scope {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px 5px 8px;
    border-radius: 6px;
    background: ${subtle};
    font-size: 12px;
    font-weight: 500;
    color: ${muted};
    letter-spacing: 0.01em;
    max-width: 280px;
  }

  .scope svg {
    width: 13px; height: 13px;
    flex-shrink: 0;
    opacity: 0.6;
  }

  .scope span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
</head>
<body>
  <div class="container">
    <div class="wordmark">executor</div>
    <div class="bar-wrap"><div class="bar"></div></div>
    <div class="scope">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
        <path d="M2 4.5C2 3.67 2.67 3 3.5 3h3.09a1 1 0 0 1 .7.29l1.42 1.42a1 1 0 0 0 .7.29H12.5c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4.5z"/>
      </svg>
      <span>${folder}</span>
    </div>
  </div>
</body>
</html>`;
};

const errorHTML = (message: string): string => `<!DOCTYPE html>
<html>
<head>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    display: flex; align-items: center; justify-content: center;
    height: 100vh;
    background: ${nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff"};
    color: ${nativeTheme.shouldUseDarkColors ? "#e5e5e5" : "#171717"};
    -webkit-app-region: drag;
  }
  .container { text-align: center; max-width: 500px; padding: 24px; }
  h2 { font-size: 16px; font-weight: 500; margin-bottom: 12px; color: #ef4444; }
  pre {
    font-size: 12px; background: ${nativeTheme.shouldUseDarkColors ? "#1a1a1a" : "#f5f5f5"};
    padding: 12px; border-radius: 8px; text-align: left;
    overflow-x: auto; white-space: pre-wrap; word-break: break-all;
  }
  button {
    margin-top: 16px; padding: 8px 20px;
    background: ${nativeTheme.shouldUseDarkColors ? "#333" : "#e5e5e5"};
    border: none; border-radius: 6px; cursor: pointer;
    font-size: 13px; color: inherit;
    -webkit-app-region: no-drag;
  }
  button:hover { opacity: 0.8; }
</style>
</head>
<body>
  <div class="container">
    <h2>Failed to start server</h2>
    <pre>${htmlEscape(message)}</pre>
    <button onclick="window.electronAPI.selectScope()">Choose Different Folder</button>
  </div>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Welcome screen
// ---------------------------------------------------------------------------

const welcomeHTML = (): string => {
  const isDark = nativeTheme.shouldUseDarkColors;
  const bg = isDark ? "#0a0a0a" : "#ffffff";
  const fg = isDark ? "#e5e5e5" : "#171717";
  const muted = isDark ? "#666" : "#999";
  const cardBg = isDark ? "#141414" : "#f9f9f9";
  const borderColor = isDark ? "#262626" : "#e5e5e5";

  const recentItems = settings.recentScopes
    .map(
      (s) =>
        `<button class="scope-btn" data-scope="${htmlEscape(s)}">
          <span class="name">${htmlEscape(basename(s))}</span>
          <span class="path">${htmlEscape(s)}</span>
        </button>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    display: flex; align-items: center; justify-content: center;
    height: 100vh; background: ${bg}; color: ${fg};
    -webkit-app-region: drag;
  }
  .container { text-align: center; max-width: 420px; width: 100%; padding: 24px; }
  h1 { font-size: 24px; font-weight: 600; margin-bottom: 6px; }
  .subtitle { font-size: 14px; color: ${muted}; margin-bottom: 32px; }
  .open-btn {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 10px 24px; font-size: 14px; font-weight: 500;
    background: ${fg}; color: ${bg};
    border: none; border-radius: 8px; cursor: pointer;
    -webkit-app-region: no-drag;
  }
  .open-btn:hover { opacity: 0.9; }
  .shortcut { font-size: 12px; color: ${muted}; margin-top: 8px; }
  .recent { margin-top: 32px; text-align: left; }
  .recent-label { font-size: 12px; font-weight: 500; color: ${muted}; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
  .scope-btn {
    display: block; width: 100%; text-align: left;
    padding: 10px 14px; margin-bottom: 4px;
    background: ${cardBg}; border: 1px solid ${borderColor};
    border-radius: 8px; cursor: pointer; color: ${fg};
    -webkit-app-region: no-drag; transition: background 0.1s;
  }
  .scope-btn:hover { background: ${borderColor}; }
  .scope-btn .name { display: block; font-size: 14px; font-weight: 500; }
  .scope-btn .path { display: block; font-size: 12px; color: ${muted}; margin-top: 2px; }
</style>
</head>
<body>
  <div class="container">
    <h1>Executor</h1>
    <p class="subtitle">Select a folder to set as your scope</p>
    <button class="open-btn" onclick="window.electronAPI.selectScope()">
      Open Folder
    </button>
    <p class="shortcut">\u2318O</p>
    ${
      recentItems
        ? `<div class="recent">
            <div class="recent-label">Recent</div>
            ${recentItems}
          </div>`
        : ""
    }
  </div>
  <script>
    for (const button of document.querySelectorAll(".scope-btn")) {
      button.addEventListener("click", () => {
        const scope = button.getAttribute("data-scope");
        if (scope) window.electronAPI.switchScope(scope);
      });
    }
  </script>
</body>
</html>`;
};

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  // Clear cached web content so we always load the latest UI
  await session.defaultSession.clearCache();

  // Install/update CLI binary to ~/.executor/bin
  installCli();

  settings = loadSettings();
  setupIPC();
  buildMenu();

  mainWindow = createWindow();

  // If we have a last scope and it still exists, open it directly
  if (settings.lastScope && existsSync(settings.lastScope)) {
    await loadScope(settings.lastScope);
  } else {
    mainWindow.loadURL(`data:text/html,${encodeURIComponent(welcomeHTML())}`);
  }
});

app.on("window-all-closed", () => {
  // Synchronously kill the server process before quitting
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    serverProcess = null;
  }
  app.quit();
});

app.on("before-quit", () => {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    serverProcess = null;
  }
});

// Last resort: kill server on exit
process.on("exit", () => {
  if (serverProcess) {
    serverProcess.kill("SIGKILL");
    serverProcess = null;
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow();
    mainWindow.loadURL(`data:text/html,${encodeURIComponent(welcomeHTML())}`);
  }
});
