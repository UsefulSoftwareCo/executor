import { describe, expect, it } from "@effect/vitest";
import { Data, Effect } from "effect";

import type { ExecutionEngine } from "@executor-js/execution";

import {
  RATE_LIMIT_BLOCKED_MESSAGE,
  ExecutionRateLimitExceededError,
  makeExecutionRateLimiter,
} from "./execution-rate-limit";

// Stand-in for a counter-DO failure (unreachable, storage error).
class FakeCounterError extends Data.TaggedError("FakeCounterError")<{}> {}

// In-memory stand-in for the counter DO: same fixed-window semantics, one
// { windowId, count } record per org.
const makeFakeCounter = () => {
  const windows = new Map<string, { windowId: number; count: number }>();
  const state = { calls: 0 };
  const increment = (organizationId: string, windowId: number) =>
    Effect.sync(() => {
      state.calls += 1;
      const stored = windows.get(organizationId);
      const count = stored && stored.windowId === windowId ? stored.count + 1 : 1;
      windows.set(organizationId, { windowId, count });
      return count;
    });
  return { increment, state };
};

const makeFakeEngine = () => {
  const calls = { execute: 0, resume: 0 };
  const engine: ExecutionEngine<never> = {
    execute: () =>
      Effect.sync(() => {
        calls.execute += 1;
        return { result: "ok" };
      }),
    executeWithPause: () =>
      Effect.succeed({ status: "completed", result: { result: "ok" } } as const),
    resume: () =>
      Effect.sync(() => {
        calls.resume += 1;
        return { status: "completed", result: { result: "resumed" } } as const;
      }),
    getPausedExecution: () => Effect.succeed(null),
    pausedExecutionCount: () => Effect.succeed(0),
    hasPausedExecutions: () => Effect.succeed(false),
    getDescription: Effect.succeed("fake"),
  };
  return { engine, calls };
};

const onElicitation = () => Effect.succeed({ action: "accept" as const });

describe("execution rate limiter", () => {
  it.effect("allows executions under the limit", () =>
    Effect.gen(function* () {
      const counter = makeFakeCounter();
      const limiter = makeExecutionRateLimiter(counter.increment, { limit: 3 });
      const { engine, calls } = makeFakeEngine();
      const limited = limiter.decorate("org_ok", engine);

      for (let i = 0; i < 3; i++) {
        const result = yield* limited.execute("code", { onElicitation });
        expect(result).toEqual({ result: "ok" });
      }

      expect(calls.execute).toBe(3);
      expect(counter.state.calls).toBe(3);
    }),
  );

  it.effect("blocks the call after the limit with the backstop message", () =>
    Effect.gen(function* () {
      const counter = makeFakeCounter();
      const limiter = makeExecutionRateLimiter(counter.increment, { limit: 2 });
      const { engine, calls } = makeFakeEngine();
      const limited = limiter.decorate("org_hot", engine);

      yield* limited.execute("code", { onElicitation });
      yield* limited.execute("code", { onElicitation });
      const blocked = yield* limited.execute("code", { onElicitation });

      expect(blocked).toEqual({ result: null, error: RATE_LIMIT_BLOCKED_MESSAGE });
      expect(calls.execute).toBe(2); // the third never reached the engine
    }),
  );

  it.effect("check fails with the typed ExecutionRateLimitExceededError over the limit", () =>
    Effect.gen(function* () {
      const counter = makeFakeCounter();
      const limiter = makeExecutionRateLimiter(counter.increment, { limit: 1 });

      yield* limiter.check("org_hot");
      const error = yield* Effect.flip(limiter.check("org_hot"));

      expect(error).toBeInstanceOf(ExecutionRateLimitExceededError);
      expect(error.organizationId).toBe("org_hot");
    }),
  );

  it.effect("resets when the fixed window rolls over", () =>
    Effect.gen(function* () {
      const counter = makeFakeCounter();
      let nowMs = 0;
      const limiter = makeExecutionRateLimiter(counter.increment, {
        limit: 1,
        windowMs: 1_000,
        now: () => nowMs,
      });
      const { engine, calls } = makeFakeEngine();
      const limited = limiter.decorate("org_windowed", engine);

      yield* limited.execute("code", { onElicitation });
      const blocked = yield* limited.execute("code", { onElicitation });
      expect(blocked).toEqual({ result: null, error: RATE_LIMIT_BLOCKED_MESSAGE });

      nowMs = 1_000; // next fixed window
      const afterReset = yield* limited.execute("code", { onElicitation });

      expect(afterReset).toEqual({ result: "ok" });
      expect(calls.execute).toBe(2);
    }),
  );

  it.effect("fails open when the counter errors (increment attempted, execution runs)", () =>
    Effect.gen(function* () {
      const state = { calls: 0 };
      const limiter = makeExecutionRateLimiter(() =>
        Effect.suspend(() => {
          state.calls += 1;
          return Effect.fail(new FakeCounterError());
        }),
      );
      const { engine, calls } = makeFakeEngine();
      const limited = limiter.decorate("org_do_down", engine);

      const result = yield* limited.execute("code", { onElicitation });

      expect(state.calls).toBe(1); // the increment WAS attempted
      expect(result).toEqual({ result: "ok" }); // and the execution still ran
      expect(calls.execute).toBe(1);
    }),
  );

  // Live clock: the timeout budget is a real timer here (10ms).
  it.live("fails open when the counter exceeds its timeout", () =>
    Effect.gen(function* () {
      const limiter = makeExecutionRateLimiter(() => Effect.never, { timeoutMs: 10 });
      const { engine, calls } = makeFakeEngine();
      const limited = limiter.decorate("org_do_slow", engine);

      const result = yield* limited.execute("code", { onElicitation });

      expect(result).toEqual({ result: "ok" });
      expect(calls.execute).toBe(1);
    }),
  );

  it.effect("never gates resume, even over the limit", () =>
    Effect.gen(function* () {
      const counter = makeFakeCounter();
      const limiter = makeExecutionRateLimiter(counter.increment, { limit: 1 });
      const { engine, calls } = makeFakeEngine();
      const limited = limiter.decorate("org_hot", engine);

      yield* limited.execute("code", { onElicitation });
      yield* limited.execute("code", { onElicitation }); // now over the limit

      const outcome = yield* limited.resume("exec_1", { action: "accept" });

      expect(outcome).toEqual({ status: "completed", result: { result: "resumed" } });
      expect(calls.resume).toBe(1);
    }),
  );

  it.effect("counts organizations independently", () =>
    Effect.gen(function* () {
      const counter = makeFakeCounter();
      const limiter = makeExecutionRateLimiter(counter.increment, { limit: 1 });
      const a = makeFakeEngine();
      const b = makeFakeEngine();
      const limitedA = limiter.decorate("org_a", a.engine);
      const limitedB = limiter.decorate("org_b", b.engine);

      yield* limitedA.execute("code", { onElicitation });
      const blockedA = yield* limitedA.execute("code", { onElicitation });
      const freshB = yield* limitedB.execute("code", { onElicitation });

      expect(blockedA).toEqual({ result: null, error: RATE_LIMIT_BLOCKED_MESSAGE });
      expect(freshB).toEqual({ result: "ok" });
    }),
  );
});
