// Process glue for the per-target globalsetups: spawn the app's own dev
// server, wait until it answers HTTP, and hand vitest a teardown. The apps own
// what runs (their dev stack, their stub flags); this file only owns process
// lifecycle, so it stays target-agnostic.
import { spawn, type ChildProcess } from "node:child_process";

export interface BootedProcesses {
  readonly teardown: () => Promise<void>;
}

export const bootProcesses = (
  procs: ReadonlyArray<{
    readonly cmd: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly env?: Record<string, string | undefined>;
  }>,
  options: { readonly label: string },
): BootedProcesses => {
  const children: ChildProcess[] = [];
  let tearingDown = false;
  for (const proc of procs) {
    const child = spawn(proc.cmd, [...proc.args], {
      cwd: proc.cwd,
      env: { ...process.env, ...proc.env },
      stdio: process.env.E2E_VERBOSE ? "inherit" : "ignore",
    });
    child.on("exit", (code) => {
      if (code !== 0 && code !== null && !tearingDown) {
        console.error(`[e2e:${options.label}] ${proc.cmd} exited with ${code}`);
      }
    });
    children.push(child);
  }
  return {
    teardown: async () => {
      tearingDown = true;
      for (const child of children) child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 500));
      for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
};

export const waitForHttp = async (url: string, timeoutMs = 90_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status < 500) return;
      lastError = new Error(`status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`timed out waiting for ${url}: ${String(lastError)}`);
};
