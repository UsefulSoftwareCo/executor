import { expect, test } from "@effect/vitest";

import {
  assertManagedSecretsConfigured,
  loadConfig,
  resolveAuthSecret,
  resolveDatabaseConfig,
  resolveMcpMode,
  resolveSecretKey,
} from "./config";

test("database config defaults to a file in the data directory", () => {
  expect(resolveDatabaseConfig({ EXECUTOR_DATA_DIR: "/var/executor" })).toEqual({
    kind: "file",
    path: "/var/executor/data.db",
  });
});

test("Executor remote database variables take precedence over Turso aliases", () => {
  expect(
    resolveDatabaseConfig({
      EXECUTOR_DB_URL: "libsql://executor.example.com",
      EXECUTOR_DB_AUTH_TOKEN: "executor-token",
      TURSO_DATABASE_URL: "libsql://turso.example.com",
      TURSO_AUTH_TOKEN: "turso-token",
      EXECUTOR_DB_PATH: "/ignored.db",
    }),
  ).toEqual({
    kind: "remote",
    url: "libsql://executor.example.com",
    authToken: "executor-token",
  });
});

test("Turso marketplace variables configure remote libSQL", () => {
  expect(
    resolveDatabaseConfig({
      TURSO_DATABASE_URL: "libsql://executor-example.turso.io",
      TURSO_AUTH_TOKEN: "turso-token",
    }),
  ).toEqual({
    kind: "remote",
    url: "libsql://executor-example.turso.io",
    authToken: "turso-token",
  });
});

test("blank Executor variables do not shadow Turso marketplace variables", () => {
  expect(
    resolveDatabaseConfig({
      EXECUTOR_DB_URL: "   ",
      EXECUTOR_DB_AUTH_TOKEN: "",
      TURSO_DATABASE_URL: "libsql://executor-example.turso.io",
      TURSO_AUTH_TOKEN: "turso-token",
    }),
  ).toEqual({
    kind: "remote",
    url: "libsql://executor-example.turso.io",
    authToken: "turso-token",
  });
});

test("remote database credentials fail fast when incomplete or invalid", () => {
  expect(() => resolveDatabaseConfig({ TURSO_AUTH_TOKEN: "orphaned-token" })).toThrow(
    /requires.*URL/,
  );
  expect(() => resolveDatabaseConfig({ EXECUTOR_DB_URL: "not a URL" })).toThrow(/absolute URL/);
  expect(() => resolveDatabaseConfig({ EXECUTOR_DB_URL: "file:///tmp/data.db" })).toThrow(
    /must use libsql/,
  );
});

test("MCP mode defaults to stateful and validates explicit stateless mode", () => {
  expect(resolveMcpMode({})).toBe("stateful");
  expect(resolveMcpMode({ EXECUTOR_MCP_MODE: "stateless" })).toBe("stateless");
  expect(() => resolveMcpMode({ EXECUTOR_MCP_MODE: "serverless" })).toThrow(/stateful.*stateless/);
});

test("stateless mode requires a remote database", () => {
  expect(() => resolveDatabaseConfig({ EXECUTOR_MCP_MODE: "stateless" })).toThrow(
    /database.*required.*stateless/i,
  );
  expect(
    resolveDatabaseConfig({
      EXECUTOR_MCP_MODE: "stateless",
      TURSO_DATABASE_URL: "libsql://executor-example.turso.io",
    }),
  ).toEqual({
    kind: "remote",
    url: "libsql://executor-example.turso.io",
  });
});

test("explicit local app overrides ignore ambient remote and stateless database settings", () => {
  const database = { kind: "file", path: "/tmp/executor-test.db" } as const;
  const config = loadConfig({
    env: {
      EXECUTOR_DB_URL: "not a URL",
      EXECUTOR_MCP_MODE: "stateless",
      BETTER_AUTH_SECRET: "test-auth-secret-with-at-least-32-characters",
    },
    database,
    mcpMode: "stateful",
  });

  expect(config.database).toEqual(database);
  expect(config.mcpMode).toBe("stateful");
});

test("managed-secret guard fails closed on request-isolated hosts", () => {
  expect(() =>
    assertManagedSecretsConfigured({
      EXECUTOR_REQUIRE_MANAGED_SECRETS: "true",
    }),
  ).toThrow(/BETTER_AUTH_SECRET.*EXECUTOR_SECRET_KEY/);
  expect(() =>
    assertManagedSecretsConfigured({
      EXECUTOR_REQUIRE_MANAGED_SECRETS: "true",
      BETTER_AUTH_SECRET: "session-secret",
      EXECUTOR_SECRET_KEY: "encryption-key",
    }),
  ).not.toThrow();
  expect(() => assertManagedSecretsConfigured({})).not.toThrow();
  expect(() => assertManagedSecretsConfigured({ EXECUTOR_MCP_MODE: "stateless" })).toThrow(
    /BETTER_AUTH_SECRET.*EXECUTOR_SECRET_KEY/,
  );
  expect(() =>
    assertManagedSecretsConfigured({}, "stateful", {
      kind: "remote",
      url: "libsql://executor-example.turso.io",
    }),
  ).toThrow(/BETTER_AUTH_SECRET.*EXECUTOR_SECRET_KEY/);
});

test("custom env overrides resolve secrets independently", () => {
  expect(resolveAuthSecret({ BETTER_AUTH_SECRET: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).toBe(
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  expect(resolveAuthSecret({ BETTER_AUTH_SECRET: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })).toBe(
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );
  expect(resolveSecretKey({ EXECUTOR_SECRET_KEY: "first-key" })).toBe("first-key");
  expect(resolveSecretKey({ EXECUTOR_SECRET_KEY: "second-key" })).toBe("second-key");
});
