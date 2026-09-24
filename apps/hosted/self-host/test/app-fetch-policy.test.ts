import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect } from "effect";
import { allowPrivateAppFetch } from "../src/contracts/config.ts";

const decide = (environment: Record<string, string> = {}) =>
  Effect.runSync(
    allowPrivateAppFetch.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)),
    ),
  );

test("app code stays off private address space unless the operator opts in", () => {
  // The dashboard origin no longer matters: requests to it never use the network.
  for (const origin of [
    "http://localhost:4400",
    "http://192.168.1.10",
    "https://executor.example.com",
  ])
    assert.equal(decide({ BETTER_AUTH_URL: origin }), false);
});

test("an explicit setting decides private app fetch", () => {
  assert.equal(decide({ EXECUTOR_APPS_ALLOW_PRIVATE_FETCH: "true" }), true);
  assert.equal(decide({ EXECUTOR_APPS_ALLOW_PRIVATE_FETCH: "false" }), false);
});
