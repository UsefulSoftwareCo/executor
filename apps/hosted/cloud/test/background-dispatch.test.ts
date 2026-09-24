import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { dispatchBackground } from "../src/implementation/background-dispatch.ts";

for (const fails of [false, true]) {
  test(`background ${fails ? "failure" : "completion"} flushes telemetry after the last span`, () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          const started = yield* Deferred.make<void>();
          const finish = yield* Deferred.make<void>();
          const closing = yield* Deferred.make<void>();
          const spans: string[] = [];
          let flushed: readonly string[] | undefined;
          const submitted: Promise<Exit.Exit<void, string>>[] = [];
          yield* Scope.addFinalizer(
            scope,
            Effect.sync(() => {
              flushed = [...spans];
            }),
          );
          const work = Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(finish);
            spans.push("dispatch completed");
            if (fails) return yield* Effect.fail("synthetic failure");
          });
          yield* dispatchBackground(work, (pending) =>
            Effect.sync(() => {
              submitted.push(Effect.runPromiseExit(pending));
            }),
          ).pipe(Scope.provide(scope));
          yield* Deferred.await(started);
          // This finalizer runs first, proving scope closure has begun.
          yield* Scope.addFinalizer(scope, Deferred.succeed(closing, undefined));
          const close = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
          yield* Deferred.await(closing);
          yield* Effect.yieldNow;
          assert.equal(flushed, undefined);
          yield* Deferred.succeed(finish, undefined);
          yield* Fiber.join(close);
          assert.deepEqual(flushed, ["dispatch completed"]);
          const results = yield* Effect.promise(() => Promise.all(submitted));
          assert.equal(results.length, 1);
          assert.equal(results.some(Exit.isFailure), fails);
        }),
      ),
    ));
}
