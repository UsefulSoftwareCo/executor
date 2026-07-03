import { afterEach, beforeEach, describe, expect, test } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  definePlugin,
} from "@executor-js/sdk";
import { migratedItemId } from "@executor-js/sdk/migration";
import { makeTestExecutor } from "@executor-js/sdk/testing";

import { fileSecretsPlugin } from "./index";

const AuthFile = Schema.Record(Schema.String, Schema.String);
const decodeAuthFile = Schema.decodeUnknownSync(Schema.fromJsonString(AuthFile));
const INTEGRATION = IntegrationSlug.make("linear");
const TEMPLATE = AuthTemplateSlug.make("apiKey");
const CONNECTION_ITEM_ID = "connection:org:linear:main:token";

const testIntegrationPlugin = definePlugin(() => ({
  id: "fileSecretsTest" as const,
  storage: () => ({}),
  extension: (ctx) => ({
    seed: () =>
      ctx.core.integrations.register({
        slug: INTEGRATION,
        description: "Linear",
        config: {},
      }),
  }),
}))();

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "executor-file-secrets-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const authPath = () => join(directory, "auth.json");

const writeAuth = (value: unknown) => {
  mkdirSync(directory, { recursive: true });
  writeFileSync(authPath(), JSON.stringify(value, null, 2));
};

const readAuth = (): Record<string, string> => decodeAuthFile(readFileSync(authPath(), "utf-8"));

const createConnection = (value: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [fileSecretsPlugin({ directory }), testIntegrationPlugin] as const,
      });
      yield* executor.fileSecretsTest.seed();
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: INTEGRATION,
        template: TEMPLATE,
        value,
      });
    }),
  );

describe("file secrets provider", () => {
  test("normalizes a scoped auth file before writing a new item", async () => {
    const scopeId = "user-org:user_U:org_O";
    writeAuth({
      current: "current-value",
      [scopeId]: {
        "linear-access": "legacy-access-token",
        "linear-refresh": "legacy-refresh-token",
      },
    });

    await Effect.runPromise(createConnection("new-access-token"));

    const auth = readAuth();
    expect(auth).toEqual({
      [migratedItemId(scopeId, "linear-access")]: "legacy-access-token",
      [migratedItemId(scopeId, "linear-refresh")]: "legacy-refresh-token",
      current: "current-value",
      [CONNECTION_ITEM_ID]: "new-access-token",
    });
  });

  test("keeps existing flat values authoritative when removing scoped blocks", async () => {
    const scopeId = "org_123";
    const migrated = migratedItemId(scopeId, "api-key");
    writeAuth({
      [migrated]: "current-secret",
      [scopeId]: { "api-key": "stale-scoped-secret" },
    });

    await Effect.runPromise(createConnection("new-secret"));

    expect(readAuth()).toEqual({
      [migrated]: "current-secret",
      [CONNECTION_ITEM_ID]: "new-secret",
    });
  });

  test("malformed auth files still fail instead of being overwritten", async () => {
    writeAuth({ current: 42 });

    await expect(Effect.runPromise(createConnection("new-secret"))).rejects.toMatchObject({
      message: "Failed to parse auth file",
    });
    expect(existsSync(authPath())).toBe(true);
  });
});
