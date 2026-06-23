import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { Subject, Tenant } from "./ids";
import { ExecutionFinished, ExecutionId, composeExecutionObservers, definePlugin } from "./index";

const owner = { tenant: Tenant.make("tenant_test"), subject: Subject.make("subject_test") };

let calls: string[] = [];

const observingPlugin = (id: string, asyncBoundary = false) =>
  definePlugin(() => ({
    id,
    storage: () => ({}),
    extension: () => ({ label: id }),
    runtime: {
      executionObserver: (self: { label: string }) => ({
        handle: () =>
          (asyncBoundary ? Effect.promise(() => Promise.resolve()) : Effect.void).pipe(
            Effect.flatMap(() => Effect.sync(() => calls.push(self.label))),
          ),
      }),
    },
  }));

const failingPlugin = definePlugin(() => ({
  id: "failing" as const,
  storage: () => ({}),
  extension: () => ({ label: "failing" }),
  runtime: {
    executionObserver: () => ({
      handle: () => Effect.die("observer failed"),
    }),
  },
}));

const finishedEvent = () =>
  new ExecutionFinished({
    executionId: ExecutionId.make("exec_test"),
    owner,
    status: "completed",
    result: "ok",
    completedAt: new Date(),
  });

describe("composeExecutionObservers", () => {
  it.effect("dispatches observers sequentially and isolates failures", () =>
    Effect.gen(function* () {
      calls = [];
      const first = observingPlugin("first", true)();
      const failing = failingPlugin();
      const last = observingPlugin("last")();
      const observer = composeExecutionObservers([first, failing, last] as const, {
        first: { label: "first" },
        failing: { label: "failing" },
        last: { label: "last" },
      });

      // The failing plugin dies mid-dispatch; the others must still observe.
      yield* observer.handle(finishedEvent());

      expect(calls).toEqual(["first", "last"]);
    }),
  );

  it.effect("returns a no-op observer when no plugin registers one", () =>
    Effect.gen(function* () {
      const plain = definePlugin(() => ({ id: "plain", storage: () => ({}) }))();
      const observer = composeExecutionObservers([plain] as const, { plain: {} });

      // No observer registered: handling is a no-op and never throws.
      yield* observer.handle(finishedEvent());
    }),
  );
});
