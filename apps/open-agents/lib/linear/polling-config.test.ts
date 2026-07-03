import { afterEach, describe, expect, test } from "bun:test";
import {
  areLinearWebhooksEnabled,
  getLinearPollLookbackMs,
  isLinearPollingSourceEnabled,
} from "./polling-config";

const ENV_KEYS = [
  "LINEAR_API_KEY",
  "LINEAR_ACCESS_TOKEN",
  "LINEAR_WEBHOOK_SECRET",
  "OPEN_AGENTS_LINEAR_PROJECTS",
  "OPEN_AGENTS_LINEAR_TEAMS",
  "OPEN_AGENTS_LINEAR_WEBHOOKS_ENABLED",
  "OPEN_AGENTS_LINEAR_POLLING_ENABLED",
  "OPEN_AGENTS_LINEAR_POLL_LOOKBACK_MS",
] as const;

const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

function resetEnv(): void {
  for (const key of ENV_KEYS) {
    const originalValue = originalEnv.get(key);
    if (originalValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalValue;
    }
  }
}

function clearEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

afterEach(() => {
  resetEnv();
});

describe("Linear polling config", () => {
  test("treats Linear webhooks as enabled when a webhook secret is configured", () => {
    clearEnv();
    process.env.LINEAR_WEBHOOK_SECRET = "secret";

    expect(areLinearWebhooksEnabled()).toBe(true);
  });

  test("keeps polling disabled by default while webhooks are enabled", () => {
    clearEnv();
    process.env.LINEAR_API_KEY = "lin_api_test";
    process.env.LINEAR_WEBHOOK_SECRET = "secret";
    process.env.OPEN_AGENTS_LINEAR_TEAMS = "VOI";

    expect(isLinearPollingSourceEnabled()).toBe(false);
  });

  test("enables polling when webhooks are disabled and Linear has auth and trigger config", () => {
    clearEnv();
    process.env.LINEAR_API_KEY = "lin_api_test";
    process.env.OPEN_AGENTS_LINEAR_WEBHOOKS_ENABLED = "false";
    process.env.OPEN_AGENTS_LINEAR_TEAMS = "VOI";

    expect(isLinearPollingSourceEnabled()).toBe(true);
  });

  test("allows explicit polling to override a configured webhook secret", () => {
    clearEnv();
    process.env.LINEAR_API_KEY = "lin_api_test";
    process.env.LINEAR_WEBHOOK_SECRET = "secret";
    process.env.OPEN_AGENTS_LINEAR_POLLING_ENABLED = "true";
    process.env.OPEN_AGENTS_LINEAR_TEAMS = "VOI";

    expect(isLinearPollingSourceEnabled()).toBe(true);
  });

  test("falls back to the default lookback when the env value is invalid", () => {
    clearEnv();
    process.env.OPEN_AGENTS_LINEAR_POLL_LOOKBACK_MS = "nope";

    expect(getLinearPollLookbackMs()).toBe(300_000);
  });
});
