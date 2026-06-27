import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUTPUT_LIMIT = 64 * 1024;

const appendOutput = (current: string, chunk: Buffer) =>
  (current + chunk.toString()).slice(-OUTPUT_LIMIT);

const envFlagEnabled = (value: string | undefined) =>
  value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";

const PACKAGED_DESKTOP_RUNTIME_ENV_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
  "XDG_CURRENT_DESKTOP",
  "DESKTOP_SESSION",
  "DBUS_SESSION_BUS_ADDRESS",
  "GDK_BACKEND",
  "GTK_MODULES",
  "NO_AT_BRIDGE",
  "LIBGL_ALWAYS_SOFTWARE",
  "LIBGL_DRIVERS_PATH",
  "MESA_LOADER_DRIVER_OVERRIDE",
  "GBM_BACKEND",
  "VK_ICD_FILENAMES",
  "LD_LIBRARY_PATH",
  "DYLD_LIBRARY_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "CHROME_DEVEL_SANDBOX",
  "ELECTRON_ENABLE_LOGGING",
  "ELECTRON_OZONE_PLATFORM_HINT",
  "OZONE_PLATFORM",
  "DO_NOT_TRACK",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "ComSpec",
  "COMSPEC",
  "SystemDrive",
  "SYSTEMDRIVE",
  "ProgramData",
  "PROGRAMDATA",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "SESSIONNAME",
] as const;

export const selectPackagedDesktopRuntimeEnvironment = (environment: NodeJS.ProcessEnv) => {
  const selected: NodeJS.ProcessEnv = {};
  for (const key of PACKAGED_DESKTOP_RUNTIME_ENV_KEYS) {
    const value = environment[key];
    if (value !== undefined) selected[key] = value;
  }
  return selected;
};

export interface PackagedDesktopBundle {
  readonly app: string;
  readonly executor: string;
}

export const requirePackagedDesktopBundle = (): PackagedDesktopBundle => {
  const app = process.env.E2E_DESKTOP_APP_EXE;
  const executor = process.env.E2E_DESKTOP_EXECUTOR_BIN;
  if (!app || !executor) {
    throw new Error(
      "E2E_DESKTOP_APP_EXE / E2E_DESKTOP_EXECUTOR_BIN not set, did desktop-packaged.globalsetup run?",
    );
  }
  return { app, executor };
};

export const createPackagedDesktopHome = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

export const removePackagedDesktopHome = (home: string) =>
  rmSync(home, { recursive: true, force: true });

export const packagedDesktopSettingsDir = (home: string) =>
  join(home, ".executor-desktop-settings");

export const packagedDesktopEnvironment = (
  home: string,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv => {
  const inheritedRuntime = selectPackagedDesktopRuntimeEnvironment(process.env);
  const appData = join(home, "AppData", "Roaming");
  const localAppData = join(home, "AppData", "Local");
  const xdgConfig = join(home, ".config");
  const xdgData = join(home, ".local", "share");
  const xdgCache = join(home, ".cache");
  const xdgState = join(home, ".local", "state");
  const isolatedXdgRuntime = join(home, ".xdg-runtime");
  const xdgRuntime =
    inheritedRuntime.WAYLAND_DISPLAY && inheritedRuntime.XDG_RUNTIME_DIR
      ? inheritedRuntime.XDG_RUNTIME_DIR
      : isolatedXdgRuntime;
  const temp = join(home, ".tmp");
  const settings = packagedDesktopSettingsDir(home);

  for (const directory of [
    home,
    appData,
    localAppData,
    xdgConfig,
    xdgData,
    xdgCache,
    xdgState,
    temp,
    settings,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  if (xdgRuntime === isolatedXdgRuntime) {
    mkdirSync(xdgRuntime, { recursive: true, mode: 0o700 });
    chmodSync(xdgRuntime, 0o700);
  }

  return {
    ...inheritedRuntime,
    ...overrides,
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_CACHE_HOME: xdgCache,
    XDG_STATE_HOME: xdgState,
    XDG_RUNTIME_DIR: xdgRuntime,
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    EXECUTOR_DESKTOP_SETTINGS_DIR: settings,
  };
};

const windowsGuiAvailable = () => {
  // A Windows service runs in session zero, where Electron cannot create a user-visible window.
  // Checking the actual process session avoids treating every Windows runner as interactive.
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: probing the Windows session manager; absence means no GUI
  try {
    const sessionId = Number.parseInt(
      execFileSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[System.Diagnostics.Process]::GetCurrentProcess().SessionId",
        ],
        { encoding: "utf8", windowsHide: true },
      ).trim(),
      10,
    );
    return (
      Number.isInteger(sessionId) &&
      sessionId > 0 &&
      process.env.SESSIONNAME?.toLowerCase() !== "services"
    );
  } catch {
    return false;
  }
};

const guiAvailable = () => {
  if (process.platform === "darwin") {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: probing the session manager; absence means no GUI
    try {
      return execFileSync("launchctl", ["managername"], { encoding: "utf8" }).trim() === "Aqua";
    } catch {
      return false;
    }
  }
  if (process.platform === "linux") {
    return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  }
  if (process.platform === "win32") return windowsGuiAvailable();
  return false;
};

const packagedSingleInstanceAvailable = () => {
  const app = process.env.E2E_DESKTOP_APP_EXE;
  if (process.platform !== "darwin" || !app) return true;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: pgrep reports no match with a nonzero exit code
  try {
    const lines = execFileSync("pgrep", ["-fl", "Executor.app/Contents/MacOS/Executor"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    return !lines.some((line) => !line.includes(app));
  } catch {
    return true;
  }
};

export type PackagedDesktopPreflight =
  | { readonly status: "ready" }
  | { readonly status: "skip" | "fail"; readonly reason: string };

export const packagedDesktopPreflight = (): PackagedDesktopPreflight => {
  const capabilityMode = process.env.E2E_REQUIRED_CAPABILITY_MODE;
  const required =
    capabilityMode === "required" ||
    envFlagEnabled(process.env.E2E_DESKTOP_GUI_REQUIRED) ||
    (envFlagEnabled(process.env.CI) && capabilityMode !== "allow-skips");
  const reason = !guiAvailable()
    ? `no interactive GUI session is available on ${process.platform}`
    : !packagedSingleInstanceAvailable()
      ? "another packaged Executor.app instance already owns the single-instance lock"
      : null;
  if (!reason) return { status: "ready" };
  return { status: required ? "fail" : "skip", reason };
};

interface CdpResponse<T> {
  readonly id: number;
  readonly result?: T;
  readonly error?: { readonly message?: string; readonly data?: string };
}

interface CdpEvaluateResult {
  readonly result: { readonly value?: unknown };
  readonly exceptionDetails?: unknown;
}

interface CdpTarget {
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl?: string;
}

export class PackagedDesktopPage {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
    }
  >();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const data = event.data;
      if (typeof data !== "string") return;
      const message = JSON.parse(data) as CdpResponse<unknown>;
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(
            [message.error.message ?? "CDP command failed", message.error.data]
              .filter(Boolean)
              .join("\n"),
          ),
        );
        return;
      }
      pending.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const [, pending] of this.pending) {
        pending.reject(new Error("CDP socket closed"));
      }
      this.pending.clear();
    });
  }

  static connect = (url: string): Promise<PackagedDesktopPage> =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: WebSocket connection promise adapter
        reject(new Error(`Timed out connecting to page CDP target ${url}`));
      }, 30_000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve(new PackagedDesktopPage(socket));
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: WebSocket connection promise adapter
          reject(new Error(`Failed to connect to page CDP target ${url}`));
        },
        { once: true },
      );
    });

  command = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    const id = this.nextId;
    this.nextId += 1;
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  };

  evaluate = async <T>(expression: string): Promise<T> => {
    const result = await this.command<CdpEvaluateResult>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`CDP evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result.value as T;
  };

  waitForText = async (text: string, timeoutMs: number): Promise<void> => {
    const expression = `document.body?.innerText.includes(${JSON.stringify(text)}) ?? false`;
    await this.waitForExpression(expression, timeoutMs, `text: ${text}`);
  };

  waitForExpression = async (
    expression: string,
    timeoutMs: number,
    description: string,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await this.evaluate<boolean>(`Boolean(${expression})`).catch(() => false)) return;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };

  textPresent = (text: string) =>
    this.evaluate<boolean>(`document.body?.innerText.includes(${JSON.stringify(text)}) ?? false`);

  setViewport = async (width: number, height: number): Promise<void> => {
    await this.command("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  };

  wheel = async (x: number, y: number, deltaY: number): Promise<void> => {
    await this.command("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX: 0,
      deltaY,
    });
  };

  screenshot = async (path: string): Promise<void> => {
    const result = await this.command<{ readonly data: string }>("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });
    writeFileSync(path, Buffer.from(result.data, "base64"));
  };

  close = () => this.socket.close();
}

export interface PackagedDesktopEvidenceCapture {
  readonly rendererPath: string;
  readonly osPixelPath?: string;
}

export interface PackagedDesktopEvidenceHooks {
  readonly beforeCapture?: (
    capture: PackagedDesktopEvidenceCapture,
    app: PackagedDesktopApp,
  ) => Promise<void> | void;
  readonly captureOsPixels?: (path: string, app: PackagedDesktopApp) => Promise<void>;
  readonly afterCapture?: (
    capture: PackagedDesktopEvidenceCapture,
    app: PackagedDesktopApp,
  ) => Promise<void> | void;
}

export interface PackagedDesktopLaunchOptions {
  readonly home: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly evidence?: PackagedDesktopEvidenceHooks;
}

export interface PackagedDesktopApp {
  readonly child: ChildProcess;
  readonly debugPort: string;
  cdp: PackagedDesktopPage;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly output: () => string;
  readonly captureEvidence: (capture: PackagedDesktopEvidenceCapture) => Promise<void>;
  readonly close: () => Promise<void>;
}

const waitForPageWebSocket = async (debugPort: string) => {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const targets = (await fetch(`http://127.0.0.1:${debugPort}/json/list`)
      .then((response) => (response.ok ? response.json() : []))
      .catch(() => [])) as ReadonlyArray<CdpTarget>;
    const page = targets.find(
      (target) =>
        target.type === "page" &&
        target.webSocketDebuggerUrl &&
        !target.url.startsWith("devtools://"),
    );
    if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for packaged app page CDP target");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

export const stopProcess = async (child: ChildProcess | undefined): Promise<void> => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const forceStop = () => {
      if (process.platform === "win32" && child.pid) {
        execFile(
          "taskkill",
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true },
          settle,
        );
      } else {
        child.kill("SIGKILL");
        setTimeout(settle, 1_000);
      }
    };
    const timeout = setTimeout(forceStop, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      settle();
    });
    if (process.platform === "win32" && child.pid) {
      execFile("taskkill", ["/PID", String(child.pid), "/T"], { windowsHide: true }, () => {});
    } else {
      child.kill("SIGTERM");
    }
  });
};

export const closePackagedDesktop = async (app: PackagedDesktopApp | undefined) => {
  if (!app) return;
  app.cdp.close();
  await stopProcess(app.child);
};

export const launchPackagedDesktop = async (
  options: PackagedDesktopLaunchOptions,
): Promise<PackagedDesktopApp> => {
  const { app: executable } = requirePackagedDesktopBundle();
  const evidence = options.evidence ?? {};
  let stdout = "";
  let stderr = "";
  let settled = false;
  const child = spawn(executable, ["--remote-debugging-port=0", ...(options.args ?? [])], {
    env: packagedDesktopEnvironment(options.home, options.env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout = appendOutput(stdout, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = appendOutput(stderr, chunk);
  });
  const output = () => [stdout, stderr].filter(Boolean).join("\n");

  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: a failed launch must reap the Electron process
  try {
    const browserCdpUrl = await new Promise<string>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      timer = setTimeout(
        () =>
          settle(() => {
            // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: packaged-app launch promise adapter
            reject(new Error(`Timed out waiting for packaged app CDP URL\n${output()}`));
          }),
        120_000,
      );
      const detectCdpUrl = () => {
        const match = output().match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) settle(() => resolve(match[1]!));
      };
      child.stdout?.on("data", detectCdpUrl);
      child.stderr?.on("data", detectCdpUrl);
      // oxlint-disable-next-line executor/no-promise-reject -- boundary: packaged-app launch promise adapter
      child.once("error", (error) => settle(() => reject(error)));
      child.once("exit", (code, signal) =>
        settle(() =>
          // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: packaged-app launch promise adapter
          reject(
            new Error(
              `Packaged app exited before CDP (code=${code} signal=${signal})\n${output()}`,
            ),
          ),
        ),
      );
    });

    const debugPort = new URL(browserCdpUrl).port;
    const pageCdpUrl = await waitForPageWebSocket(debugPort);
    const cdp = await PackagedDesktopPage.connect(pageCdpUrl);
    await cdp.command("Runtime.enable");
    await cdp.command("Page.enable");

    const packagedApp: PackagedDesktopApp = {
      child,
      cdp,
      debugPort,
      stdout: () => stdout,
      stderr: () => stderr,
      output,
      captureEvidence: async (capture) => {
        await evidence.beforeCapture?.(capture, packagedApp);
        await packagedApp.cdp.screenshot(capture.rendererPath);
        if (capture.osPixelPath) {
          if (!evidence.captureOsPixels) {
            throw new Error("OS-pixel evidence was requested without a captureOsPixels hook");
          }
          await evidence.captureOsPixels(capture.osPixelPath, packagedApp);
        }
        await evidence.afterCapture?.(capture, packagedApp);
      },
      close: () => closePackagedDesktop(packagedApp),
    };
    return packagedApp;
  } catch (error) {
    await stopProcess(child);
    throw error;
  }
};

export const reconnectPackagedDesktopPage = async (app: PackagedDesktopApp) => {
  app.cdp.close();
  const pageCdpUrl = await waitForPageWebSocket(app.debugPort);
  const cdp = await PackagedDesktopPage.connect(pageCdpUrl);
  await cdp.command("Runtime.enable");
  await cdp.command("Page.enable");
  app.cdp = cdp;
  return cdp;
};

export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });

export interface SupervisedDaemonStart {
  readonly child: ChildProcess;
  readonly ready: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export const startSupervisedDaemon = (options: {
  readonly home: string;
  readonly port: number;
  readonly hostname?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<SupervisedDaemonStart> =>
  new Promise((resolve) => {
    const { executor } = requirePackagedDesktopBundle();
    const child = spawn(
      executor,
      [
        "daemon",
        "run",
        "--foreground",
        "--port",
        String(options.port),
        "--hostname",
        options.hostname ?? "127.0.0.1",
      ],
      {
        env: packagedDesktopEnvironment(options.home, options.env),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (ready: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ child, ready, stdout, stderr });
    };
    const timer = setTimeout(() => settle(false), 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk);
      if (/Daemon ready on http:\/\//.test(chunk.toString())) {
        clearTimeout(timer);
        settle(true);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      stderr = appendOutput(stderr, Buffer.from(error.message));
      settle(false);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      settle(false);
    });
  });
