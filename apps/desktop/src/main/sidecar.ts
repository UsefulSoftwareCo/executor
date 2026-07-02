/**
 * Sidecar lifecycle manager run inside the Electron main process.
 *
 * In dev: spawns `bun run apps/desktop/src/sidecar/server.ts`.
 * In prod: spawns the bundled CLI binary in foreground daemon mode.
 *
 * Either way, the child receives EXECUTOR_PORT/EXECUTOR_HOST/EXECUTOR_AUTH_TOKEN.
 * The dev sidecar and packaged CLI child announce the structured stdout sentinel
 * `EXECUTOR_READY:<port>`. Human-readable log text is never part of the desktop
 * startup contract.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { app } from "electron";
import log from "electron-log/main.js";
import {
  normalizeExecutorServerConnection,
  parseExecutorLocalServerManifest,
  serializeExecutorLocalServerManifest,
} from "@executor-js/sdk/shared";
import { loadOrMintLocalAuthToken } from "./local-auth";
import { getServerSettings } from "./settings";
import { reportSidecarCrash, sidecarCrashReportingEnv } from "./diagnostics";
import { resolveSupervisedDaemonAttach } from "./supervised-daemon";
import { SERVER_SETTINGS_USERNAME, type DesktopServerSettings } from "../shared/server-settings";

// Sidecar output is echoed to the terminal (visible when Electron is run
// from a shell) AND persisted to main.log under the "sidecar" scope — the
// log file is what a user can actually send us after a crash.
const sidecarLog = log.scope("sidecar");

// Rolling stderr tail attached to crash reports. Bounded so a chatty
// sidecar can't grow it unbounded over a long session.
const STDERR_TAIL_LIMIT = 8 * 1024;
const READY_SENTINEL = "EXECUTOR_READY";

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
  readonly ownerVersion: string | null;
  readonly ownerClient: "cli" | "desktop";
  readonly ownerExecutablePath: string | null;
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
  mkdirSync(serverControlDir(input.dataDir), { recursive: true });
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

const resolveSidecarCommand = (input: {
  readonly port: number;
  readonly hostname: string;
  readonly authToken: string;
}): { command: string; args: string[]; cwd: string; cliManagedManifest: boolean } => {
  if (app.isPackaged) {
    const binaryName = process.platform === "win32" ? "executor.exe" : "executor";
    const binaryPath = join(process.resourcesPath, "executor", binaryName);
    return {
      command: binaryPath,
      args: [
        "daemon",
        "run",
        "--foreground",
        "--port",
        String(input.port),
        "--hostname",
        input.hostname,
        // Combined `--flag=value` form: the auth token is base64url and can
        // start with "-", which the space-separated form makes the CLI parser
        // read as an unknown flag, so the daemon prints help and exits and the
        // desktop reports a fatal "server crashed during startup". Persistent
        // until the token rotates, and cross-platform (~1 in 64 fresh installs).
        `--auth-token=${input.authToken}`,
      ],
      cwd: process.resourcesPath,
      cliManagedManifest: true,
    };
  }
  // Dev: run the TS source directly via bun on PATH.
  const repoRoot = resolve(import.meta.dirname, "..", "..", "..", "..");
  const sidecarSource = resolve(repoRoot, "apps/desktop/src/sidecar/server.ts");
  return { command: "bun", args: ["run", sidecarSource], cwd: repoRoot, cliManagedManifest: false };
};

const resolveClientDir = (): string => {
  const repoRoot = resolve(import.meta.dirname, "..", "..", "..", "..");
  return resolve(repoRoot, "apps/local/dist");
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

export async function startSidecar(options: StartOptions = {}): Promise<SidecarConnection> {
  const hostname = options.hostname ?? "127.0.0.1";
  const settings = getServerSettings();
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
  const { command, args, cwd, cliManagedManifest } = resolveSidecarCommand({
    port: settings.port,
    hostname,
    authToken,
  });
  const clientDir = cliManagedManifest ? null : resolveClientDir();

  if (!cliManagedManifest && clientDir && !existsSync(clientDir)) {
    // oxlint-disable-next-line executor/no-error-constructor, executor/no-try-catch-or-throw -- boundary: startup failure is surfaced in the Electron main process
    throw new Error(
      `Executor client bundle not found at ${clientDir}. Run \`bun run --filter @executor-js/local build\` before launching desktop.`,
    );
  }

  // No process-level startup lock: the dev sidecar child opens the DB through
  // openOwnedLocalDatabase, whose ownership lock is the real gate. If the child
  // loses the race, startup fails as before; only the packaged supervised boot
  // path attaches to an existing daemon.
  const webBaseUrl = `http://${hostname}:${settings.port}`;
  const child = spawn(command, args, {
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
      ...(clientDir ? { EXECUTOR_CLIENT_DIR: clientDir } : {}),
      EXECUTOR_SCOPE_DIR: scopeDir,
      EXECUTOR_DATA_DIR: dataDir,
      EXECUTOR_CLIENT: "desktop",
      // Crash reporting (desktop builds with a baked-in DSN only). The
      // CLI's `executor web` never sets these, so the shared server code
      // stays telemetry-free outside the desktop app.
      ...sidecarCrashReportingEnv(),
    },
  });

  return new Promise<SidecarConnection>((resolveStart, rejectStart) => {
    let stderrBuffer = "";
    let stdoutControlBuffer = "";
    let resolved = false;
    let rejected = false;

    const logStdoutLine = makeLineSplitter((line) => sidecarLog.info(line));
    const logStderrLine = makeLineSplitter((line) => sidecarLog.error(line));

    const reject = (err: Error) => {
      if (resolved || rejected) return;
      rejected = true;
      // oxlint-disable-next-line executor/no-promise-reject -- boundary: sidecar startup surfaces as a rejected promise
      rejectStart(err);
    };

    const onStdout = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      process.stdout.write(`[executor-server] ${text}`);
      logStdoutLine(text);
      stdoutControlBuffer += text;
      const rawControlLines = stdoutControlBuffer.split(/\r?\n/);
      stdoutControlBuffer = rawControlLines.pop() ?? "";
      const stdoutLines = rawControlLines
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const readyLine = stdoutLines.find((line) => line.startsWith(`${READY_SENTINEL}:`));
      if (readyLine && !resolved) {
        if (!child.pid) {
          reject(
            // oxlint-disable-next-line executor/no-error-constructor -- boundary: sidecar startup failure surfaces here as a rejected start promise
            new Error("Sidecar became ready before Electron reported a child pid."),
          );
          return;
        }
        resolved = true;
        const port = parseInt(readyLine.slice(`${READY_SENTINEL}:`.length), 10);
        const baseUrl = `http://${hostname}:${port}`;
        if (!cliManagedManifest) {
          writeSidecarManifest({
            dataDir,
            scopeDir,
            baseUrl,
            authToken,
            childPid: child.pid,
          });
        }
        resolveStart({
          baseUrl,
          hostname,
          port,
          username: SERVER_SETTINGS_USERNAME,
          authToken,
          child,
          supervisedDaemon: false,
          ownerVersion: app.getVersion() || null,
          ownerClient: "desktop",
          ownerExecutablePath: command,
        });
      }
    };

    const onStderr = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrBuffer = (stderrBuffer + text).slice(-STDERR_TAIL_LIMIT);
      process.stderr.write(`[executor-server] ${text}`);
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

/** Probe the unauthenticated Executor health endpoint without disclosing the saved bearer. */
const isDaemonReachable = async (origin: string): Promise<boolean> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: fetch rejects on a down server; that's the "not reachable" signal
    try {
      const response = await fetch(new URL("/api/health", origin), {
        signal: controller.signal,
        redirect: "manual",
      });
      const body = await response.text();
      if (response.ok && body.trim() === "ok") return true;
    } catch {
      // retry below
    } finally {
      clearTimeout(timer);
    }
    if (attempt < 2) await delay(150);
  }
  return false;
};

/**
 * Attach to an already-running OS-supervised daemon instead of spawning our own
 * sidecar. Reads `server.json`, confirms the endpoint answers, and returns a
 * child-less `SidecarConnection` flagged `supervisedDaemon: true`. Returns null
 * when no usable supervised daemon is present.
 *
 * Only a `cli-daemon` manifest is treated as supervised — a `desktop-sidecar`
 * manifest belongs to a managed sidecar (ours or another desktop instance) and
 * is handled by the existing single-instance / ownership logic.
 */
export async function attachToSupervisedDaemon(): Promise<SidecarConnection | null> {
  const dataDir = join(homedir(), ".executor");
  const manifest = readManifest(dataDir);
  const decision = await resolveSupervisedDaemonAttach(manifest, {
    isReachable: isDaemonReachable,
    isPidAlive,
  });
  if (decision.kind === "attach") {
    const { manifest, authToken } = decision;
    const origin = manifest.connection.origin;
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
      ownerVersion: manifest.owner.version,
      ownerClient: manifest.owner.client,
      ownerExecutablePath: manifest.owner.executablePath,
    };
  }

  if (decision.kind === "remove-stale-manifest") {
    removeManifestIfOwnedBy(dataDir, decision.pid);
    return null;
  }

  if (!manifest || manifest.kind !== "cli-daemon") return null;

  sidecarLog.warn(
    `supervised daemon at ${manifest.connection.origin} (pid ${manifest.pid}) did not answer the health probe; keeping its manifest because the process is still alive`,
  );
  return null;
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
