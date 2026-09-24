import assert from "node:assert/strict";
import { test } from "node:test";
import { Cause, Effect, Exit } from "effect";
import { readNativeWorkflowStatus } from "../src/implementation/workflow-status.ts";

test("a native internal error does not fail a status read that recovers", async () => {
  let attempts = 0;
  const state = { status: "running" };
  const result = await Effect.runPromise(
    readNativeWorkflowStatus(async () => {
      if (++attempts === 1) throw new Error("internal error");
      return state;
    }),
  );
  assert.equal(result, state);
  assert.equal(attempts, 2);
});

test("persistent native status failures remain bounded and preserve the cause", async () => {
  let attempts = 0;
  const error = new Error("internal error");
  const result = await Effect.runPromiseExit(
    readNativeWorkflowStatus(async () => {
      attempts++;
      throw error;
    }),
  );
  assert.equal(attempts, 3);
  assert.ok(Exit.isFailure(result));
  assert.equal(Cause.squash(result.cause), error);
});

for (const message of ["instance.not_found", "permission denied", "unclassified failure"]) {
  test(`${message} is returned without retry`, async () => {
    let attempts = 0;
    const error = new Error(message);
    const result = await Effect.runPromiseExit(
      readNativeWorkflowStatus(async () => {
        attempts++;
        throw error;
      }),
    );
    assert.equal(attempts, 1);
    assert.ok(Exit.isFailure(result));
    assert.equal(Cause.squash(result.cause), error);
  });
}

test("a successful but malformed status is left for the boundary decoder", async () => {
  let attempts = 0;
  const result = await Effect.runPromise(
    readNativeWorkflowStatus(async () => {
      attempts++;
      return { status: "invalid" };
    }),
  );
  assert.deepEqual(result, { status: "invalid" });
  assert.equal(attempts, 1);
});
