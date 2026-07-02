/* oxlint-disable executor/no-try-catch-or-throw -- boundary: subprocess ownership harness must clean up the held lock process even when assertions fail */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";

interface ChildOutput {
  readonly child: ChildProcessWithoutNullStreams;
  stdout: string;
  stderr: string;
}

interface ChildCloseResult {
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface MarkerWaitResult {
  readonly markerFound: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

const appRoot = join(import.meta.dirname, "../..");
const LOCK_DATABASE_FILENAME = "data.db.owner-lock";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const holderScript = `
  import { writeFileSync } from "node:fs";
  import { setTimeout as sleep } from "node:timers/promises";
  import { acquireDataDirOwnership } from "./src/db/data-dir-ownership.ts";

  const ownership = await acquireDataDirOwnership(process.env.EXECUTOR_TEST_DATA_DIR);
  writeFileSync(process.env.EXECUTOR_TEST_READY_MARKER, "ready");
  await sleep(60_000);
  await ownership.release();
`;

const attemptScript = `
  import { DataDirOwnershipHeld, acquireDataDirOwnership } from "./src/db/data-dir-ownership.ts";

  try {
    const ownership = await acquireDataDirOwnership(process.env.EXECUTOR_TEST_DATA_DIR);
    console.log(\`ACQUIRED \${ownership.lockPath}\`);
    await ownership.release();
    process.exit(0);
  } catch (cause) {
    if (cause instanceof DataDirOwnershipHeld) {
      console.log(\`HELD \${cause.lockPath}\`);
      process.exit(0);
    }
    console.log("FAILED");
    console.error(cause);
    process.exit(1);
  }
`;

const spawnScript = (code: string, env: Record<string, string>): ChildOutput => {
  const child = spawn(process.execPath, ["-e", code], {
    cwd: appRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      ...env,
    },
    stdio: "pipe",
  });

  const output: ChildOutput = { child, stdout: "", stderr: "" };
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    output.stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    output.stderr += chunk;
  });
  return output;
};

const waitForChildClose = async (
  output: ChildOutput,
  timeoutMs: number,
): Promise<ChildCloseResult> =>
  new Promise((resolve) => {
    const complete = (timedOut: boolean) => {
      clearTimeout(timer);
      output.child.off("close", onClose);
      resolve({
        timedOut,
        exitCode: output.child.exitCode,
        signalCode: output.child.signalCode,
        stdout: output.stdout.trim(),
        stderr: output.stderr.trim(),
      });
    };
    const onClose = () => complete(false);
    const timer = setTimeout(() => complete(true), timeoutMs);

    if (output.child.exitCode !== null || output.child.signalCode !== null) {
      complete(false);
      return;
    }

    output.child.once("close", onClose);
  });

const waitForMarker = async (
  markerPath: string,
  output: ChildOutput,
  timeoutMs: number,
): Promise<MarkerWaitResult> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(markerPath)) {
      return {
        markerFound: true,
        exitCode: output.child.exitCode,
        signalCode: output.child.signalCode,
        stdout: output.stdout.trim(),
        stderr: output.stderr.trim(),
      };
    }
    if (output.child.exitCode !== null || output.child.signalCode !== null) {
      return {
        markerFound: false,
        exitCode: output.child.exitCode,
        signalCode: output.child.signalCode,
        stdout: output.stdout.trim(),
        stderr: output.stderr.trim(),
      };
    }
    await delay(25);
  }
  return {
    markerFound: false,
    exitCode: output.child.exitCode,
    signalCode: output.child.signalCode,
    stdout: output.stdout.trim(),
    stderr: output.stderr.trim(),
  };
};

const killChild = async (output: ChildOutput): Promise<ChildCloseResult> => {
  if (output.child.exitCode === null && output.child.signalCode === null) {
    output.child.kill("SIGKILL");
  }
  return waitForChildClose(output, 5_000);
};

const disposeChildOutput = (output: ChildOutput): void => {
  output.child.stdout.destroy();
  output.child.stderr.destroy();
};

const runAcquireAttempt = async (dataDir: string): Promise<ChildCloseResult> => {
  const attempt = spawnScript(attemptScript, { EXECUTOR_TEST_DATA_DIR: dataDir });
  const result = await waitForChildClose(attempt, 5_000);
  disposeChildOutput(attempt);
  return result;
};

describe("data-dir ownership", () => {
  it("blocks a second process and releases ownership when the holder is SIGKILLed", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "executor-data-dir-ownership-"));
    const dataDir = join(workDir, "data # owned %3F");
    const marker = join(workDir, "owner-ready");
    const holder = spawnScript(holderScript, {
      EXECUTOR_TEST_DATA_DIR: dataDir,
      EXECUTOR_TEST_READY_MARKER: marker,
    });

    try {
      const ready = await waitForMarker(marker, holder, 10_000);
      expect(ready).toMatchObject({
        markerFound: true,
        exitCode: null,
        signalCode: null,
        stdout: "",
        stderr: "",
      });

      const expectedLockPath = join(realpathSync(dataDir), LOCK_DATABASE_FILENAME);
      const blocked = await runAcquireAttempt(dataDir);
      expect(blocked).toMatchObject({
        timedOut: false,
        exitCode: 0,
        signalCode: null,
        stdout: `HELD ${expectedLockPath}`,
        stderr: "",
      });

      const killed = await killChild(holder);
      expect(killed).toMatchObject({
        timedOut: false,
        exitCode: null,
        signalCode: "SIGKILL",
      });

      const acquiredAfterKill = await runAcquireAttempt(dataDir);
      expect(acquiredAfterKill).toMatchObject({
        timedOut: false,
        exitCode: 0,
        signalCode: null,
        stdout: `ACQUIRED ${expectedLockPath}`,
        stderr: "",
      });
    } finally {
      await killChild(holder);
      disposeChildOutput(holder);
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
