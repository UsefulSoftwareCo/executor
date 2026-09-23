import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Exit } from "effect";
import { SqlError } from "effect/unstable/sql";
import { OnboardingUnavailable } from "../src/contracts/onboarding.ts";
import { recoverSetupConnection } from "../src/implementation/onboarding.ts";

const closed = new SqlError.SqlError({
  reason: new SqlError.ConnectionError({ cause: new Error("Connection closed") }),
});

test("a closed setup connection recovers after releasing the failed attempt", async () => {
  let attempts = 0;
  let active = 0;
  const releases: number[] = [];
  const result = await Effect.runPromise(
    recoverSetupConnection(
      Effect.scoped(
        Effect.gen(function* () {
          const attempt = ++attempts;
          assert.equal(active, 0);
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              active++;
            }),
            () =>
              Effect.sync(() => {
                active--;
                releases.push(attempt);
              }),
          );
          if (attempt < 3) return yield* closed;
          return "confirmed organization";
        }),
      ),
    ),
  );
  assert.equal(result, "confirmed organization");
  assert.deepEqual(releases, [1, 2, 3]);
  assert.equal(active, 0);
});

test("persistent connection failures stop; unrelated errors and cancellation are not retried", async () => {
  let attempts = 0;
  const exhausted = await Effect.runPromise(
    Effect.exit(
      recoverSetupConnection(
        Effect.suspend(() => {
          attempts++;
          return Effect.fail(closed);
        }),
      ),
    ),
  );
  assert.ok(Exit.isFailure(exhausted));
  assert.equal(attempts, 3);

  const failures: ReadonlyArray<Effect.Effect<never, OnboardingUnavailable | SqlError.SqlError>> = [
    Effect.fail(new OnboardingUnavailable()),
    Effect.fail(
      new SqlError.SqlError({
        reason: new SqlError.ConstraintError({ cause: new Error("constraint") }),
      }),
    ),
    Effect.die(new Error("defect")),
    Effect.interrupt,
  ];
  for (const failure of failures) {
    let executions = 0;
    const result = await Effect.runPromise(
      Effect.exit(
        recoverSetupConnection(
          Effect.suspend(() => {
            executions++;
            return failure;
          }),
        ),
      ),
    );
    assert.ok(Exit.isFailure(result));
    assert.equal(executions, 1);
  }
});
