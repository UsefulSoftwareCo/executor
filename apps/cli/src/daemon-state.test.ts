import { afterEach, describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";

import {
  canonicalDaemonHost,
  currentDaemonScopeId,
  readDaemonPointer,
  writeDaemonPointer,
} from "./daemon-state";

const previousDataDir = process.env.EXECUTOR_DATA_DIR;
const previousScopeDir = process.env.EXECUTOR_SCOPE_DIR;
const originalCwd = process.cwd();

afterEach(() => {
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

  process.chdir(originalCwd);
});

describe("daemon host and scope identity", () => {
  it("does not collapse wildcard binds into loopback pointers", () => {
    expect(canonicalDaemonHost("127.0.0.1")).toBe("localhost");
    expect(canonicalDaemonHost("0.0.0.0")).toBe("0.0.0.0");
  });

  it("resolves relative scope directories against the current workspace", () => {
    const workspace = mkdtempSync(join(tmpdir(), "executor-daemon-scope-"));
    try {
      process.chdir(workspace);
      process.env.EXECUTOR_SCOPE_DIR = "executor.jsonc";

      expect(currentDaemonScopeId()).toBe(`scope:${join(workspace, "executor.jsonc")}`);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it.effect("keeps daemon pointers distinct for scope ids with the same sanitized form", () =>
    Effect.gen(function* () {
      const dataDir = mkdtempSync(join(tmpdir(), "executor-daemon-state-"));
      process.env.EXECUTOR_DATA_DIR = dataDir;

      try {
        const firstScope = "scope:/workspace/app";
        const secondScope = "scope:_workspace_app";

        yield* writeDaemonPointer({
          hostname: "localhost",
          port: 4788,
          pid: process.pid,
          scopeId: firstScope,
          scopeDir: "/workspace/app",
          token: "first-token",
        });
        yield* writeDaemonPointer({
          hostname: "localhost",
          port: 4789,
          pid: process.pid,
          scopeId: secondScope,
          scopeDir: "_workspace_app",
          token: "second-token",
        });

        const first = yield* readDaemonPointer({ hostname: "localhost", scopeId: firstScope });
        const second = yield* readDaemonPointer({ hostname: "localhost", scopeId: secondScope });

        expect(first?.port).toBe(4788);
        expect(first?.token).toBe("first-token");
        expect(second?.port).toBe(4789);
        expect(second?.token).toBe("second-token");
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
