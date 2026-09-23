/** Promise helpers retain cancellation when composed by the native app framework. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect } from "effect";
import { fromPromise, toPromise } from "../src/implementation/authoring.ts";

for (const mode of ["promise", "native"] as const) {
  const run = <A>(callback: () => Promise<A>) =>
    mode === "promise" ? callback() : Effect.runPromise(fromPromise(callback)());

  test(`${mode} helper does not start with an already cancelled signal`, async () => {
    const abort = new AbortController();
    abort.abort();
    let started = false;
    const callback = toPromise(
      () =>
        Effect.sync(() => {
          started = true;
        }),
      abort.signal,
    );
    await assert.rejects(run(callback));
    assert.equal(started, false);
  });

  test(`${mode} helper cancels in flight and releases its operation`, async () => {
    const abort = new AbortController();
    const started = Deferred.makeUnsafe<void>();
    let released = false;
    const callback = toPromise(
      () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              released = true;
            }),
          ),
        ),
      abort.signal,
    );
    const rejected = assert.rejects(run(callback));
    await Effect.runPromise(Deferred.await(started));
    abort.abort();
    await rejected;
    assert.equal(released, true);
  });
}

test("native helper keeps its caller's span while honoring a supplied signal", async () => {
  const callback = toPromise(
    () => Effect.currentSpan.pipe(Effect.map((span) => span.name)),
    new AbortController().signal,
  );
  assert.equal(
    await Effect.runPromise(fromPromise(callback)().pipe(Effect.withSpan("caller"))),
    "caller",
  );
});
