import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { Effect } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderKey,
  definePlugin,
} from "@executor-js/sdk";
import { makeTestWorkspaceHarness } from "@executor-js/sdk/testing";

import { fileSecretsPlugin } from "./index";

const INTEGRATION = IntegrationSlug.make("durable-secrets");
const CONNECTION = ConnectionName.make("main");
const TEMPLATE = AuthTemplateSlug.make("apiKey");
const CREDENTIAL = "secret-token";

const connectionFixturePlugin = definePlugin(() => ({
  id: "connectionFixture" as const,
  storage: () => ({}),
  resolveTools: () => Effect.succeed({ tools: [] }),
  extension: (ctx) => ({
    registerIntegration: () =>
      ctx.core.integrations.register({
        slug: INTEGRATION,
        description: "Durable secrets test integration",
        config: {},
      }),
    resolveCredential: () =>
      ctx.connections.resolveValue({
        owner: "org",
        integration: INTEGRATION,
        name: CONNECTION,
      }),
  }),
}))();

const plugins = () => [fileSecretsPlugin(), connectionFixturePlugin] as const;

describe("file secrets data directory", () => {
  let workDir: string;
  let dataDir: string;
  let firstSandboxDataHome: string;
  let recreatedSandboxDataHome: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "executor-file-secrets-data-dir-"));
    dataDir = join(workDir, "executor-data");
    firstSandboxDataHome = join(workDir, "sandbox-a-xdg");
    recreatedSandboxDataHome = join(workDir, "sandbox-b-xdg");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(firstSandboxDataHome, { recursive: true });
    mkdirSync(recreatedSandboxDataHome, { recursive: true });
    vi.stubEnv("EXECUTOR_DATA_DIR", dataDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(workDir, { recursive: true, force: true });
  });

  it.effect("keeps credentials when only EXECUTOR_DATA_DIR survives sandbox recreation", () =>
    Effect.gen(function* () {
      vi.stubEnv("XDG_DATA_HOME", firstSandboxDataHome);
      const firstAuthPath = yield* Effect.scoped(
        Effect.gen(function* () {
          const first = yield* makeTestWorkspaceHarness({ dataDir, plugins: plugins() });
          yield* first.executor.connectionFixture.registerIntegration();
          const connection = yield* first.executor.connections.create({
            owner: "org",
            name: CONNECTION,
            integration: INTEGRATION,
            template: TEMPLATE,
            value: CREDENTIAL,
          });

          expect(connection.provider).toBe(ProviderKey.make("file"));
          const authPath = first.executor.fileSecrets.filePath;
          const pathWithinDataDir = relative(dataDir, authPath);
          if (pathWithinDataDir.startsWith("..") || isAbsolute(pathWithinDataDir)) {
            expect(authPath).toBe(join(firstSandboxDataHome, "executor", "auth.json"));
          }
          expect(existsSync(authPath)).toBe(true);
          expect(readFileSync(authPath, "utf8")).toContain(
            '"connection:org:durable-secrets:main:token": "secret-token"',
          );
          expect(existsSync(join(dataDir, "test.db"))).toBe(true);
          return authPath;
        }),
      );

      vi.stubEnv("XDG_DATA_HOME", recreatedSandboxDataHome);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const recreated = yield* makeTestWorkspaceHarness({ dataDir, plugins: plugins() });
          const connections = yield* recreated.executor.connections.list({
            integration: INTEGRATION,
          });
          expect(connections.map((connection) => String(connection.name))).toEqual(["main"]);

          const resolved = yield* recreated.executor.connectionFixture.resolveCredential();

          // Regression: auth.json follows XDG_DATA_HOME instead of EXECUTOR_DATA_DIR.
          // After the fix it must live with test.db under dataDir and survive this home swap.
          expect(
            resolved,
            `credential persisted in ${firstAuthPath} was not available after recreating the sandbox with ${dataDir}`,
          ).toBe(CREDENTIAL);
        }),
      );
    }),
  );
});
