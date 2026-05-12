/**
 * Sidecar lifecycle manager run inside the Electron main process.
 *
 * In dev: spawns `bun run apps/desktop/src/sidecar/server.ts`.
 * In prod: spawns the Bun-compiled `executor-sidecar` binary shipped under
 *          `process.resourcesPath/sidecar/`.
 *
 * Either way, the child receives EXECUTOR_PORT/EXECUTOR_HOST/EXECUTOR_AUTH_PASSWORD
 * via env, calls `startServer()` from `@executor-js/local`, and announces a
 * single sentinel line on stdout (`EXECUTOR_READY:<port>`) so this controller
 * can resolve the connection promise.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { app } from "electron";

export interface SidecarConnection {
  readonly baseUrl: string;
  readonly hostname: string;
  readonly port: number;
  readonly authPassword: string;
  readonly child: ChildProcess;
}

interface StartOptions {
  readonly hostname?: string;
}

const generatePassword = (): string => randomBytes(24).toString("base64url");

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
  const authPassword = generatePassword();
  const clientDir = resolveClientDir();
  const { command, args, cwd } = resolveSidecarCommand();

  if (!existsSync(clientDir)) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: misconfiguration is fatal
    throw new Error(
      `Executor client bundle not found at ${clientDir}. Run \`bun run --filter @executor-js/local build\` before launching desktop.`,
    );
  }

  // executor.jsonc and data.db go to ~/.executor — the same path the CLI's
  // `executor web` uses. Desktop and CLI share state on the same machine so
  // sources/secrets/policies set up in one show up in the other, and
  // user-facing commands like `executor mcp --scope ~/.executor` stay
  // copy-paste-friendly. Electron's userData (set in main/index.ts) is
  // still used for electron-store, electron-log, and window-state — those
  // stay app-scoped to avoid colliding with anything else under HOME.
  const scopeDir = join(homedir(), ".executor");
  mkdirSync(scopeDir, { recursive: true });

  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      EXECUTOR_PORT: "0",
      EXECUTOR_HOST: hostname,
      EXECUTOR_AUTH_PASSWORD: authPassword,
      EXECUTOR_CLIENT_DIR: clientDir,
      EXECUTOR_SCOPE_DIR: scopeDir,
      EXECUTOR_DATA_DIR: scopeDir,
    },
  });

  return new Promise<SidecarConnection>((resolveStart, rejectStart) => {
    let stderrBuffer = "";
    let resolved = false;

    const onStdout = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      process.stdout.write(`[executor-sidecar] ${text}`);
      const match = text.match(/EXECUTOR_READY:(\d+)/);
      if (match && !resolved) {
        resolved = true;
        const port = parseInt(match[1], 10);
        resolveStart({
          baseUrl: `http://${hostname}:${port}`,
          hostname,
          port,
          authPassword,
          child,
        });
      }
    };

    const onStderr = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrBuffer += text;
      process.stderr.write(`[executor-sidecar] ${text}`);
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (!resolved) {
        const message = `Sidecar exited before ready (code=${code} signal=${signal}). Stderr:\n${stderrBuffer}`;
        // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: sidecar boot failure surfaces here as a rejected start promise
        rejectStart(new Error(message));
      }
    };

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("exit", onExit);
  });
}

export async function stopSidecar(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  return new Promise<void>((resolveStop) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolveStop();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveStop();
    });
    child.kill("SIGTERM");
  });
}
