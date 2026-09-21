import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect } from "effect";
import { allowPrivateAppFetch } from "../src/contracts/config.ts";

const decide = (origin: string, environment: Record<string, string> = {}) =>
  Effect.runSync(
    allowPrivateAppFetch(origin).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)),
    ),
  );

test("a public dashboard origin keeps app code off private address space", () => {
  for (const origin of ["https://executor.example.com", "https://apps.example.com:8443"])
    assert.equal(decide(origin), false);
});

test("a dashboard origin the destination rule refuses enables private app fetch", () => {
  for (const origin of [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://192.168.1.10:3000",
    "http://10.1.2.3",
    "http://executor:3000",
    "http://executor.internal:3000",
    "https://[::1]:3000",
  ])
    assert.equal(decide(origin), true);
});

test("an explicit setting wins over the derived default", () => {
  assert.equal(
    decide("http://localhost:3000", { EXECUTOR_APPS_ALLOW_PRIVATE_FETCH: "false" }),
    false,
  );
  assert.equal(
    decide("https://executor.example.com", { EXECUTOR_APPS_ALLOW_PRIVATE_FETCH: "true" }),
    true,
  );
});
