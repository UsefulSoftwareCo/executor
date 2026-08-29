/* oxlint-disable executor/no-try-catch-or-throw -- test boundary: isolate process env and always dispose the shared executor handle */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  createExecutorHandle,
  disposeExecutor,
  getExecutor,
  getExecutorBundle,
  reloadExecutor,
} from "./executor";

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

describe("toolkit-scoped executors", () => {
  it("derives a toolkit-scoped executor while the shared bundle holds the data dir", async () => {
    await withIsolatedExecutorDataDir(async () => {
      const bundle = await getExecutorBundle();

      // The bundle holds the data dir's ownership lock (a `BEGIN EXCLUSIVE` on
      // `data.db.owner-lock`, per-connection, `busy_timeout = 0`) for its whole
      // lifetime. Building this executor without `borrowedDb` opens a second
      // owned database, which hits SQLITE_BUSY against that lock and rejects —
      // that is what made every `/mcp/toolkits/<slug>` request 500.
      const scoped = await createExecutorHandle({
        activeToolkitSlug: "scoped-slug",
        borrowedDb: bundle.db,
      });

      expect(scoped.executor).toBeDefined();
      await scoped.dispose();
    });
  });

  it("leaves the shared database open when a scoped executor is disposed", async () => {
    await withIsolatedExecutorDataDir(async () => {
      const bundle = await getExecutorBundle();
      const scoped = await createExecutorHandle({
        activeToolkitSlug: "scoped-slug",
        borrowedDb: bundle.db,
      });

      await scoped.dispose();

      // A scoped executor borrows the bundle's open handle, so disposing one
      // must close its own plugins and nothing else. `createExecutor` closes the
      // database only when it was handed the owning `{ db, close }` wrapper, so
      // the layer passes the inner handle (`sqlite.db`) instead. Hand it the
      // wrapper and the daemon loses `/mcp` and `/api` the moment any toolkit
      // session ends — the type system does not catch the swap, because
      // `SqliteFumaDb` structurally satisfies `ExecutorDb`. This read is what
      // catches it.
      const integrations = await Effect.runPromise(bundle.executor.integrations.list());
      expect(Array.isArray(integrations)).toBe(true);
    });
  });
});
