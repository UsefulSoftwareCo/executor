import { afterEach, describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Path } from "effect";
import * as Effect from "effect/Effect";

import { normalizeExecutorServerConnection } from "@executor-js/sdk/shared";
import {
  readLocalServerManifest,
  removeLocalServerManifestIfOwnedBy,
  resolveExecutorDataDir,
  writeLocalServerManifest,
} from "./local-server-manifest";

const previousDataDir = process.env.EXECUTOR_DATA_DIR;

afterEach(() => {
  if (previousDataDir === undefined) {
    delete process.env.EXECUTOR_DATA_DIR;
  } else {
    process.env.EXECUTOR_DATA_DIR = previousDataDir;
  }
});

describe("local server manifest", () => {
  it.effect("round-trips the active local server owner", () =>
    Effect.gen(function* () {
      const dataDir = mkdtempSync(join(tmpdir(), "executor-local-server-"));
      process.env.EXECUTOR_DATA_DIR = dataDir;

      try {
        const manifest = {
          version: 1 as const,
          kind: "cli-daemon" as const,
          pid: process.pid,
          startedAt: "2026-05-28T00:00:00.000Z",
          dataDir,
          scopeDir: dataDir,
          connection: normalizeExecutorServerConnection({
            origin: "http://localhost:4788",
          }),
          owner: {
            client: "cli" as const,
            version: "1.2.3",
            executablePath: "/usr/local/bin/executor",
          },
        };

        yield* writeLocalServerManifest(manifest);
        expect((yield* readLocalServerManifest())?.connection.origin).toBe("http://localhost:4788");

        yield* removeLocalServerManifestIfOwnedBy({ pid: process.pid + 1 });
        expect(yield* readLocalServerManifest()).not.toBeNull();

        yield* removeLocalServerManifestIfOwnedBy({ pid: process.pid });
        expect(yield* readLocalServerManifest()).toBeNull();
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("resolves the data dir from EXECUTOR_DATA_DIR", () =>
    Effect.gen(function* () {
      const dataDir = mkdtempSync(join(tmpdir(), "executor-local-server-dir-"));
      process.env.EXECUTOR_DATA_DIR = dataDir;

      try {
        const path = yield* Path.Path;
        expect(resolveExecutorDataDir(path)).toBe(dataDir);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
