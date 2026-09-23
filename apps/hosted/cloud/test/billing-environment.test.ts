import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Exit, Redacted } from "effect";
import type { BillingEnvironment } from "../src/contracts/billing-catalog.ts";
import { assertKeyEnvironment } from "../src/infrastructure/billing.ts";

const check = (key: string, environment: BillingEnvironment) =>
  Effect.runSyncExit(assertKeyEnvironment(Redacted.make(key), environment));

test("a key serves only the catalog of its own Autumn environment", () => {
  assert.ok(Exit.isSuccess(check("am_sk_live_synthetic", "live")));
  assert.ok(Exit.isSuccess(check("am_sk_test_synthetic", "sandbox")));
  assert.ok(Exit.isFailure(check("am_sk_live_synthetic", "sandbox")));
  assert.ok(Exit.isFailure(check("am_sk_test_synthetic", "live")));
});

test("a key without an Autumn environment prefix is refused for every catalog", () => {
  for (const key of ["emu_autumn_synthetic", "synthetic", "", "AM_SK_LIVE_synthetic"])
    for (const environment of ["sandbox", "live"] as const)
      assert.ok(Exit.isFailure(check(key, environment)), `${key} / ${environment}`);
});
