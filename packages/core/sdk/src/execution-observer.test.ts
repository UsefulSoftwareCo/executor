import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";

import { Subject, Tenant } from "./ids";
import {
  ExecutionFinished,
  ExecutionId,
  composeExecutionObservers,
  definePlugin,
  emitExecutionEvent,
  withExecutionObserver,
} from "./index";

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

const interruptingPlugin = definePlugin(() => ({
  id: "interrupting" as const,
  storage: () => ({}),
  extension: () => ({ label: "interrupting" }),
  runtime: {
    executionObserver: () => ({
      handle: () => Effect.interrupt,
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
  it.effect("emits events to the scoped observer", () =>
    Effect.gen(function* () {
      calls = [];
      yield* emitExecutionEvent(finishedEvent()).pipe(
        withExecutionObserver({
          handle: () => Effect.sync(() => calls.push("observed")),
        }),
      );

      expect(calls).toEqual(["observed"]);
    }),
  );

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

  it.effect("preserves interrupts from scoped observers", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        emitExecutionEvent(finishedEvent()).pipe(
          withExecutionObserver({
            handle: () => Effect.interrupt,
          }),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    }),
  );

  it.effect("preserves interrupts from composed plugin observers", () =>
    Effect.gen(function* () {
      calls = [];
      const interrupting = interruptingPlugin();
      const last = observingPlugin("last")();
      const observer = composeExecutionObservers([interrupting, last] as const, {
        interrupting: { label: "interrupting" },
        last: { label: "last" },
      });

      const exit = yield* Effect.exit(observer.handle(finishedEvent()));

      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      expect(Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(calls).toEqual([]);
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
