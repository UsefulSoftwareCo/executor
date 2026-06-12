// Process glue for the per-target globalsetups: spawn the app's own dev
// server, wait until it answers HTTP, and hand vitest a teardown. The apps own
// what runs (their dev stack, their stub flags); this file only owns process
// lifecycle, so it stays target-agnostic.
import { spawn, type ChildProcess } from "node:child_process";
import { openSync } from "node:fs";

export interface BootedProcesses {
  readonly teardown: () => Promise<void>;
  /** Process-group leader pids — what an external `down` must signal. */
  readonly pids: ReadonlyArray<number>;
}

export const bootProcesses = (
  procs: ReadonlyArray<{
    readonly cmd: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly env?: Record<string, string | undefined>;
    /** Append stdout+stderr here (long-lived boots need inspectable logs). */
    readonly logFile?: string;
  }>,
  options: { readonly label: string },
): BootedProcesses => {
  const children: ChildProcess[] = [];
  let tearingDown = false;
  for (const proc of procs) {
    const log = proc.logFile ? openSync(proc.logFile, "a") : undefined;
    const child = spawn(proc.cmd, [...proc.args], {
      cwd: proc.cwd,
      env: { ...process.env, ...proc.env },
      stdio:
        log !== undefined ? ["ignore", log, log] : process.env.E2E_VERBOSE ? "inherit" : "ignore",
      // Own process group, so teardown can signal the whole tree — `bunx vite`
      // is a wrapper whose actual server child would otherwise outlive the
      // kill and squat the port into the NEXT invocation's waitForHttp.
      detached: true,
    });
    child.on("exit", (code) => {
      if (code !== 0 && code !== null && !tearingDown) {
        console.error(`[e2e:${options.label}] ${proc.cmd} exited with ${code}`);
      }
    });
    children.push(child);
  }

  // Signal the process GROUP (negative pid); fall back to the direct child
  // when the group is already gone.
  const signalTree = (child: ChildProcess, signal: NodeJS.Signals) => {
    if (child.pid === undefined || child.exitCode !== null) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  };

  const exited = (child: ChildProcess): Promise<void> =>
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once("exit", () => resolve()));

  return {
    teardown: async () => {
      tearingDown = true;
      const allExited = Promise.all(children.map(exited));
      for (const child of children) signalTree(child, "SIGTERM");
      // Wait for a REAL exit (not a fixed sleep) — a lingering server would
      // answer the next invocation's waitForHttp as a half-dead zombie.
      const graceful = await Promise.race([
        allExited.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
      ]);
      if (!graceful) {
        for (const child of children) signalTree(child, "SIGKILL");
        await Promise.race([allExited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      }
    },
    pids: children.flatMap((child) => (child.pid === undefined ? [] : [child.pid])),
  };
};

export const waitForHttp = async (
  url: string,
  options: { readonly timeoutMs?: number; readonly expectRedirect?: boolean } = {},
): Promise<void> => {
  const deadline = Date.now() + (options.timeoutMs ?? 90_000);
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      // During a cold vite compile /api/* falls back to the SPA's 200 HTML —
      // expectRedirect waits for the real handler (302) instead.
      if (options.expectRedirect ? response.status === 302 : response.status < 500) return;
      lastError = new Error(`status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`timed out waiting for ${url}: ${String(lastError)}`);
};
