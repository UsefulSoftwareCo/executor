/**
 * Sidecar lifecycle manager run inside the Electron main process.
 *
 * In dev: spawns `bun run apps/desktop/src/sidecar/server.ts`.
 * In prod: spawns the Bun-compiled `executor-sidecar` binary shipped under
 *          `process.resourcesPath/sidecar/`.
 *
 * Either way, the child receives EXECUTOR_PORT/EXECUTOR_HOST/EXECUTOR_AUTH_TOKEN
 * via env, calls `startServer()` from `@executor-js/local`, and announces a
 * single sentinel line on stdout (`EXECUTOR_READY:<port>`) so this controller
 * can resolve the connection promise.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { app } from "electron";
import log from "electron-log/main.js";
import { Option, Schema } from "effect";
import {
  normalizeExecutorServerConnection,
  parseExecutorLocalServerManifest,
  serializeExecutorLocalServerManifest,
} from "@executor-js/sdk/shared";
import { loadOrMintLocalAuthToken } from "@executor-js/local/auth";
import { getServerSettings } from "./settings";
import { reportSidecarCrash, sidecarCrashReportingEnv } from "./diagnostics";
import { SERVER_SETTINGS_USERNAME, type DesktopServerSettings } from "../shared/server-settings";

// Sidecar output is echoed to the terminal (visible when Electron is run
// from a shell) AND persisted to main.log under the "sidecar" scope — the
// log file is what a user can actually send us after a crash.
const sidecarLog = log.scope("sidecar");

// Rolling stderr tail attached to crash reports. Bounded so a chatty
// sidecar can't grow it unbounded over a long session.
const STDERR_TAIL_LIMIT = 8 * 1024;

// Children deliberately stopped via stopSidecar (quit, restart, update) —
// their exits are expected and must not be reported as crashes.
const expectedExits = new WeakSet<ChildProcess>();

// Main/index.ts subscribes to swap the dead web UI for the in-window crash
// screen. A callback (not an import) keeps this module free of window
// concerns.
let unexpectedExitListener: (() => void) | null = null;
export const onUnexpectedSidecarExit = (listener: () => void) => {
  unexpectedExitListener = listener;
};

/** Buffer chunked output into whole lines before handing them to `write`. */
const makeLineSplitter = (write: (line: string) => void) => {
  let buffer = "";
  return (text: string) => {
    buffer += text;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length > 0) write(line);
    }
  };
};

export interface SidecarConnection {
  readonly baseUrl: string;
  readonly hostname: string;
  readonly port: number;
  readonly username: string;
  readonly authToken: string;
  /**
   * The child process we spawned and own, or `null` when we attached to an
   * OS-supervised daemon that outlives this app (see `supervisedDaemon`).
   */
  readonly child: ChildProcess | null;
  /**
   * True when this connection points at an OS-supervised daemon (launchd/etc.)
   * that we did NOT spawn and must NOT stop on quit — quitting the app should
   * leave MCP serving.
   */
  readonly supervisedDaemon: boolean;
}

export class SidecarPortInUseError extends Error {
  readonly port: number;
  constructor(port: number) {
    super(`Port ${port} is already in use. Pick another in Settings.`);
    this.name = "SidecarPortInUseError";
    this.port = port;
  }
}

interface StartOptions {
  readonly hostname?: string;
}

const sidecarManifestPathByPid = new Map<number, string>();

const serverControlDir = (dataDir: string): string => join(dataDir, "server-control");
const localServerManifestPath = (dataDir: string): string =>
  join(serverControlDir(dataDir), "server.json");
const localServerStartLockPath = (dataDir: string): string =>
  join(serverControlDir(dataDir), "startup.lock");

const LocalServerStartLockFile = Schema.Struct({
  pid: Schema.Number,
  startedAt: Schema.String,
});
const decodeUnknownJsonOption = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);
const decodeLocalServerStartLockFile = Schema.decodeUnknownOption(LocalServerStartLockFile);

const isPidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: Node process probing API reports liveness by throwing
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readManifest = (dataDir: string) => {
  const path = localServerManifestPath(dataDir);
  if (!existsSync(path)) return null;
  return parseExecutorLocalServerManifest(readFileSync(path, "utf8"));
};

const removeManifestIfOwnedBy = (dataDir: string, pid: number) => {
  const manifest = readManifest(dataDir);
  if (manifest?.pid !== pid) return;
  rmSync(localServerManifestPath(dataDir), { force: true });
};

const assertNoOtherLocalServerOwner = (dataDir: string) => {
  const manifest = readManifest(dataDir);
  if (!manifest) return;
  if (!isPidAlive(manifest.pid)) {
    removeManifestIfOwnedBy(dataDir, manifest.pid);
    return;
  }
  // oxlint-disable-next-line executor/no-error-constructor, executor/no-try-catch-or-throw -- boundary: startup failure is surfaced in the Electron main process
  throw new Error(
    [
      `A local Executor ${manifest.kind} is already running at ${manifest.connection.origin} (pid ${manifest.pid}).`,
      `It owns the current data directory: ${manifest.dataDir}`,
      "Stop it before starting the desktop sidecar.",
    ].join("\n"),
  );
};

const readLockPid = (dataDir: string): number | null => {
  const path = localServerStartLockPath(dataDir);
  if (!existsSync(path)) return null;
  const json = decodeUnknownJsonOption(readFileSync(path, "utf8"));
  if (Option.isNone(json)) return null;
  const decoded = decodeLocalServerStartLockFile(json.value);
  return Option.isSome(decoded) ? decoded.value.pid : null;
};

const acquireLocalServerStartLock = (dataDir: string): (() => void) => {
  mkdirSync(serverControlDir(dataDir), { recursive: true });
  const lockPath = localServerStartLockPath(dataDir);
  const payload = `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: lock acquisition uses atomic Node fs flags and maps contention to startup failure
  try {
    writeFileSync(lockPath, payload, { flag: "wx" });
  } catch {
    const existingPid = readLockPid(dataDir);
    if (existingPid !== null && !isPidAlive(existingPid)) {
      rmSync(lockPath, { force: true });
      writeFileSync(lockPath, payload, { flag: "wx" });
    } else {
      // oxlint-disable-next-line executor/no-error-constructor, executor/no-try-catch-or-throw -- boundary: startup failure is surfaced in the Electron main process
      throw new Error("Another local Executor server startup is already in progress.");
    }
  }
  return () => rmSync(lockPath, { force: true });
};

const writeSidecarManifest = (input: {
  readonly dataDir: string;
  readonly scopeDir: string;
  readonly baseUrl: string;
  readonly authToken: string;
  readonly childPid: number;
}) => {
  const connection = normalizeExecutorServerConnection({
    kind: "desktop-sidecar",
    key: "desktop-sidecar",
    origin: input.baseUrl,
    displayName: "Desktop sidecar",
    auth: { kind: "bearer" as const, token: input.authToken },
  });
  const manifestPath = localServerManifestPath(input.dataDir);
  writeFileSync(
    manifestPath,
    serializeExecutorLocalServerManifest({
      version: 1,
      kind: "desktop-sidecar",
      pid: input.childPid,
      startedAt: new Date().toISOString(),
      dataDir: input.dataDir,
      scopeDir: input.scopeDir,
      connection,
      owner: {
        client: "desktop",
        version: app.getVersion() || null,
        executablePath: process.execPath || null,
      },
    }),
    { mode: 0o600 },
  );
  // The manifest embeds the bearer token; keep it owner-only even if a looser
  // file already existed (writeFileSync's mode does not re-apply on overwrite).
  chmodSync(manifestPath, 0o600);
  sidecarManifestPathByPid.set(input.childPid, input.dataDir);
};

const resolveSidecarCommand = (): { command: string; args: string[]; cwd: string } => {
  if (app.isPackaged) {
    const binaryName = process.platform === "win32" ? "executor-sidecar.exe" : "executor-sidecar";
    const binaryPath = join(process.resourcesPath, "sidecar", binaryName);
    return { command: binaryPath, args: [], cwd: process.resourcesPath };
  }
  // Dev: run the TS source directly via bun on PATH.
  const repoRoot = resolve(import.meta.dirname, "..", "..", "..", "..");
  const sidecarSource = resolve(repoRoot, "apps/desktop/src/sidecar/server.ts");
  return { command: "bun", args: ["run", sidecarSource], cwd: repoRoot };
};

const resolveClientDir = (): string => {
  if (app.isPackaged) {
    return join(process.resourcesPath, "web-ui");
  }
  const repoRoot = resolve(import.meta.dirname, "..", "..", "..", "..");
  return resolve(repoRoot, "apps/local/dist");
};

export async function startSidecar(options: StartOptions = {}): Promise<SidecarConnection> {
  const hostname = options.hostname ?? "127.0.0.1";
  const settings = getServerSettings();
  const clientDir = resolveClientDir();
  const { command, args, cwd } = resolveSidecarCommand();

  if (!existsSync(clientDir)) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: misconfiguration is fatal
    // oxlint-disable-next-line executor/no-error-constructor, executor/no-try-catch-or-throw -- boundary: startup failure is surfaced in the Electron main process
    throw new Error(
      `Executor client bundle not found at ${clientDir}. Run \`bun run --filter @executor-js/local build\` before launching desktop.`,
    );
  }

  // data.db and the optional executor.jsonc plugin manifest live under
  // ~/.executor — the same path the CLI's `executor web` uses. Desktop and CLI
  // share state on the same machine so sources/secrets/policies set up in one
  // show up in the other, and user-facing commands like
  // `executor mcp --scope ~/.executor` stay copy-paste-friendly. Electron's
  // userData (set in main/index.ts) is still used for electron-store,
  // electron-log, and window-state — those stay app-scoped to avoid colliding
  // with anything else under HOME.
  const scopeDir = join(homedir(), ".executor");
  const dataDir = scopeDir;
  mkdirSync(dataDir, { recursive: true });

  // The stable bearer token from auth.json (shared with the CLI). The main
  // process holds it so it can inject the header into the webview; the child
  // validates against the same value. Always present — auth is unconditional.
  const authToken = loadOrMintLocalAuthToken(dataDir);
  const releaseStartupLock = acquireLocalServerStartLock(dataDir);
  let startupLockReleased = false;
  const releaseLock = () => {
    if (startupLockReleased) return;
    startupLockReleased = true;
    releaseStartupLock();
  };

  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: startup lock must be released before rethrowing Electron startup failures
  try {
    assertNoOtherLocalServerOwner(dataDir);
  } catch (error) {
    releaseLock();
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: preserve Electron startup failure after releasing local startup lock
    throw error;
  }

  let child: ChildProcess;
  const webBaseUrl = `http://${hostname}:${settings.port}`;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: spawn can throw synchronously and the local startup lock must be released
  try {
    child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        EXECUTOR_PORT: String(settings.port),
        EXECUTOR_HOST: hostname,
        EXECUTOR_WEB_BASE_URL: webBaseUrl,
        PORT: String(settings.port),
        // The bearer token the child validates and the main process injects into
        // the webview. Always set — auth is unconditional.
        EXECUTOR_AUTH_TOKEN: authToken,
        EXECUTOR_CLIENT_DIR: clientDir,
        EXECUTOR_SCOPE_DIR: scopeDir,
        EXECUTOR_DATA_DIR: dataDir,
        EXECUTOR_CLIENT: "desktop",
        // Crash reporting (desktop builds with a baked-in DSN only). The
        // CLI's `executor web` never sets these, so the shared server code
        // stays telemetry-free outside the desktop app.
        ...sidecarCrashReportingEnv(),
      },
    });
  } catch (error) {
    releaseLock();
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: preserve spawn failure after releasing local startup lock
    throw error;
  }

  return new Promise<SidecarConnection>((resolveStart, rejectStart) => {
    let stderrBuffer = "";
    let resolved = false;
    let rejected = false;

    const logStdoutLine = makeLineSplitter((line) => sidecarLog.info(line));
    const logStderrLine = makeLineSplitter((line) => sidecarLog.error(line));

    const reject = (err: Error) => {
      if (resolved || rejected) return;
      rejected = true;
      releaseLock();
      // oxlint-disable-next-line executor/no-promise-reject -- boundary: sidecar startup surfaces as a rejected promise
      rejectStart(err);
    };

    const onStdout = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      process.stdout.write(`[executor-sidecar] ${text}`);
      logStdoutLine(text);
      const match = text.match(/EXECUTOR_READY:(\d+)/);
      if (match && !resolved) {
        if (!child.pid) {
          reject(
            // oxlint-disable-next-line executor/no-error-constructor -- boundary: sidecar startup failure surfaces here as a rejected start promise
            new Error("Sidecar became ready before Electron reported a child pid."),
          );
          return;
        }
        resolved = true;
        const port = parseInt(match[1], 10);
        const baseUrl = `http://${hostname}:${port}`;
        writeSidecarManifest({
          dataDir,
          scopeDir,
          baseUrl,
          authToken,
          childPid: child.pid,
        });
        releaseLock();
        resolveStart({
          baseUrl,
          hostname,
          port,
          username: SERVER_SETTINGS_USERNAME,
          authToken,
          child,
          supervisedDaemon: false,
        });
      }
    };

    const onStderr = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrBuffer = (stderrBuffer + text).slice(-STDERR_TAIL_LIMIT);
      process.stderr.write(`[executor-sidecar] ${text}`);
      logStderrLine(text);
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (resolved) {
        // Post-boot exit: expected when we stopped it ourselves (quit,
        // restart, update); anything else is a sidecar crash under a live
        // window — log it and report upstream with the stderr tail.
        if (expectedExits.has(child)) {
          sidecarLog.info(`exited (code=${code} signal=${signal})`);
          return;
        }
        const message = `Sidecar exited unexpectedly (code=${code} signal=${signal})`;
        sidecarLog.error(message);
        reportSidecarCrash(message, stderrBuffer);
        unexpectedExitListener?.();
        return;
      }
      if (rejected) return;
      // Detect bind failure — the Node listener prints either "EADDRINUSE" or
      // "address already in use" on stderr before exiting non-zero.
      if (/EADDRINUSE|address already in use/i.test(stderrBuffer)) {
        reject(new SidecarPortInUseError(settings.port));
        return;
      }
      const message = `Sidecar exited before ready (code=${code} signal=${signal}). Stderr:\n${stderrBuffer}`;
      // oxlint-disable-next-line executor/no-error-constructor -- boundary: sidecar boot failure surfaces here as a rejected start promise
      reject(new Error(message));
    };

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("exit", onExit);
  });
}

/**
 * Probe whether an HTTP server is listening at `origin`. Any HTTP response —
 * even 401/404 — means a server is up; only a network error or timeout counts
 * as unreachable. Auth is attached so a 401 still confirms liveness cleanly.
 */
const isDaemonReachable = async (origin: string, authToken: string): Promise<boolean> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: fetch rejects on a down server; that's the "not reachable" signal
  try {
    const headers: Record<string, string> = {};
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    await fetch(origin, { signal: controller.signal, headers, redirect: "manual" });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Attach to an already-running OS-supervised daemon instead of spawning our own
 * sidecar. Reads `server.json`, confirms the recorded process is alive and the
 * endpoint answers, and returns a child-less `SidecarConnection` flagged
 * `supervisedDaemon: true`. Returns null when no usable supervised daemon is
 * present (the caller then falls back to managed-spawn).
 *
 * Only a `cli-daemon` manifest is treated as supervised — a `desktop-sidecar`
 * manifest belongs to a managed sidecar (ours or another desktop instance) and
 * is handled by the existing single-instance / ownership logic.
 */
export async function attachToSupervisedDaemon(): Promise<SidecarConnection | null> {
  const dataDir = join(homedir(), ".executor");
  const manifest = readManifest(dataDir);
  if (!manifest || manifest.kind !== "cli-daemon") return null;
  if (!isPidAlive(manifest.pid)) {
    removeManifestIfOwnedBy(dataDir, manifest.pid);
    return null;
  }

  const origin = manifest.connection.origin;
  const auth = manifest.connection.auth;
  const authToken = auth && auth.kind === "bearer" ? auth.token : "";
  if (!(await isDaemonReachable(origin, authToken))) return null;

  const url = new URL(origin);
  sidecarLog.info(`attaching to supervised daemon at ${origin} (pid ${manifest.pid})`);
  return {
    baseUrl: origin,
    hostname: url.hostname,
    port: Number.parseInt(url.port, 10) || (url.protocol === "https:" ? 443 : 80),
    username: SERVER_SETTINGS_USERNAME,
    authToken,
    child: null,
    supervisedDaemon: true,
  };
}

export async function stopSidecar(child: ChildProcess): Promise<void> {
  expectedExits.add(child);
  const cleanupManifest = () => {
    if (!child.pid) return;
    const dataDir = sidecarManifestPathByPid.get(child.pid);
    if (!dataDir) return;
    removeManifestIfOwnedBy(dataDir, child.pid);
    sidecarManifestPathByPid.delete(child.pid);
  };
  if (child.exitCode !== null || child.killed) {
    cleanupManifest();
    return;
  }
  return new Promise<void>((resolveStop) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      cleanupManifest();
      resolveStop();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timeout);
      cleanupManifest();
      resolveStop();
    });
    child.kill("SIGTERM");
  });
}

export type { DesktopServerSettings };
