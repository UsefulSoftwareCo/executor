import assert from "node:assert/strict";
import { test } from "node:test";
import { Cause, Deferred, Effect, Exit } from "effect";
import { persistR2Object } from "../src/implementation/r2-write.ts";

const throttled = new Error("put: Too many requests (10058)");

test("a throttled immutable write publishes its original bytes once R2 accepts it", async () => {
  let attempts = 0;
  const body = new TextEncoder().encode("synthetic build");
  const stored = new Map<string, Uint8Array>();
  await Effect.runPromise(
    persistR2Object(
      Effect.suspend(() => {
        if (++attempts === 1) return Effect.fail(throttled);
        stored.set("bld_fixture/ui/main.js", body.slice());
        return Effect.void;
      }),
    ),
  );
  assert.equal(attempts, 2);
  assert.deepEqual([...stored], [["bld_fixture/ui/main.js", body]]);
});

test("persistent R2 throttling stays bounded and retains the final failure", async () => {
  let attempts = 0;
  const result = await Effect.runPromiseExit(
    persistR2Object(
      Effect.suspend(() => {
        attempts++;
        return Effect.fail(throttled);
      }),
    ),
  );
  assert.equal(attempts, 3);
  assert.ok(Exit.isFailure(result));
  assert.equal(Cause.squash(result.cause), throttled);
});

for (const message of [
  "put: Access denied (10003)",
  "put: Connection lost (10054)",
  "unknown error",
]) {
  test(`${message} does not repeat the write`, async () => {
    let attempts = 0;
    const error = new Error(message);
    const result = await Effect.runPromiseExit(
      persistR2Object(
        Effect.suspend(() => {
          attempts++;
          return Effect.fail(error);
        }),
      ),
    );
    assert.equal(attempts, 1);
    assert.ok(Exit.isFailure(result));
    assert.equal(Cause.squash(result.cause), error);
  });
}

test("cancelling the owner during backoff prevents another write", async () => {
  let attempts = 0;
  const attempted = Deferred.makeUnsafe<void>();
  const controller = new AbortController();
  const running = Effect.runPromiseExit(
    persistR2Object(
      Effect.gen(function* () {
        attempts++;
        yield* Deferred.succeed(attempted, undefined);
        return yield* Effect.fail(throttled);
      }),
    ),
    { signal: controller.signal },
  );
  await Effect.runPromise(Deferred.await(attempted));
  controller.abort();
  const result = await running;
  assert.equal(attempts, 1);
  assert.ok(Exit.isFailure(result));
  assert.ok(Cause.hasInterruptsOnly(result.cause));
});
