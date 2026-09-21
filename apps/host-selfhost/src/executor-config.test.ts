import { afterEach, beforeEach, expect, test } from "@effect/vitest";

import { loadConfig } from "./config";
import executorConfig from "../executor.config";

const ENV_NAME = "EXECUTOR_ALLOW_STDIO_MCP";
const SECRET_ENV_NAME = "EXECUTOR_SECRET_KEY";
const TTL_ENV_NAME = "EXECUTOR_TOOLS_SYNC_TTL_MS";
const CIMD_ENV_NAME = "EXECUTOR_OAUTH_CIMD_ENABLED";
const originalValue = process.env[ENV_NAME];
const originalSecret = process.env[SECRET_ENV_NAME];
const originalTtl = process.env[TTL_ENV_NAME];
const originalCimd = process.env[CIMD_ENV_NAME];
const RATE_LIMIT_ENV_NAME = "EXECUTOR_DISABLE_AUTH_RATE_LIMIT";
const originalRateLimit = process.env[RATE_LIMIT_ENV_NAME];

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
  if (originalTtl === undefined) {
    delete process.env[TTL_ENV_NAME];
  } else {
    process.env[TTL_ENV_NAME] = originalTtl;
  }
  if (originalCimd === undefined) {
    delete process.env[CIMD_ENV_NAME];
  } else {
    process.env[CIMD_ENV_NAME] = originalCimd;
  }
  if (originalRateLimit === undefined) {
    delete process.env[RATE_LIMIT_ENV_NAME];
  } else {
    process.env[RATE_LIMIT_ENV_NAME] = originalRateLimit;
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

test("an unset tools-sync TTL leaves the SDK default in place", () => {
  delete process.env[TTL_ENV_NAME];
  expect(loadConfig().toolsSyncTtlMs).toBeUndefined();

  process.env[TTL_ENV_NAME] = "   ";
  expect(loadConfig().toolsSyncTtlMs).toBeUndefined();
});

test("a positive tools-sync TTL is forwarded verbatim", () => {
  process.env[TTL_ENV_NAME] = "60000";
  expect(loadConfig().toolsSyncTtlMs).toBe(60000);
});

// 0 keeps the SDK's own meaning — every catalog is expired on every read —
// so the env var never means the opposite of the config field it feeds.
test("a zero tools-sync TTL forwards as the SDK's always-stale 0", () => {
  process.env[TTL_ENV_NAME] = "0";
  expect(loadConfig().toolsSyncTtlMs).toBe(0);
});

// Case-insensitive: the disable tokens are operator intent, not a keyword, and
// "OFF" typed in a systemd unit means what "off" means in a .env file.
test.each(["off", "null", "false", "OFF", "Null", "FALSE", "  Off  "])(
  "the tools-sync TTL is disabled by %s",
  (raw) => {
    process.env[TTL_ENV_NAME] = raw;
    expect(loadConfig().toolsSyncTtlMs).toBeNull();
  },
);

// A typo'd knob must not silently degrade into the 15-minute default; the
// operator finds out at boot instead of wondering why catalogs never refresh.
// "9007199254740993" and "1e30" are whole numbers that no longer round-trip
// through a double — accepting them would boot a TTL the operator never wrote.
test.each(["abc", "60_000", "1.5", "1e3ms", "NaN", "Infinity", "9007199254740993", "1e30"])(
  "a malformed tools-sync TTL (%s) refuses to boot",
  (raw) => {
    process.env[TTL_ENV_NAME] = raw;
    expect(() => loadConfig()).toThrow(/EXECUTOR_TOOLS_SYNC_TTL_MS/);
  },
);

test("a negative tools-sync TTL refuses to boot", () => {
  process.env[TTL_ENV_NAME] = "-1";
  expect(() => loadConfig()).toThrow(/must not be negative/);
});

test("CIMD serving is enabled when the knob is unset", () => {
  delete process.env[CIMD_ENV_NAME];
  expect(loadConfig().oauthCimdEnabled).toBe(true);
});

test("CIMD serving is disabled by false", () => {
  process.env[CIMD_ENV_NAME] = "false";
  expect(loadConfig().oauthCimdEnabled).toBe(false);
});

test("CIMD serving is enabled by true", () => {
  process.env[CIMD_ENV_NAME] = "true";
  expect(loadConfig().oauthCimdEnabled).toBe(true);
});

test.each(["disabled", "TRUE", "FALSE", "", "   ", " true", "true ", " false", "false "])(
  "a malformed CIMD serving knob (%j) refuses to boot",
  (raw) => {
    process.env[CIMD_ENV_NAME] = raw;
    expect(() => loadConfig()).toThrow(
      `EXECUTOR_OAUTH_CIMD_ENABLED ${JSON.stringify(raw)} must be "true" or "false"`,
    );
  },
);

test("auth rate limiting stays on unless the opt-out is exactly true", () => {
  delete process.env[RATE_LIMIT_ENV_NAME];
  expect(loadConfig().authRateLimit).toBe(true);
  process.env[RATE_LIMIT_ENV_NAME] = "TRUE";
  expect(loadConfig().authRateLimit).toBe(true);
});

test("auth rate limiting is off when the opt-out is exactly true", () => {
  process.env[RATE_LIMIT_ENV_NAME] = "true";
  expect(loadConfig().authRateLimit).toBe(false);
});
