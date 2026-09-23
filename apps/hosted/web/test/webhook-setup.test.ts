/** A completed setup must never redisplay its signing secret when the follow-up read fails. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { WebhookSubscription, type WebhookSetupView } from "@executor-js/sdk";
import { webhookSetupAtoms } from "@executor-js/ui/contracts/webhook-setup";

class ReadUnavailable extends Schema.TaggedError<ReadUnavailable>()("ReadUnavailable", {}) {}
const subscription = Schema.decodeUnknownSync(WebhookSubscription)({
  id: "whk_fixture",
  app: "app_fixture",
  owner: "fixture",
  key: "events",
  deployment: "dpl_fixture",
  name: "events",
  sourceAccount: "acc_fixture",
  callbackUrl: "https://callback.example.test/events",
  accounts: { service: "acc_fixture" },
  status: "setup-required",
  failure: null,
  createdAt: new Date(0),
});
test("confirmed activation clears secret-bearing query state even if reconciliation fails", async () => {
  let committed = false;
  const initial: WebhookSetupView = {
    step: "configure",
    subscription,
    revision: "first",
    instructions: "Set up provider.",
    stateSchema: { type: "object", properties: {} },
    signingSecret: { source: "executor", value: Redacted.make("synthetic-signing-secret") },
  };
  const atoms = webhookSetupAtoms(Atom.runtime(Layer.empty), {
    read: Effect.suspend(() =>
      committed ? Effect.fail(new ReadUnavailable()) : Effect.succeed(initial),
    ),
    complete: () =>
      Effect.sync(() => {
        committed = true;
        return { ...subscription, status: "active" as const };
      }),
    remove: Effect.succeed({ ...subscription, status: "disabled" as const }),
    confirmRemoval: Effect.succeed({ ...subscription, status: "stopped" as const }),
  });
  const registry = AtomRegistry.make();
  const unmount = registry.mount(atoms.details);
  try {
    const before = await Effect.runPromise(
      AtomRegistry.getResult(registry, atoms.details, { suspendOnWaiting: true }),
    );
    assert.equal(before.step, "configure");
    registry.set(atoms.complete, { revision: "first", state: Redacted.make({}) });
    await Effect.runPromise(
      AtomRegistry.getResult(registry, atoms.complete, { suspendOnWaiting: true }),
    );
    await assert.rejects(
      Effect.runPromise(
        AtomRegistry.getResult(registry, atoms.details, { suspendOnWaiting: true }),
      ),
      Schema.is(ReadUnavailable),
    );
    const current = registry.get(atoms.details);
    assert.ok(AsyncResult.isFailure(current));
    const confirmed = Option.getOrThrow(AsyncResult.value(current));
    assert.equal(confirmed.step, "done");
    assert.equal(confirmed.subscription.status, "active");
    assert.ok(!JSON.stringify(confirmed).includes("signingSecret"));
  } finally {
    unmount();
    registry.dispose();
  }
});
