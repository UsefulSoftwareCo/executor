import { afterEach, beforeEach, expect, test } from "@effect/vitest";

import executorConfig from "../executor.config";

const ENV_NAME = "EXECUTOR_ALLOW_STDIO_MCP";
const SECRET_ENV_NAME = "EXECUTOR_SECRET_KEY";
const originalValue = process.env[ENV_NAME];
const originalSecret = process.env[SECRET_ENV_NAME];

beforeEach(() => {
  process.env[SECRET_ENV_NAME] = originalSecret ?? "executor-config-test-secret";
});

afterEach(() => {
  if (originalValue === undefined) {
    delete process.env[ENV_NAME];
  } else {
    process.env[ENV_NAME] = originalValue;
  }
  if (originalSecret === undefined) {
    delete process.env[SECRET_ENV_NAME];
  } else {
    process.env[SECRET_ENV_NAME] = originalSecret;
  }
});

const allowStdio = (): boolean => {
  const mcp = executorConfig.plugins().find((plugin) => plugin.id === "mcp");
  expect(mcp).toBeDefined();
  const clientConfig = mcp?.clientConfig;
  if (
    clientConfig &&
    typeof clientConfig === "object" &&
    "allowStdio" in clientConfig &&
    typeof clientConfig.allowStdio === "boolean"
  ) {
    return clientConfig.allowStdio;
  }
  expect.fail("MCP plugin did not expose its stdio setting");
  return false;
};

test("stdio MCP stays disabled when the opt-in is absent", () => {
  delete process.env[ENV_NAME];
  expect(allowStdio()).toBe(false);
});

test("stdio MCP stays disabled unless the opt-in is exactly true", () => {
  process.env[ENV_NAME] = "false";
  expect(allowStdio()).toBe(false);

  process.env[ENV_NAME] = "TRUE";
  expect(allowStdio()).toBe(false);
});

test("stdio MCP is enabled when the opt-in is exactly true", () => {
  process.env[ENV_NAME] = "true";
  expect(allowStdio()).toBe(true);
});
