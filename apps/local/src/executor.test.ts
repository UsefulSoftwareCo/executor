/* oxlint-disable executor/no-try-catch-or-throw -- test boundary: isolate process env and always dispose the shared executor handle */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { disposeExecutor, getExecutor, reloadExecutor } from "./executor";

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
