/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor, executor/no-promise-reject -- e2e boundary: drives launchd, a packaged Electron process, CDP, and optional ffmpeg recording */
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
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { RunDir } from "../src/services";

const execFileAsync = promisify(execFile);
const SERVICE_LABEL = "sh.executor.daemon";
const SCENARIO_NAME =
  "Desktop packaged supervised attach: stale launchd registration self-heals without a dead boot wait";
const RECORDING_FILE = resolve("recordings/stale-launchd-fast-boot.mp4");
const RECORDING_WIDTH = 1280;
const RECORDING_HEIGHT = 720;
const STALE_PLIST_PORT = 58_251;

interface PackagedExecutorBridge {
  readonly getServerConnection: () => Promise<{
    readonly kind: string;
    readonly origin: string;
  } | null>;
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

interface ServerManifest {
  readonly kind: string;
  readonly pid: number;
}

interface LaunchTiming {
  readonly app: PackagedApp;
  readonly pageCdpMs: number;
}

interface BootResult {
  readonly pageCdpMs: number;
  readonly startupWindowMs: number;
  readonly sidecarReadyMs: number;
  readonly connectionKind: string;
  readonly origin: string;
  readonly manifestKind: string;
  readonly manifestPid: number;
  readonly kickstartFailureLine: string | null;
  readonly recoveryLogLine: string | null;
  readonly launchdPrintSucceeded: boolean;
}

declare global {
  interface Window {
    readonly executor: PackagedExecutorBridge;
  }
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
    new Promise((resolveConnect, rejectConnect) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        rejectConnect(new Error(`Timed out connecting to page CDP target ${url}`));
      }, 30_000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolveConnect(new CdpPage(socket));
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          rejectConnect(new Error(`Failed to connect to page CDP target ${url}`));
        },
        { once: true },
      );
    });

  command = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    const id = this.nextId;
    this.nextId += 1;
    const result = new Promise<T>((resolveCommand, rejectCommand) => {
      this.pending.set(id, {
        resolve: (value) => resolveCommand(value as T),
        reject: rejectCommand,
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
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  };

  setViewport = async (width: number, height: number): Promise<void> => {
    await this.command("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
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

const appExe = process.env.E2E_DESKTOP_APP_EXE;
const executorBin = process.env.E2E_DESKTOP_EXECUTOR_BIN;

const macAquaAvailable = (): boolean => {
  if (process.platform !== "darwin") return false;
  try {
    return execFileSync("launchctl", ["managername"], { encoding: "utf8" }).trim() === "Aqua";
  } catch {
    return false;
  }
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
      "E2E_DESKTOP_APP_EXE / E2E_DESKTOP_EXECUTOR_BIN not set, did desktop-packaged.globalsetup run?",
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

const packagedAppEnv = (home: string): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: home,
  EXECUTOR_DESKTOP_SETTINGS_DIR: isolatedDesktopSettingsDir(home),
});

const cleanBootEnv = (home: string): NodeJS.ProcessEnv => ({
  ...packagedAppEnv(home),
  EXECUTOR_TEST_SKIP_BACKGROUND_SERVICE: "1",
  EXECUTOR_TEST_AUTO_CONFIRM_BACKGROUND_SERVICE: "0",
});

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

const launchctlPrintService = async (): Promise<string | null> => {
  try {
    const { stdout, stderr } = await execFileAsync("launchctl", ["print", serviceTarget()], {
      encoding: "utf8",
    });
    return `${stdout}${stderr}`.trim();
  } catch {
    return null;
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
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
};

const launchPackaged = async (
  env: NodeJS.ProcessEnv,
  recorder: BootRecorder | null,
): Promise<LaunchTiming> => {
  const { app } = requireBundle();
  const startedAt = Date.now();
  let output = "";
  let settled = false;
  const child = spawn(app, ["--remote-debugging-port=0"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  recorder?.start(startedAt);

  try {
    const browserCdpUrl = await new Promise<string>((resolveLaunch, rejectLaunch) => {
      const timer = setTimeout(() => {
        rejectLaunch(new Error(`Timed out waiting for packaged app CDP URL\n${output}`));
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
        if (match) settle(() => resolveLaunch(match[1]));
      };
      child.stdout?.on("data", collectOutput);
      child.stderr?.on("data", collectOutput);
      child.once("error", (error) => settle(() => rejectLaunch(error)));
      child.once("exit", (code, signal) =>
        settle(() =>
          rejectLaunch(
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
    await cdp.setViewport(RECORDING_WIDTH, RECORDING_HEIGHT);
    recorder?.attachPage(cdp);
    return {
      app: { child, cdp, debugPort, output: () => output },
      pageCdpMs: Date.now() - startedAt,
    };
  } catch (error) {
    await stopProcess(child);
    throw error;
  }
};

const stopProcess = async (child: ChildProcess | undefined): Promise<void> => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveStop) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolveStop();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveStop();
    });
    child.kill("SIGTERM");
  });
};

const closePackaged = async (app: PackagedApp | undefined): Promise<void> => {
  app?.cdp.close();
  await stopProcess(app?.child);
};

const xmlEscape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll(">", "&gt;")
    .replaceAll("<", "&lt;");

const writeStaleLaunchAgentPlist = (home: string): void => {
  const { executor } = requireBundle();
  const dataDir = join(home, ".executor");
  const logs = join(dataDir, "logs");
  const plistDir = join(home, "Library", "LaunchAgents");
  mkdirSync(plistDir, { recursive: true });
  mkdirSync(logs, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const programArguments = [
    executor,
    "daemon",
    "run",
    "--foreground",
    "--port",
    String(STALE_PLIST_PORT),
    "--hostname",
    "127.0.0.1",
  ];
  const programArgs = programArguments
    .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
    .join("\n");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>EXECUTOR_SUPERVISED</key>
    <string>1</string>
    <key>EXECUTOR_DATA_DIR</key>
    <string>${xmlEscape(dataDir)}</string>
    <key>EXECUTOR_SCOPE_DIR</key>
    <string>${xmlEscape(dataDir)}</string>
    <key>EXECUTOR_CLIENT</key>
    <string>desktop</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(dataDir)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(logs, "daemon.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(logs, "daemon.error.log"))}</string>
</dict>
</plist>
`;
  writeFileSync(join(plistDir, `${SERVICE_LABEL}.plist`), plist, { mode: 0o600 });
};

const readServerManifest = (home: string): ServerManifest => {
  const manifestPath = join(home, ".executor", "server-control", "server.json");
  return JSON.parse(readFileSync(manifestPath, "utf8")) as ServerManifest;
};

interface StaleRecoveryLog {
  readonly kickstartFailureLine: string | null;
  readonly recoveryLogLine: string | null;
}

// The desktop's own classification line for a stale registration; electron-log
// appends the launchctl error on the same line. Production launchctl fails the
// kickstart with exit 113 ("Could not find service"); a tart guest's
// `launchctl asuser` session fails it with exit 125 ("Domain does not support
// specified action"). Same stale state, same self-heal branch, so match the
// kickstart failure without pinning the environment-specific exit code.
const isKickstartFailureLine = (line: string): boolean =>
  line.includes("Failed to restart registered supervised service; reinstalling") &&
  line.includes("launchctl kickstart failed");

const isRecoveryLogLine = (line: string): boolean =>
  line.includes("installed supervised service via bundled executor") ||
  line.includes("Failed to install supervised service after registered service restart failure") ||
  line.includes("using managed sidecar");

const readStaleRecoveryLog = (home: string): StaleRecoveryLog => {
  const logPath = join(home, "Library", "Logs", "Executor", "main.log");
  if (!existsSync(logPath)) return { kickstartFailureLine: null, recoveryLogLine: null };
  const lines = readFileSync(logPath, "utf8").split("\n");
  const kickstartIndex = lines.findIndex(isKickstartFailureLine);
  if (kickstartIndex < 0) return { kickstartFailureLine: null, recoveryLogLine: null };
  const recoveryLogLine =
    lines.slice(kickstartIndex + 1).find((line) => isRecoveryLogLine(line)) ?? null;
  return {
    kickstartFailureLine: lines[kickstartIndex] ?? null,
    recoveryLogLine,
  };
};

const waitForStaleRecoveryLog = async (home: string): Promise<StaleRecoveryLog> => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const lines = readStaleRecoveryLog(home);
    if (lines.kickstartFailureLine && lines.recoveryLogLine) return lines;
    if (Date.now() >= deadline) {
      const logPath = join(home, "Library", "Logs", "Executor", "main.log");
      const tail = existsSync(logPath)
        ? readFileSync(logPath, "utf8").split("\n").slice(-20).join("\n")
        : "<main.log missing>";
      throw new Error(`Timed out waiting for stale launchd recovery log lines\n${tail}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
};

const bootPackagedApp = async (input: {
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly recorder: BootRecorder | null;
  readonly expectStartupWindow: boolean;
  readonly expectStaleRecoveryLog: boolean;
}): Promise<BootResult> => {
  let app: PackagedApp | undefined;
  const startedAt = Date.now();
  try {
    const launched = await launchPackaged(input.env, input.recorder);
    app = launched.app;
    const page = app.cdp;
    const startupWindowVisible = await page
      .waitForText("Starting Executor", 5_000)
      .then(() => true)
      .catch(() => false);
    const startupWindowMs = startupWindowVisible ? Date.now() - startedAt : launched.pageCdpMs;
    expect(
      !input.expectStartupWindow || startupWindowVisible,
      "startup window shows before service recovery finishes when required",
    ).toBe(true);
    await page.waitForText("Settings", 120_000);
    const sidecarReadyMs = Date.now() - startedAt;
    await input.recorder?.captureReadyFrame();
    await input.recorder?.captureReadyFrame();
    const connection = await page.evaluate<{
      readonly kind: string;
      readonly origin: string;
    } | null>("window.executor.getServerConnection()");
    expect(connection, "the app eventually exposes a server connection").not.toBeNull();
    const manifest = readServerManifest(input.home);
    const recoveryLog = input.expectStaleRecoveryLog
      ? await waitForStaleRecoveryLog(input.home)
      : readStaleRecoveryLog(input.home);
    const launchdPrintSucceeded = (await launchctlPrintService()) !== null;
    return {
      pageCdpMs: launched.pageCdpMs,
      startupWindowMs,
      sidecarReadyMs,
      connectionKind: connection!.kind,
      origin: connection!.origin,
      manifestKind: manifest.kind,
      manifestPid: manifest.pid,
      kickstartFailureLine: recoveryLog.kickstartFailureLine,
      recoveryLogLine: recoveryLog.recoveryLogLine,
      launchdPrintSucceeded,
    };
  } finally {
    await input.recorder?.stop();
    await closePackaged(app);
  }
};

const commandAvailable = (command: string): boolean => {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const emitEvidence = (line: string): void => {
  execFileSync("printf", ["%s\n", line], { stdio: "inherit" });
};

const FONT: Record<string, readonly string[]> = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  "0": ["11110", "10010", "10010", "10010", "10010", "10010", "11110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["11110", "00010", "00010", "11110", "10000", "10000", "11110"],
  "3": ["11110", "00010", "00010", "01110", "00010", "00010", "11110"],
  "4": ["10010", "10010", "10010", "11110", "00010", "00010", "00010"],
  "5": ["11110", "10000", "10000", "11110", "00010", "00010", "11110"],
  "6": ["11110", "10000", "10000", "11110", "10010", "10010", "11110"],
  "7": ["11110", "00010", "00010", "00100", "00100", "01000", "01000"],
  "8": ["11110", "10010", "10010", "11110", "10010", "10010", "11110"],
  "9": ["11110", "10010", "10010", "11110", "00010", "00010", "11110"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10011", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  J: ["00111", "00010", "00010", "00010", "10010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
};

const putPixel = (pixels: Buffer, width: number, x: number, y: number, rgb: readonly number[]) => {
  const index = (y * width + x) * 3;
  pixels[index] = rgb[0];
  pixels[index + 1] = rgb[1];
  pixels[index + 2] = rgb[2];
};

const fillRect = (
  pixels: Buffer,
  width: number,
  x: number,
  y: number,
  rectWidth: number,
  rectHeight: number,
  rgb: readonly number[],
): void => {
  for (let yy = y; yy < y + rectHeight; yy += 1) {
    for (let xx = x; xx < x + rectWidth; xx += 1) {
      putPixel(pixels, width, xx, yy, rgb);
    }
  }
};

const writePpm = (path: string, width: number, height: number, pixels: Buffer): void => {
  writeFileSync(path, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]));
};

const makeLabelPpm = (path: string, label: string, height: number): void => {
  const pixels = Buffer.alloc(RECORDING_WIDTH * height * 3);
  fillRect(pixels, RECORDING_WIDTH, 0, 0, RECORDING_WIDTH, height, [17, 18, 23]);
  fillRect(pixels, RECORDING_WIDTH, 0, 0, RECORDING_WIDTH, 110, [0, 0, 0]);
  const scale = 6;
  let x = 34;
  const y = 34;
  for (const char of label.toUpperCase()) {
    const glyph = FONT[char] ?? FONT[" "];
    for (let row = 0; row < glyph.length; row += 1) {
      for (let col = 0; col < glyph[row].length; col += 1) {
        if (glyph[row][col] === "1") {
          fillRect(
            pixels,
            RECORDING_WIDTH,
            x + col * scale,
            y + row * scale,
            scale,
            scale,
            [255, 255, 255],
          );
        }
      }
    }
    x += 6 * scale;
    if (x > RECORDING_WIDTH - 40) break;
  }
  writePpm(path, RECORDING_WIDTH, height, pixels);
};

class BootRecorder {
  private frame = 0;
  private page: CdpPage | null = null;
  private startedAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private enabled: boolean;

  constructor(
    private readonly frameDir: string,
    private readonly outputPath: string,
  ) {
    this.enabled = process.env.E2E_RECORD === "1" && commandAvailable("ffmpeg");
  }

  static create = (runDir: string): BootRecorder | null => {
    if (process.env.E2E_RECORD !== "1") return null;
    const frameDir = join(runDir, "stale-launchd-fast-boot-frames");
    rmSync(frameDir, { recursive: true, force: true });
    mkdirSync(frameDir, { recursive: true });
    mkdirSync(dirname(RECORDING_FILE), { recursive: true });
    rmSync(RECORDING_FILE, { force: true });
    return new BootRecorder(frameDir, RECORDING_FILE);
  };

  start = (startedAt: number): void => {
    this.startedAt = startedAt;
    if (!this.enabled) return;
    this.enqueueFrame("waiting for Electron window", null);
    this.timer = setInterval(() => {
      this.enqueueFrame(
        this.page ? "app window reachable" : "waiting for Electron window",
        this.page,
      );
    }, 1_000);
  };

  attachPage = (page: CdpPage): void => {
    this.page = page;
    this.enqueueFrame("app window reachable", page);
  };

  captureReadyFrame = async (): Promise<void> => {
    if (!this.enabled) return;
    this.enqueueFrame("executor ready", this.page);
    await this.queue;
  };

  stop = async (): Promise<void> => {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.enabled) return;
    await this.queue;
    if (this.frame > 0) {
      execFileSync(
        "ffmpeg",
        [
          "-y",
          "-framerate",
          "1",
          "-i",
          join(this.frameDir, "frame-%04d.ppm"),
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          this.outputPath,
        ],
        { stdio: "ignore" },
      );
    }
  };

  recordingStats = (): {
    readonly path: string;
    readonly size: number;
    readonly frames: number;
  } | null => {
    if (!existsSync(this.outputPath)) return null;
    return { path: this.outputPath, size: statSync(this.outputPath).size, frames: this.frame };
  };

  private enqueueFrame = (state: string, page: CdpPage | null): void => {
    if (!this.enabled) return;
    this.queue = this.queue
      .then(() => this.writeFrame(state, page))
      .catch((error) => {
        this.enabled = false;
        console.warn(`[stale-launchd-repro] recording disabled after frame error: ${error}`);
      });
  };

  private writeFrame = async (state: string, page: CdpPage | null): Promise<void> => {
    this.frame += 1;
    const elapsedSeconds = (Date.now() - this.startedAt) / 1000;
    const output = join(this.frameDir, `frame-${String(this.frame).padStart(4, "0")}.ppm`);
    const label = `${elapsedSeconds.toFixed(1)}s ${state}`;
    if (!page) {
      makeLabelPpm(output, label, RECORDING_HEIGHT);
      return;
    }
    const raw = join(this.frameDir, `raw-${String(this.frame).padStart(4, "0")}.png`);
    const labelFrame = join(this.frameDir, `label-${String(this.frame).padStart(4, "0")}.ppm`);
    await page.screenshot(raw);
    makeLabelPpm(labelFrame, label, 110);
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-i",
        raw,
        "-i",
        labelFrame,
        "-filter_complex",
        `[0:v]scale=${RECORDING_WIDTH}:${RECORDING_HEIGHT}:force_original_aspect_ratio=decrease,pad=${RECORDING_WIDTH}:${RECORDING_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black[base];[base][1:v]overlay=0:0`,
        "-frames:v",
        "1",
        output,
      ],
      { stdio: "ignore" },
    );
    rmSync(raw, { force: true });
    rmSync(labelFrame, { force: true });
  };
}

const run = async (runDir: string): Promise<void> => {
  const cleanHome = mkdtempSync(join(tmpdir(), "executor-pkg-clean-boot-control-"));
  const staleHome = mkdtempSync(join(tmpdir(), "executor-pkg-stale-launchd-"));
  const launchdSnapshot = captureLaunchdService();
  const staleRecorder = BootRecorder.create(runDir);

  try {
    const clean = await bootPackagedApp({
      home: cleanHome,
      env: cleanBootEnv(cleanHome),
      recorder: null,
      expectStartupWindow: false,
      expectStaleRecoveryLog: false,
    });

    writeStaleLaunchAgentPlist(staleHome);
    await launchctl(["bootout", serviceTarget()]);
    const stale = await bootPackagedApp({
      home: staleHome,
      env: packagedAppEnv(staleHome),
      recorder: staleRecorder,
      expectStartupWindow: true,
      expectStaleRecoveryLog: true,
    });

    /*
     * Regression guard for the production incident:
     * a stale plist makes `service status` report registered while launchd cannot
     * find the label. The app must show a window immediately, then repair or
     * bypass that stale service without paying the old dead 15s wait.
     */
    expect(stale.kickstartFailureLine, "stale boot logs the launchd kickstart failure").toContain(
      "launchctl kickstart failed",
    );
    expect(
      stale.kickstartFailureLine,
      "the failed kickstart is classified as a stale registration to repair",
    ).toContain("Failed to restart registered supervised service; reinstalling");
    expect(
      stale.recoveryLogLine,
      "kickstart failure is followed by self-heal or fallback logging",
    ).not.toBeNull();
    expect(
      stale.pageCdpMs,
      "the Electron page target is reachable before service recovery finishes",
    ).toBeLessThan(3_000);
    expect(
      stale.startupWindowMs,
      "the startup window appears promptly in the stale launchd case",
    ).toBeLessThan(3_000);
    expect(new URL(stale.origin).port, "recovery must not attach to the stale plist port").not.toBe(
      String(STALE_PLIST_PORT),
    );
    expect(
      clean.sidecarReadyMs,
      "the clean control skips supervision and boots quickly",
    ).toBeLessThan(10_000);
    expect(
      stale.sidecarReadyMs,
      "stale launchd recovery stays within the fast boot budget",
    ).toBeLessThan(10_000);
    expect(
      stale.sidecarReadyMs,
      "the stale launchd path stays close to the clean control",
    ).toBeLessThan(clean.sidecarReadyMs + 7_500);
    const repairedLaunchd = stale.launchdPrintSucceeded && stale.manifestKind === "cli-daemon";
    const managedFallback =
      !stale.launchdPrintSucceeded && stale.manifestKind === "desktop-sidecar";
    expect(
      repairedLaunchd || managedFallback,
      "stale state is either repaired into launchd or cleanly falls back to managed spawn",
    ).toBe(true);

    const recording = staleRecorder?.recordingStats();
    emitEvidence(
      `[stale-launchd-repro] clean=${clean.sidecarReadyMs}ms stale=${stale.sidecarReadyMs}ms staleStartup=${stale.startupWindowMs}ms stalePageCdp=${stale.pageCdpMs}ms cleanOrigin=${clean.origin} staleOrigin=${stale.origin} staleConnectionKind=${stale.connectionKind} staleManifestKind=${stale.manifestKind} stalePid=${stale.manifestPid} launchdPrintAfterBoot=${stale.launchdPrintSucceeded}`,
    );
    emitEvidence(`[stale-launchd-repro] kickstartFailureLine=${stale.kickstartFailureLine}`);
    emitEvidence(`[stale-launchd-repro] recoveryLogLine=${stale.recoveryLogLine}`);
    if (recording) {
      emitEvidence(
        `[stale-launchd-repro] recording=${recording.path} frames=${recording.frames} size=${recording.size}`,
      );
    }
  } finally {
    await restoreLaunchdService(launchdSnapshot);
    rmSync(cleanHome, { recursive: true, force: true });
    rmSync(staleHome, { recursive: true, force: true });
  }
};

if (!macAquaAvailable() || !packagedSingleInstanceAvailable()) {
  it.skip(`${SCENARIO_NAME} (needs macOS Aqua and no already-running Executor.app)`, () => {});
} else {
  scenario(
    SCENARIO_NAME,
    { timeout: 360_000 },
    Effect.gen(function* () {
      requireBundle();
      const runDir = yield* RunDir;
      yield* Effect.promise(() => run(runDir));
    }),
  );
}
