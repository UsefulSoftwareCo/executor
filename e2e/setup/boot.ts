// Process glue for the per-target globalsetups: spawn the app's own dev
// server, wait until it answers HTTP, and hand vitest a teardown. The apps own
// what runs (their dev stack, their stub flags); this file only owns process
// lifecycle, so it stays target-agnostic.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const BOOT_LOG_TAIL_BYTES = 8_000;
const HTTP_PROBE_TIMEOUT_MS = 5_000;

/** A long-lived boot process exited before its service became ready. */
export class BootProcessExitError extends Error {
  readonly _tag = "BootProcessExitError";

  constructor(
    readonly command: string,
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
    readonly logTail: string,
  ) {
    const outcome = exitCode === null ? `signal ${signal ?? "unknown"}` : `code ${exitCode}`;
    const diagnostic = logTail ? `\nLast boot log output:\n${logTail}` : "";
    super(`Boot process ${JSON.stringify(command)} exited with ${outcome}${diagnostic}`);
    this.name = "BootProcessExitError";
  }
}

/** A service process stayed alive but did not become HTTP-ready in time. */
export class BootReadinessTimeoutError extends Error {
  readonly _tag = "BootReadinessTimeoutError";

  constructor(
    readonly url: string,
    readonly timeoutMs: number,
    readonly lastError: unknown,
  ) {
    super(`Timed out after ${timeoutMs}ms waiting for ${url}: ${String(lastError)}`);
    this.name = "BootReadinessTimeoutError";
  }
}

/** Whether an acquisition failed because a live process never became ready. */
export const isBootReadinessTimeout = (error: unknown): boolean =>
  error instanceof BootReadinessTimeoutError;

export interface BootedProcesses {
  readonly teardown: () => Promise<void>;
  /** Process-group leader pids — what an external `down` must signal. */
  readonly pids: ReadonlyArray<number>;
}

/** A spawned process tree that can report an exit during startup. */
export interface MonitoredBootedProcesses extends BootedProcesses {
  /** Rejects as soon as any child exits before readiness/teardown. */
  readonly unexpectedExit: Promise<never>;
}

const readLogTail = (logFile: string | undefined): string => {
  if (!logFile) return "";
  try {
    return readFileSync(logFile, "utf8").slice(-BOOT_LOG_TAIL_BYTES).trim();
  } catch {
    return "";
  }
};

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
): MonitoredBootedProcesses => {
  const children: ChildProcess[] = [];
  let tearingDown = false;
  const unexpectedExits: Array<Promise<never>> = [];
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
    if (log !== undefined) closeSync(log);
    unexpectedExits.push(
      new Promise<never>((_resolve, reject) => {
        child.once("error", (cause) => {
          if (tearingDown) return;
          // oxlint-disable-next-line executor/no-promise-reject -- boundary: adapt the child-process error event to the startup race
          reject(
            new BootProcessExitError(
              [proc.cmd, ...proc.args].join(" "),
              child.exitCode,
              child.signalCode,
              `${readLogTail(proc.logFile)}\n${String(cause)}`.trim(),
            ),
          );
        });
        child.once("exit", (code, signal) => {
          if (tearingDown) return;
          const error = new BootProcessExitError(
            [proc.cmd, ...proc.args].join(" "),
            code,
            signal,
            readLogTail(proc.logFile),
          );
          console.error(`[e2e:${options.label}] ${error.message}`);
          // oxlint-disable-next-line executor/no-promise-reject -- boundary: adapt the child-process exit event to the startup race
          reject(error);
        });
      }),
    );
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
    unexpectedExit: Promise.race(unexpectedExits),
  };
};

/**
 * Wait for a boot probe while also observing the spawned process tree. The
 * losing readiness probe is aborted, so an early process exit neither hides
 * behind the full HTTP timeout nor leaves a polling timer alive.
 */
export const waitForBoot = async <A>(
  processes: MonitoredBootedProcesses,
  ready: (signal: AbortSignal) => Promise<A>,
): Promise<A> => {
  const controller = new AbortController();
  try {
    return await Promise.race([ready(controller.signal), processes.unexpectedExit]);
  } finally {
    controller.abort();
  }
};

export const waitForHttp = async (
  url: string,
  options: {
    readonly timeoutMs?: number;
    readonly expectRedirect?: boolean;
    readonly signal?: AbortSignal;
  } = {},
): Promise<void> => {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const deadline = performance.now() + timeoutMs;
  let lastError: unknown;
  while (performance.now() < deadline) {
    options.signal?.throwIfAborted();
    try {
      const remainingMs = Math.max(1, deadline - performance.now());
      const probeTimeout = AbortSignal.timeout(Math.min(HTTP_PROBE_TIMEOUT_MS, remainingMs));
      const signal = options.signal
        ? AbortSignal.any([options.signal, probeTimeout])
        : probeTimeout;
      const response = await fetch(url, { redirect: "manual", signal });
      // During a cold vite compile /api/* falls back to the SPA's 200 HTML —
      // expectRedirect waits for the real handler (302) instead.
      if (options.expectRedirect ? response.status === 302 : response.status < 500) return;
      lastError = new Error(`status ${response.status}`);
    } catch (error) {
      options.signal?.throwIfAborted();
      lastError = error;
    }
    await sleep(400, undefined, { signal: options.signal });
  }
  throw new BootReadinessTimeoutError(url, timeoutMs, lastError);
};

/**
 * Reboot DOWN-GATE: wait until `url` stops answering (fetch rejects — connection
 * refused/reset). An orderly OS shutdown keeps the daemon serving for several
 * seconds, and a reconnecting tunnel re-establishes the forward, so polling for
 * "up" right after a reboot command can false-pass a reboot that never happened.
 * Gating on the server actually going DOWN first makes restart-persistence prove
 * a real reboot. Throws if it never goes down within the deadline.
 */
export const waitForHttpDown = async (
  url: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<void> => {
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  while (Date.now() < deadline) {
    try {
      await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2000) });
    } catch {
      return; // the server (or its tunnel) is gone — the reboot took
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${url} never became unreachable — the reboot may not have taken`);
};
