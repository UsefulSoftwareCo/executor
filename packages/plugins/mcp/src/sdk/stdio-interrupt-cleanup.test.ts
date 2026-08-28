// Regression coverage for #1631: interrupting a fiber mid-dial (an HTTP 499
// cancelling a health check on app refresh, or the discovery timeout) must
// tear down the stdio child the transport spawned. Before the fix the
// abandoned `client.connect` promise kept the child alive forever; every
// interrupted health check stranded one `docker run -i --rm` container.
//
// `it.live`: these tests measure real child-process lifetime, so they need
// the wall clock; under the TestClock the fixture's delayed initialize
// reply and the discovery timeout would never fire.

import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber } from "effect";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createMcpConnector } from "./connection";
import { discoverTools } from "./discover";

const fixture = fileURLToPath(new URL("./stdio-interrupt-test-server.ts", import.meta.url));

const isAlive = (pid: number): boolean => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: process.kill(pid, 0) reports "process gone" only by throwing ESRCH
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const killQuietly = (pid: number): void => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: kill throws ESRCH when the child already exited, which is the desired state
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
};

const waitUntil = (predicate: () => boolean, timeoutMs: number) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) return false;
      yield* Effect.sleep(Duration.millis(50));
    }
    return true;
  });

const makeFixture = (mode: "fast" | "slow" | "never") => {
  const pidFile = join(mkdtempSync(join(tmpdir(), "mcp-stdio-interrupt-")), "pid");
  const connector = createMcpConnector({
    transport: "stdio",
    command: "bun",
    args: ["run", fixture, pidFile, mode],
  });
  const spawned = waitUntil(() => existsSync(pidFile), 10_000);
  const readPid = () => Number(readFileSync(pidFile, "utf8"));
  return { connector, spawned, readPid };
};

// The transport's teardown ends stdin first and escalates to SIGTERM only
// after 2s, so a cleaned-up child can legitimately take a moment to exit.
const exitsAfterCleanup = (pid: number) =>
  Effect.gen(function* () {
    const exited = yield* waitUntil(() => !isAlive(pid), 5_000);
    killQuietly(pid);
    return exited;
  });

describe("stdio child cleanup on interruption (#1631)", () => {
  it.live("uninterrupted discovery closes the child", () =>
    Effect.gen(function* () {
      const { connector, spawned, readPid } = makeFixture("fast");
      const manifest = yield* discoverTools(connector);
      expect(manifest.tools).toEqual([]);
      expect(yield* spawned).toBe(true);
      expect(yield* exitsAfterCleanup(readPid())).toBe(true);
    }),
  );

  it.live("interrupting mid-handshake kills the child", () =>
    Effect.gen(function* () {
      const { connector, spawned, readPid } = makeFixture("slow");
      const fiber = yield* discoverTools(connector).pipe(Effect.forkDetach);

      expect(yield* spawned).toBe(true);
      const pid = readPid();
      expect(isAlive(pid)).toBe(true);

      // The initialize reply arrives at t+3s, so the handshake is still in
      // flight; cancel the fiber the way the HTTP layer does on a 499.
      yield* Effect.sleep(Duration.millis(200));
      yield* Fiber.interrupt(fiber);

      expect(yield* exitsAfterCleanup(pid)).toBe(true);
    }),
  );

  it.live("the discovery timeout kills the child", () =>
    Effect.gen(function* () {
      const { connector, spawned, readPid } = makeFixture("never");
      const failure = yield* discoverTools(connector, 1_000).pipe(Effect.flip);
      expect(failure.message).toContain("timed out");

      expect(yield* spawned).toBe(true);
      expect(yield* exitsAfterCleanup(readPid())).toBe(true);
    }),
  );
});
