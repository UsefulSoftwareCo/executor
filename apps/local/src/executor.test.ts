/* oxlint-disable executor/no-try-catch-or-throw -- test boundary: isolate process env and always dispose the shared executor handle */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { disposeExecutor, getExecutor, getExecutorBundle, reloadExecutor } from "./executor";

const withIsolatedExecutorDataDir = async (body: () => Promise<void>): Promise<void> => {
  const previousDataDir = process.env.EXECUTOR_DATA_DIR;
  const previousScopeDir = process.env.EXECUTOR_SCOPE_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), "executor-reload-race-"));

  process.env.EXECUTOR_DATA_DIR = dataDir;
  process.env.EXECUTOR_SCOPE_DIR = dataDir;

  try {
    await body();
  } finally {
    await disposeExecutor();
    if (previousDataDir === undefined) {
      delete process.env.EXECUTOR_DATA_DIR;
    } else {
      process.env.EXECUTOR_DATA_DIR = previousDataDir;
    }
    if (previousScopeDir === undefined) {
      delete process.env.EXECUTOR_SCOPE_DIR;
    } else {
      process.env.EXECUTOR_SCOPE_DIR = previousScopeDir;
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
};

describe("reloadExecutor", () => {
  it("waits for the previous owned database handle to release before reopening", async () => {
    await withIsolatedExecutorDataDir(async () => {
      await getExecutor();
      const executor = await reloadExecutor();
      expect(executor).toBeDefined();
    });
  });

  it("serializes new shared executor opens behind an in-flight dispose", async () => {
    await withIsolatedExecutorDataDir(async () => {
      await getExecutor();
      const disposing = disposeExecutor();
      const executor = await getExecutor();
      await disposing;
      expect(executor).toBeDefined();
    });
  });
});

describe("projected executors", () => {
  it("projects the shared executor while the bundle holds the data dir", async () => {
    await withIsolatedExecutorDataDir(async () => {
      const bundle = await getExecutorBundle();

      // The bundle holds the data dir's ownership lock (a `BEGIN EXCLUSIVE` on
      // `data.db.owner-lock`, per-connection, `busy_timeout = 0`) for its whole
      // lifetime. A projected view rides the SAME open handle; opening a
      // second owned database would hit SQLITE_BUSY against that lock — that
      // is what made every `/mcp/toolkits/<slug>` request 500.
      const projected = await Effect.runPromise(bundle.executor.project("scoped-slug"));

      // An unknown toolkit exposes nothing rather than everything.
      const tools = await Effect.runPromise(projected.tools.list());
      expect(tools).toEqual([]);
      await Effect.runPromise(projected.close());
    });
  });

  it("leaves the shared database open when a projected executor is closed", async () => {
    await withIsolatedExecutorDataDir(async () => {
      const bundle = await getExecutorBundle();
      const projected = await Effect.runPromise(bundle.executor.project("scoped-slug"));

      await Effect.runPromise(projected.close());

      // A projected view borrows the bundle's open handle, so closing one must
      // close its own plugins and nothing else. `createExecutor` closes the
      // database only when handed the owning `{ db, close }` wrapper, and the
      // projection is built over the bare handle. This read is what catches a
      // regression there.
      const integrations = await Effect.runPromise(bundle.executor.integrations.list());
      expect(Array.isArray(integrations)).toBe(true);
    });
  });
});
