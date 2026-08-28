import { readFile } from "node:fs/promises";
import { join } from "node:path";

const isAlive = (pid: number): boolean => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: process liveness probing reports false for an already-reaped test daemon
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch {
    return false;
  }
};

const signal = (pid: number, name: NodeJS.Signals): void => {
  // Auto-started daemons are detached process-group leaders. Signal the whole
  // private group so their Vite child cannot survive a failed test.
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: Windows and pre-detach failures require a direct-pid fallback
  try {
    process.kill(process.platform === "win32" ? pid : -pid, name);
  } catch {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- cleanup tolerates a process that exited between the liveness check and signal
    try {
      process.kill(pid, name);
    } catch {}
  }
};

const waitUntilStopped = async (pid: number, timeoutMs: number): Promise<boolean> => {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
};

/** Stop the detached daemon elected by an `executor mcp` cold start. */
export const stopAutoSpawnedDaemon = async (dataDir: string): Promise<void> => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- cleanup tolerates a bridge that failed before writing its manifest
  try {
    const manifest = JSON.parse(
      await readFile(join(dataDir, "server-control", "server.json"), "utf8"),
    ) as { readonly pid?: unknown };
    if (!Number.isSafeInteger(manifest.pid) || (manifest.pid as number) <= 0) return;

    const pid = manifest.pid as number;
    signal(pid, "SIGTERM");
    if (await waitUntilStopped(pid, 10_000)) return;

    signal(pid, "SIGKILL");
    await waitUntilStopped(pid, 2_000);
  } catch {
    // No manifest means there is no auto-started daemon to stop.
  }
};
