import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Predicate, Result } from "effect";

import { ProviderKey } from "@executor-js/sdk";
import { makeTestWorkspaceHarness } from "@executor-js/sdk/testing";

import { fileSecretsPlugin } from "./index";

const FILE_PROVIDER = ProviderKey.make("file");

const inspectPlugin = (plugin: ReturnType<typeof fileSecretsPlugin>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const workspace = yield* makeTestWorkspaceHarness({ plugins: [plugin] as const });
      const items = yield* workspace.executor.providers.items(FILE_PROVIDER);
      return {
        filePath: workspace.executor.fileSecrets.filePath,
        itemIds: items.map((item) => String(item.id)),
      };
    }),
  );

const writeAuthFile = (filePath: string, contents: string, mode = 0o600): void => {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, { mode });
};

describe("file secrets auth location", () => {
  let workDir: string;
  let dataDir: string;
  let otherDataDir: string;
  let xdgDataHome: string;
  let overrideDir: string;
  let legacyFilePath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "executor-file-secrets-location-"));
    dataDir = join(workDir, "data");
    otherDataDir = join(workDir, "other-data");
    xdgDataHome = join(workDir, "xdg");
    overrideDir = join(workDir, "override");
    legacyFilePath = join(xdgDataHome, "executor", "auth.json");
    vi.stubEnv("XDG_DATA_HOME", xdgDataHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(workDir, { recursive: true, force: true });
  });

  it.effect("uses auth.json directly under EXECUTOR_DATA_DIR resolved at construction", () =>
    Effect.gen(function* () {
      vi.stubEnv("EXECUTOR_DATA_DIR", dataDir);
      const plugin = fileSecretsPlugin();
      vi.stubEnv("EXECUTOR_DATA_DIR", otherDataDir);

      const inspected = yield* inspectPlugin(plugin);

      expect(inspected.filePath).toBe(join(dataDir, "auth.json"));
    }),
  );

  it.effect("keeps the XDG location when EXECUTOR_DATA_DIR is unset", () =>
    Effect.gen(function* () {
      vi.stubEnv("EXECUTOR_DATA_DIR", "");

      const inspected = yield* inspectPlugin(fileSecretsPlugin());

      expect(inspected.filePath).toBe(legacyFilePath);
    }),
  );

  it.effect("gives an explicit directory precedence without migration", () =>
    Effect.gen(function* () {
      vi.stubEnv("EXECUTOR_DATA_DIR", dataDir);
      writeAuthFile(legacyFilePath, '{"legacy":"legacy-secret"}');

      const inspected = yield* inspectPlugin(fileSecretsPlugin({ directory: overrideDir }));

      expect(inspected.filePath).toBe(join(overrideDir, "auth.json"));
      expect(inspected.itemIds).toEqual([]);
      expect(existsSync(join(dataDir, "auth.json"))).toBe(false);
      expect(readFileSync(legacyFilePath, "utf8")).toBe('{"legacy":"legacy-secret"}');
    }),
  );

  it.effect("copies a valid legacy XDG file once and preserves 0600 permissions", () =>
    Effect.gen(function* () {
      vi.stubEnv("EXECUTOR_DATA_DIR", dataDir);
      const legacyContents = '{"legacy-token":"legacy-secret"}';
      writeAuthFile(legacyFilePath, legacyContents, 0o644);

      const inspected = yield* inspectPlugin(fileSecretsPlugin());
      const migratedFilePath = join(dataDir, "auth.json");

      expect(inspected.filePath).toBe(migratedFilePath);
      expect(inspected.itemIds).toEqual(["legacy-token"]);
      expect(readFileSync(migratedFilePath, "utf8")).toContain('"legacy-token": "legacy-secret"');
      expect(statSync(migratedFilePath).mode & 0o777).toBe(0o600);
      expect(readFileSync(legacyFilePath, "utf8")).toBe(legacyContents);
    }),
  );

  it.effect("uses an existing data-dir file without merging the legacy file", () =>
    Effect.gen(function* () {
      vi.stubEnv("EXECUTOR_DATA_DIR", dataDir);
      const activeFilePath = join(dataDir, "auth.json");
      const activeContents = '{"active-token":"active-secret"}';
      const legacyContents = '{"legacy-token":"legacy-secret"}';
      writeAuthFile(activeFilePath, activeContents);
      writeAuthFile(legacyFilePath, legacyContents);

      const inspected = yield* inspectPlugin(fileSecretsPlugin());

      expect(inspected.itemIds).toEqual(["active-token"]);
      expect(readFileSync(activeFilePath, "utf8")).toBe(activeContents);
      expect(readFileSync(legacyFilePath, "utf8")).toBe(legacyContents);
    }),
  );

  it.effect("leaves the new store empty when the legacy file is corrupt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.stubEnv("EXECUTOR_DATA_DIR", dataDir);
        writeAuthFile(legacyFilePath, "not-json");
        const workspace = yield* makeTestWorkspaceHarness({
          plugins: [fileSecretsPlugin()] as const,
        });

        const initial = yield* workspace.executor.providers.items(FILE_PROVIDER);
        expect(initial).toEqual([]);
        expect(existsSync(join(dataDir, "auth.json"))).toBe(false);
        expect(readFileSync(legacyFilePath, "utf8")).toBe("not-json");

        writeAuthFile(legacyFilePath, '{"repaired-token":"repaired-secret"}');
        const afterRepair = yield* workspace.executor.providers.items(FILE_PROVIDER);
        expect(afterRepair).toEqual([]);
        expect(existsSync(join(dataDir, "auth.json"))).toBe(false);
      }),
    ),
  );

  it.effect("retries migration after a legacy read I/O failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.stubEnv("EXECUTOR_DATA_DIR", dataDir);
        mkdirSync(legacyFilePath, { recursive: true });
        const workspace = yield* makeTestWorkspaceHarness({
          plugins: [fileSecretsPlugin()] as const,
        });

        const failed = yield* Effect.result(workspace.executor.providers.items(FILE_PROVIDER));
        expect(Result.isFailure(failed)).toBe(true);
        if (!Result.isFailure(failed)) return;
        expect(Predicate.isTagged("StorageError")(failed.failure)).toBe(true);

        rmSync(legacyFilePath, { recursive: true, force: true });
        writeAuthFile(legacyFilePath, '{"recovered-token":"recovered-secret"}');

        const recovered = yield* workspace.executor.providers.items(FILE_PROVIDER);
        expect(recovered.map((item) => String(item.id))).toEqual(["recovered-token"]);
        expect(readFileSync(join(dataDir, "auth.json"), "utf8")).toContain(
          '"recovered-token": "recovered-secret"',
        );
      }),
    ),
  );

  it.effect("shares one migration across concurrent first provider operations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.stubEnv("EXECUTOR_DATA_DIR", dataDir);
        const legacyContents = '{"legacy-token":"legacy-secret"}';
        writeAuthFile(legacyFilePath, legacyContents);
        const workspace = yield* makeTestWorkspaceHarness({
          plugins: [fileSecretsPlugin()] as const,
        });

        const results = yield* Effect.all(
          [
            workspace.executor.providers.items(FILE_PROVIDER),
            workspace.executor.providers.items(FILE_PROVIDER),
          ],
          { concurrency: "unbounded" },
        );

        expect(results.map((items) => items.map((item) => String(item.id)))).toEqual([
          ["legacy-token"],
          ["legacy-token"],
        ]);
        expect(readdirSync(dataDir)).toEqual(["auth.json"]);
        expect(readFileSync(legacyFilePath, "utf8")).toBe(legacyContents);
      }),
    ),
  );
});
