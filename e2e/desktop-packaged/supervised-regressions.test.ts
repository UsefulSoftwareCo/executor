// Packaged desktop supervised-daemon regressions. These run against the real
// electron-builder bundle and its bundled executor because the supervised attach
// path is production-only (`app.isPackaged`).
import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  normalizeExecutorServerConnection,
  serializeExecutorLocalServerManifest,
} from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { RunDir } from "../src/services";
import { waitForHttp } from "../setup/boot";

const execFileAsync = promisify(execFile);
const SERVICE_LABEL = "sh.executor.daemon";

interface PackagedExecutorBridge {
  readonly getSettings: () => Promise<{ readonly port: number }>;
  readonly updateSettings: (patch: { readonly port: number }) => Promise<unknown>;
  readonly restartServer: () => Promise<unknown>;
  readonly getServerConnection: () => Promise<{ readonly origin: string } | null>;
}

interface PackagedApp {
  readonly child: ChildProcess;
  cdp: CdpPage;
  readonly debugPort: string;
  readonly output: () => string;
}

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

class CdpPage {
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
        pending.reject(new Error(message.error.message ?? "CDP command failed"));
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

  static connect = (url: string): Promise<CdpPage> =>
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
          resolve(new CdpPage(socket));
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
    const deadline = Date.now() + timeoutMs;
    const expression = `document.body?.innerText.includes(${JSON.stringify(text)}) ?? false`;
    for (;;) {
      if (await this.evaluate<boolean>(expression).catch(() => false)) return;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for text: ${text}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
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

  textPresent = async (text: string): Promise<boolean> =>
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

  close = (): void => {
    this.socket.close();
  };
}

declare global {
  interface Window {
    readonly executor: PackagedExecutorBridge;
  }
}

const appExe = process.env.E2E_DESKTOP_APP_EXE;
const executorBin = process.env.E2E_DESKTOP_EXECUTOR_BIN;

const guiAvailable = (): boolean => {
  if (process.platform === "darwin") {
    try {
      return execFileSync("launchctl", ["managername"], { encoding: "utf8" }).trim() === "Aqua";
    } catch {
      return false;
    }
  }
  if (process.platform === "linux")
    return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  return true;
};

const packagedSingleInstanceAvailable = (): boolean => {
  if (process.platform !== "darwin" || !appExe) return true;
  try {
    const lines = execFileSync("pgrep", ["-fl", "Executor.app/Contents/MacOS/Executor"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    return !lines.some((line) => !line.includes(appExe));
  } catch {
    return true;
  }
};

const requireBundle = (): { readonly app: string; readonly executor: string } => {
  if (!appExe || !executorBin) {
    throw new Error(
      "E2E_DESKTOP_APP_EXE / E2E_DESKTOP_EXECUTOR_BIN not set — did desktop-packaged.globalsetup run?",
    );
  }
  return { app: appExe, executor: executorBin };
};

const currentUid = (): number => {
  const getuid = (process as { readonly getuid?: () => number }).getuid;
  return typeof getuid === "function" ? getuid.call(process) : 0;
};

const serviceTarget = (): string => `gui/${currentUid()}/${SERVICE_LABEL}`;
const launchAgentPath = (): string =>
  join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
const isolatedDesktopSettingsDir = (home: string): string =>
  join(home, ".executor-desktop-settings");
const desktopSettingsDirs = (home: string): readonly string[] => {
  if (process.platform === "darwin") {
    const support = join(home, "Library", "Application Support");
    return [
      isolatedDesktopSettingsDir(home),
      join(support, "@executor-js", "desktop"),
      join(support, "Executor"),
    ];
  }
  if (process.platform === "linux") {
    return [
      isolatedDesktopSettingsDir(home),
      join(home, ".config", "@executor-js", "desktop"),
      join(home, ".config", "Executor"),
    ];
  }
  const roaming = join(home, "AppData", "Roaming");
  return [
    isolatedDesktopSettingsDir(home),
    join(roaming, "@executor-js", "desktop"),
    join(roaming, "Executor"),
  ];
};

const packagedAppEnv = (home: string): NodeJS.ProcessEnv => {
  return {
    ...process.env,
    HOME: home,
    EXECUTOR_DESKTOP_SETTINGS_DIR: isolatedDesktopSettingsDir(home),
  };
};

interface LaunchdServiceSnapshot {
  readonly plist: string | null;
  readonly wasLoaded: boolean;
}

const launchctl = async (args: ReadonlyArray<string>): Promise<boolean> => {
  try {
    await execFileAsync("launchctl", [...args]);
    return true;
  } catch {
    return false;
  }
};

const captureLaunchdService = (): LaunchdServiceSnapshot | null => {
  if (process.platform !== "darwin") return null;
  const path = launchAgentPath();
  const plist = existsSync(path) ? readFileSync(path, "utf8") : null;
  let wasLoaded = false;
  try {
    execFileSync("launchctl", ["print", serviceTarget()], { stdio: "ignore" });
    wasLoaded = true;
  } catch {
    wasLoaded = false;
  }
  return { plist, wasLoaded };
};

const restoreLaunchdService = async (snapshot: LaunchdServiceSnapshot | null): Promise<void> => {
  if (!snapshot) return;
  const target = serviceTarget();
  await launchctl(["bootout", target]);
  const path = launchAgentPath();
  if (snapshot.plist === null) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, snapshot.plist, { mode: 0o600 });
  chmodSync(path, 0o600);
  await launchctl(["enable", target]);
  if (snapshot.wasLoaded) {
    const bootstrapped = await launchctl(["bootstrap", `gui/${currentUid()}`, path]);
    if (bootstrapped) await launchctl(["kickstart", "-k", target]);
  }
};

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });

interface DaemonStart {
  readonly child: ChildProcess;
  readonly ready: boolean;
  readonly stderr: string;
}

const startSupervisedDaemon = (
  env: NodeJS.ProcessEnv,
  port: number,
  hostname = "127.0.0.1",
): Promise<DaemonStart> =>
  new Promise((resolve) => {
    const { executor } = requireBundle();
    const child = spawn(
      executor,
      ["daemon", "run", "--foreground", "--port", String(port), "--hostname", hostname],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    let settled = false;
    const settle = (ready: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ child, ready, stderr });
    };
    const timer = setTimeout(() => settle(false), 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (/Daemon ready on http:\/\//.test(chunk.toString())) {
        clearTimeout(timer);
        settle(true);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("exit", () => {
      clearTimeout(timer);
      settle(false);
    });
  });

const stopProcess = async (child: ChildProcess | undefined): Promise<void> => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
};

const waitForPageWebSocket = async (debugPort: string): Promise<string> => {
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

const launchPackaged = async (home: string): Promise<PackagedApp> => {
  const { app } = requireBundle();
  let output = "";
  let settled = false;
  const child = spawn(app, ["--remote-debugging-port=0"], {
    env: packagedAppEnv(home),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const browserCdpUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: packaged-app launch promise adapter
      reject(new Error(`Timed out waiting for packaged app CDP URL\n${output}`));
    }, 120_000);
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const collectOutput = (chunk: Buffer) => {
      const text = chunk.toString();
      output = (output + text).slice(-16_384);
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) settle(() => resolve(match[1]));
    };
    child.stdout?.on("data", collectOutput);
    child.stderr?.on("data", collectOutput);
    // oxlint-disable-next-line executor/no-promise-reject -- boundary: packaged-app launch promise adapter
    child.once("error", (error) => settle(() => reject(error)));
    child.once("exit", (code, signal) =>
      settle(() =>
        // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: packaged-app launch promise adapter
        reject(
          new Error(`Packaged app exited before CDP (code=${code} signal=${signal})\n${output}`),
        ),
      ),
    );
  });

  const debugPort = new URL(browserCdpUrl).port;
  const pageCdpUrl = await waitForPageWebSocket(debugPort);
  const cdp = await CdpPage.connect(pageCdpUrl);
  await cdp.command("Runtime.enable");
  await cdp.command("Page.enable");
  return { child, cdp, debugPort, output: () => output };
};

const reconnectPackagedPage = async (app: PackagedApp): Promise<CdpPage> => {
  app.cdp.close();
  const pageCdpUrl = await waitForPageWebSocket(app.debugPort);
  const cdp = await CdpPage.connect(pageCdpUrl);
  await cdp.command("Runtime.enable");
  await cdp.command("Page.enable");
  app.cdp = cdp;
  return cdp;
};

const closePackaged = async (app: PackagedApp | undefined): Promise<void> => {
  app?.cdp.close();
  await stopProcess(app?.child);
};

const waitForServerConnectionLabel = async (
  page: CdpPage,
  expectedText: string,
  timeoutMs: number,
): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  let label = "";
  for (;;) {
    label = await page
      .evaluate<string>(
        `document.querySelector('[aria-label^="Select Executor server:"]')?.getAttribute('aria-label') ?? ""`,
      )
      .catch(() => "");
    if (label.includes(expectedText)) return label;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for server connection label ${expectedText}; last=${label}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

const settingsScrollFrameExpression = `(() => {
  const frames = Array.from(document.querySelectorAll("div"));
  const frame = frames.find((el) => {
    const style = getComputedStyle(el);
    const text = el.textContent ?? "";
    return style.overflowY === "auto" &&
      el.scrollHeight > el.clientHeight &&
      text.includes("Desktop server connection") &&
      text.includes("CLI profile") &&
      text.includes("Bearer token");
  });
  if (!frame) return null;
  return {
    scrollTop: frame.scrollTop,
    scrollHeight: frame.scrollHeight,
    clientHeight: frame.clientHeight,
  };
})()`;

const assertDesktopSettingsScrolls = async (page: CdpPage): Promise<void> => {
  await page.setViewport(900, 420);
  await page.waitForExpression(
    `${settingsScrollFrameExpression} !== null`,
    30_000,
    "the desktop settings scroll frame",
  );
  const before = await page.evaluate<{
    readonly scrollTop: number;
    readonly scrollHeight: number;
    readonly clientHeight: number;
  }>(settingsScrollFrameExpression);
  expect(
    before.scrollHeight,
    "the settings page should have overflow content in a short desktop window",
  ).toBeGreaterThan(before.clientHeight);

  await page.wheel(450, 220, 640);
  await page.waitForExpression(
    `${settingsScrollFrameExpression}?.scrollTop > ${before.scrollTop}`,
    30_000,
    "desktop settings to scroll after a wheel gesture",
  );
  const after = await page.evaluate<{
    readonly scrollTop: number;
    readonly scrollHeight: number;
    readonly clientHeight: number;
  }>(settingsScrollFrameExpression);
  expect(after.scrollTop, "wheel scrolling should move the settings page").toBeGreaterThan(
    before.scrollTop,
  );
};

const openDesktopSettings = async (page: CdpPage): Promise<void> => {
  const clicked = await page.evaluate<boolean>(`(() => {
    const link = document.querySelector('a[href*="desktop-settings"]');
    if (!(link instanceof HTMLAnchorElement)) return false;
    link.click();
    return true;
  })()`);
  expect(clicked, "the packaged desktop app should expose a Settings nav link").toBe(true);
  await page.waitForText("Desktop server connection", 30_000);
};

const writeStaleActiveServerProfile = (input: {
  readonly home: string;
  readonly port: number;
}): void => {
  const staleOrigin = `http://127.0.0.1:${input.port}`;
  const staleKey = `http:${staleOrigin}`;
  const settings = `${JSON.stringify(
    {
      server: { port: input.port },
      serverProfiles: JSON.stringify({
        version: 1,
        activeKey: staleKey,
        profiles: [
          {
            kind: "http",
            origin: staleOrigin,
            displayName: "Stale Basic daemon",
            auth: { kind: "basic", username: "executor", password: "wrong-password" },
          },
        ],
      }),
    },
    null,
    2,
  )}\n`;
  for (const settingsDir of new Set(desktopSettingsDirs(input.home))) {
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(join(settingsDir, "settings.json"), settings, { mode: 0o600 });
  }
};

scenario(
  "Desktop packaged supervised daemon · server manifest is owner-only",
  { timeout: 180_000 },
  Effect.promise(async () => {
    requireBundle();
    const home = mkdtempSync(join(tmpdir(), "executor-pkg-manifest-mode-"));
    const dataDir = join(home, ".executor");
    const manifestPath = join(dataDir, "server-control", "server.json");
    const port = await freePort();
    let daemon: ChildProcess | undefined;
    const previousUmask = process.umask(0o022);
    try {
      const started = await startSupervisedDaemon(
        {
          ...process.env,
          HOME: home,
          EXECUTOR_SUPERVISED: "1",
          EXECUTOR_DATA_DIR: dataDir,
          EXECUTOR_AUTH_TOKEN: "manifest-mode-token",
          EXECUTOR_CLIENT: "desktop",
        },
        port,
      );
      daemon = started.child;
      expect(started.ready, `supervised daemon became ready; stderr:\n${started.stderr}`).toBe(
        true,
      );
      await waitForHttp(`http://127.0.0.1:${port}/`, { timeoutMs: 30_000 });

      const mode = statSync(manifestPath).mode & 0o777;
      expect(
        mode.toString(8).padStart(3, "0"),
        "server.json embeds the bearer and must be owner read/write only",
      ).toBe("600");
    } finally {
      process.umask(previousUmask);
      daemon?.kill("SIGTERM");
      rmSync(home, { recursive: true, force: true });
    }
  }),
);

if (!guiAvailable() || !packagedSingleInstanceAvailable()) {
  it.skip("Desktop packaged supervised attach security (needs a GUI display and no already-running Executor.app)", () => {});
} else {
  scenario(
    "Desktop packaged supervised attach · a slow live daemon does not look crashed",
    { timeout: 240_000 },
    Effect.gen(function* () {
      const runDir = yield* RunDir;
      yield* Effect.promise(() => runSlowLiveDaemonProbe(runDir));
    }),
  );

  scenario(
    "Desktop packaged supervised attach · install failure falls back instead of black-screening",
    { timeout: 300_000 },
    Effect.gen(function* () {
      const runDir = yield* RunDir;
      yield* Effect.promise(() => runInstallFailureFallsBackToManagedSidecar(runDir));
    }),
  );

  scenario(
    "Desktop packaged supervised settings · changing the port moves the active daemon",
    { timeout: 300_000 },
    Effect.gen(function* () {
      const runDir = yield* RunDir;
      yield* Effect.promise(() => runSupervisedPortSetting(runDir));
    }),
  );

  scenario(
    "Desktop packaged supervised attach · integrations load through the CLI daemon with stale profiles",
    { timeout: 240_000 },
    Effect.gen(function* () {
      const runDir = yield* RunDir;
      yield* Effect.promise(() => runSupervisedIntegrationsLoad(runDir));
    }),
  );
}

const writeCliDaemonManifest = (input: {
  readonly controlDir: string;
  readonly dataDir: string;
  readonly origin: string;
  readonly displayName: string;
  readonly token: string;
  readonly ownerVersion?: string | null;
  readonly ownerClient?: "cli" | "desktop";
  readonly ownerExecutablePath?: string | null;
}): void => {
  mkdirSync(input.controlDir, { recursive: true });
  writeFileSync(
    join(input.controlDir, "server.json"),
    serializeExecutorLocalServerManifest({
      version: 1,
      kind: "cli-daemon",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      dataDir: input.dataDir,
      scopeDir: input.dataDir,
      connection: normalizeExecutorServerConnection({
        origin: input.origin,
        displayName: input.displayName,
        auth: { kind: "bearer", token: input.token },
      }),
      owner: {
        client: input.ownerClient ?? "cli",
        version: input.ownerVersion ?? null,
        executablePath: input.ownerExecutablePath ?? null,
      },
    }),
    { mode: 0o600 },
  );
};

const shellSingleQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;

const withFailingBundledInstall = async <T>(run: () => Promise<T>): Promise<T> => {
  const { executor } = requireBundle();
  const original = readFileSync(executor);
  const mode = statSync(executor).mode & 0o777;
  const backup = `${executor}.e2e-real`;
  writeFileSync(backup, original, { mode });
  chmodSync(backup, mode);
  writeFileSync(
    executor,
    [
      "#!/bin/sh",
      'if [ "$1" = "install" ]; then',
      '  echo "launchctl bootstrap failed (exit 5): Bootstrap failed: 5: Input/output error" >&2',
      "  exit 1",
      "fi",
      `exec ${shellSingleQuote(backup)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  try {
    return await run();
  } finally {
    writeFileSync(executor, original, { mode });
    chmodSync(executor, mode);
    rmSync(backup, { force: true });
  }
};

const runInstallFailureFallsBackToManagedSidecar = async (runDir: string) => {
  const home = mkdtempSync(join(tmpdir(), "executor-pkg-install-failure-fallback-"));
  const dataDir = join(home, ".executor");
  const controlDir = join(dataDir, "server-control");
  const token = "install-failure-fallback-token";
  const launchdSnapshot = captureLaunchdService();
  const oldPort = await freePort();
  const requests: Array<{ readonly url: string; readonly authorization: string | null }> = [];
  let resolveHealthProbe!: () => void;
  const sawHealthProbe = new Promise<void>((resolve) => {
    resolveHealthProbe = resolve;
  });
  let app: PackagedApp | undefined;
  let serverOpen = false;

  const server = createServer((req: IncomingMessage, res) => {
    const url = req.url ?? "/";
    requests.push({
      url,
      authorization: req.headers.authorization ?? null,
    });
    if (url.startsWith("/api/health")) {
      res.writeHead(200, {
        "content-type": "text/plain",
        connection: "close",
      });
      res.end("ok", () => {
        resolveHealthProbe();
        void closeServer();
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>Stale Executor</title><body>Stale daemon</body>");
  });
  const closeServer = async (): Promise<void> => {
    if (!serverOpen) return;
    serverOpen = false;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  try {
    await new Promise<void>((resolve) =>
      server.listen(oldPort, "127.0.0.1", () => {
        serverOpen = true;
        resolve();
      }),
    );
    writeCliDaemonManifest({
      controlDir,
      dataDir,
      origin: `http://127.0.0.1:${oldPort}`,
      displayName: "Older daemon that disappears",
      token,
      ownerVersion: "0.0.0",
    });

    await withFailingBundledInstall(async () => {
      app = await launchPackaged(home);
      const page = app.cdp;
      await sawHealthProbe;
      await page.waitForText("Settings", 120_000);
      await page.screenshot(join(runDir, "01-fell-back-to-managed-sidecar.png"));

      const connection = await page.evaluate<{ readonly origin: string } | null>(
        "window.executor.getServerConnection()",
      );
      expect(
        new URL(connection!.origin).port,
        "desktop should not keep rendering from the stale daemon port after install failure",
      ).not.toBe(String(oldPort));
      expect(
        requests
          .filter((request) => request.url.startsWith("/api/health"))
          .map((request) => request.authorization),
        "the stale-daemon health probe must not disclose the saved bearer",
      ).not.toContain(`Bearer ${token}`);
    });
  } finally {
    await closePackaged(app);
    await restoreLaunchdService(launchdSnapshot);
    await closeServer();
    rmSync(home, { recursive: true, force: true });
  }
};

const runSlowLiveDaemonProbe = async (runDir: string) => {
  const home = mkdtempSync(join(tmpdir(), "executor-pkg-slow-live-daemon-"));
  const dataDir = join(home, ".executor");
  const controlDir = join(dataDir, "server-control");
  const manifestPath = join(controlDir, "server.json");
  const token = "slow-live-daemon-token";
  const launchdSnapshot = captureLaunchdService();
  const requests: Array<{ readonly url: string; readonly authorization: string | null }> = [];
  let healthMode: "ok" | "slow" = "ok";
  let slowHealthResponses = 0;
  let resolveThirdSlowHealthResponse!: () => void;
  const thirdSlowHealthResponse = new Promise<void>((resolve) => {
    resolveThirdSlowHealthResponse = resolve;
  });
  const server = createServer((req: IncomingMessage, res) => {
    const url = req.url ?? "/";
    requests.push({
      url,
      authorization: req.headers.authorization ?? null,
    });
    if (url.startsWith("/api/health")) {
      if (healthMode === "slow") {
        setTimeout(() => {
          slowHealthResponses += 1;
          if (slowHealthResponses >= 3) resolveThirdSlowHealthResponse();
          if (res.destroyed || res.writableEnded) return;
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("ok");
        }, 5_000);
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>Executor</title><body><main>Fake Executor UI</main></body>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  let app: PackagedApp | undefined;

  try {
    writeCliDaemonManifest({
      controlDir,
      dataDir,
      origin: `http://127.0.0.1:${port}`,
      displayName: "Slow live daemon",
      token,
    });

    app = await launchPackaged(home);
    const page = app.cdp;
    await page.waitForText("Fake Executor UI", 120_000);
    await page.screenshot(join(runDir, "01-attached-to-fake-daemon.png"));

    const firstHealthProbe = requests.find((request) => request.url.startsWith("/api/health"));
    expect(
      firstHealthProbe?.authorization ?? null,
      "the supervised-daemon health probe must not disclose the saved bearer",
    ).toBeNull();

    healthMode = "slow";
    const sawSlowMonitorProbe = await Promise.race([
      thirdSlowHealthResponse.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 60_000)),
    ]);
    expect(
      sawSlowMonitorProbe,
      "the packaged app should continue probing the supervised daemon after initial attach",
    ).toBe(true);

    expect(
      requests
        .filter((request) => request.url.startsWith("/api/health"))
        .map((request) => request.authorization),
      "supervised-daemon health probes must never carry the saved bearer",
    ).not.toContain(`Bearer ${token}`);
    expect(
      existsSync(manifestPath),
      "a live daemon's manifest must survive transient health probe failures",
    ).toBe(true);
    expect(
      await page.textPresent("The local Executor server stopped unexpectedly"),
      "one slow monitor probe should not show the crash screen",
    ).toBe(false);
    expect(
      await page.textPresent("Fake Executor UI"),
      "the original renderer should stay loaded",
    ).toBe(true);
    await page.screenshot(join(runDir, "02-still-rendering-after-slow-health.png"));
  } finally {
    await closePackaged(app);
    await restoreLaunchdService(launchdSnapshot);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
};

const runSupervisedPortSetting = async (runDir: string) => {
  const home = mkdtempSync(join(tmpdir(), "executor-pkg-port-setting-"));
  const dataDir = join(home, ".executor");
  const launchdSnapshot = captureLaunchdService();
  const oldPort = await freePort();
  const newPort = await freePort();
  let daemon: ChildProcess | undefined;
  let app: PackagedApp | undefined;

  try {
    const started = await startSupervisedDaemon(
      {
        ...process.env,
        HOME: home,
        EXECUTOR_SUPERVISED: "1",
        EXECUTOR_DATA_DIR: dataDir,
        EXECUTOR_AUTH_TOKEN: "port-setting-token",
        EXECUTOR_CLIENT: "desktop",
      },
      oldPort,
    );
    daemon = started.child;
    expect(started.ready, `supervised daemon became ready; stderr:\n${started.stderr}`).toBe(true);
    await waitForHttp(`http://127.0.0.1:${oldPort}/`, { timeoutMs: 30_000 });

    app = await launchPackaged(home);
    let page = app.cdp;
    await page.waitForText("Settings", 120_000);
    await openDesktopSettings(page);
    await assertDesktopSettingsScrolls(page);
    await page.screenshot(join(runDir, "01-attached-settings.png"));

    const before = await page.evaluate<{ readonly origin: string } | null>(
      "window.executor.getServerConnection()",
    );
    expect(new URL(before!.origin).port, "test starts attached to the original port").toBe(
      String(oldPort),
    );

    await page.evaluate(`window.executor.updateSettings({ port: ${JSON.stringify(newPort)} })`);

    await page
      .evaluate("window.executor.restartServer().catch(() => undefined)")
      .catch(() => undefined);
    page = await reconnectPackagedPage(app);
    await page.waitForText("Settings", 120_000);

    const after = await page.evaluate<{
      readonly settings: { readonly port: number };
      readonly connection: { readonly origin: string } | null;
    }>(
      "(async () => ({ settings: await window.executor.getSettings(), connection: await window.executor.getServerConnection() }))()",
    );

    expect(after.settings.port, "the setting was persisted").toBe(newPort);
    expect(
      new URL(after.connection!.origin).port,
      "after restart, the active supervised daemon should be serving on the saved port",
    ).toBe(String(newPort));
    await page.screenshot(join(runDir, "02-restarted-on-new-port.png"));
  } finally {
    await closePackaged(app);
    await stopProcess(daemon);
    await restoreLaunchdService(launchdSnapshot);
    rmSync(home, { recursive: true, force: true });
  }
};

const runSupervisedIntegrationsLoad = async (runDir: string) => {
  const home = mkdtempSync(join(tmpdir(), "executor-pkg-integrations-load-"));
  const dataDir = join(home, ".executor");
  const launchdSnapshot = captureLaunchdService();
  const port = await freePort();
  let daemon: ChildProcess | undefined;
  let app: PackagedApp | undefined;

  try {
    writeStaleActiveServerProfile({ home, port });
    const started = await startSupervisedDaemon(
      {
        ...process.env,
        HOME: home,
        EXECUTOR_SUPERVISED: "1",
        EXECUTOR_DATA_DIR: dataDir,
        EXECUTOR_AUTH_TOKEN: "integrations-load-token",
        EXECUTOR_CLIENT: "desktop",
      },
      port,
      "localhost",
    );
    daemon = started.child;
    expect(started.ready, `supervised daemon became ready; stderr:\n${started.stderr}`).toBe(true);
    await waitForHttp(`http://localhost:${port}/`, { timeoutMs: 30_000 });

    const rootDocument = await fetch(`http://localhost:${port}/`);
    expect(
      rootDocument.headers.get("cache-control"),
      "SPA boot document should not be cached",
    ).toBe("no-store");
    await rootDocument.body?.cancel();
    const indexDocument = await fetch(`http://localhost:${port}/index.html`);
    expect(
      indexDocument.headers.get("cache-control"),
      "direct index.html requests should not cache the SPA boot document",
    ).toBe("no-store");
    await indexDocument.body?.cancel();

    app = await launchPackaged(home);
    const page = app.cdp;

    const serverLabel = await waitForServerConnectionLabel(page, "Local Executor", 120_000);
    expect(serverLabel, "desktop must not auto-select a stale persisted server profile").toContain(
      "Local Executor",
    );
    await page.waitForExpression(
      `document.querySelector('a[href$="/integrations/executor"]') !== null`,
      120_000,
      "the built-in Executor integration link",
    );
    const bootstrap = await page.evaluate<{
      readonly href: string;
      readonly navigationName: string;
    }>(
      `(() => {
        const navigation = performance.getEntriesByType("navigation")[0];
        return {
          href: location.href,
          navigationName: navigation?.name ?? "",
        };
      })()`,
    );
    expect(
      bootstrap.navigationName,
      "desktop should cache-bust each packaged renderer document load",
    ).toContain("_executor_desktop_launch=");
    expect(
      bootstrap.navigationName,
      "desktop should pass the daemon token during bootstrap",
    ).toContain("_token=");
    expect(
      bootstrap.href,
      "desktop should strip bootstrap cache-bust params after load",
    ).not.toContain("_executor_desktop_launch=");
    expect(bootstrap.href, "desktop should strip bootstrap token params after load").not.toContain(
      "_token=",
    );
    await page.screenshot(join(runDir, "01-integrations-loaded.png"));
    expect(
      await page.textPresent("Failed to load integrations").then((present) => (present ? 1 : 0)),
      "integrations should render from the attached daemon, not a cached 401/500 failure",
    ).toBe(0);

    const connection = await page.evaluate<{ readonly origin: string } | null>(
      "window.executor.getServerConnection()",
    );
    expect(
      new URL(connection!.origin).port,
      "the packaged app is rendering data from the supervised daemon",
    ).toBe(String(port));
  } finally {
    await closePackaged(app);
    await stopProcess(daemon);
    await restoreLaunchdService(launchdSnapshot);
    rmSync(home, { recursive: true, force: true });
  }
};
