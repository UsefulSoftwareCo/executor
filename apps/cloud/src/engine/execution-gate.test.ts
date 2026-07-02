import { describe, expect, it } from "@effect/vitest";
import { Data, Effect } from "effect";

import type { ExecutionEngine } from "@executor-js/execution";

import {
  EXECUTION_LIMIT_BLOCKED_MESSAGE,
  ExecutionLimitReachedError,
  makeExecutionLimitGate,
} from "./execution-gate";

// Stand-in for an upstream billing failure (Autumn down, network error).
class FakeUpstreamError extends Data.TaggedError("FakeUpstreamError")<{}> {}

// Minimal engine fake: records calls, always completes successfully. The gate
// must never let a blocked execution reach it.
const makeFakeEngine = () => {
  const calls = { execute: 0, executeWithPause: 0, resume: 0 };
  const engine: ExecutionEngine<never> = {
    execute: () =>
      Effect.sync(() => {
        calls.execute += 1;
        return { result: "ok" };
      }),
    executeWithPause: () =>
      Effect.sync(() => {
        calls.executeWithPause += 1;
        return { status: "completed", result: { result: "ok" } } as const;
      }),
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

// Balance-check fake with programmable outcomes and a call counter.
const makeBalanceCheck = (outcome: () => Effect.Effect<{ readonly allowed: boolean }, unknown>) => {
  const state = { calls: 0 };
  const check = (_organizationId: string) =>
    Effect.suspend(() => {
      state.calls += 1;
      return outcome();
    });
  return { check, state };
};

describe("execution balance gate", () => {
  it.effect("allows execution when the balance check allows", () =>
    Effect.gen(function* () {
      const { engine, calls } = makeFakeEngine();
      const balance = makeBalanceCheck(() => Effect.succeed({ allowed: true }));
      const gate = makeExecutionLimitGate(balance.check);
      const gated = gate.decorate("org_allowed", engine);

      const result = yield* gated.execute("code", { onElicitation });

      expect(result).toEqual({ result: "ok" });
      expect(calls.execute).toBe(1);
      expect(balance.state.calls).toBe(1);
    }),
  );

  it.effect("blocks execute with the limit message and never runs the engine", () =>
    Effect.gen(function* () {
      const { engine, calls } = makeFakeEngine();
      const balance = makeBalanceCheck(() => Effect.succeed({ allowed: false }));
      const gate = makeExecutionLimitGate(balance.check);
      const gated = gate.decorate("org_blocked", engine);

      const result = yield* gated.execute("code", { onElicitation });

      expect(result).toEqual({ result: null, error: EXECUTION_LIMIT_BLOCKED_MESSAGE });
      expect(calls.execute).toBe(0);
    }),
  );

  it.effect("blocks executeWithPause as a completed error result", () =>
    Effect.gen(function* () {
      const { engine, calls } = makeFakeEngine();
      const gate = makeExecutionLimitGate(
        makeBalanceCheck(() => Effect.succeed({ allowed: false })).check,
      );
      const gated = gate.decorate("org_blocked", engine);

      const outcome = yield* gated.executeWithPause("code");

      expect(outcome).toEqual({
        status: "completed",
        result: { result: null, error: EXECUTION_LIMIT_BLOCKED_MESSAGE },
      });
      expect(calls.executeWithPause).toBe(0);
    }),
  );

  it.effect("check fails with the typed ExecutionLimitReachedError when blocked", () =>
    Effect.gen(function* () {
      const gate = makeExecutionLimitGate(
        makeBalanceCheck(() => Effect.succeed({ allowed: false })).check,
      );

      const error = yield* Effect.flip(gate.check("org_blocked"));

      expect(error).toBeInstanceOf(ExecutionLimitReachedError);
      expect(error.organizationId).toBe("org_blocked");
    }),
  );

  it.effect("fails open when the billing service errors (check attempted, execution runs)", () =>
    Effect.gen(function* () {
      const { engine, calls } = makeFakeEngine();
      const balance = makeBalanceCheck(() => Effect.fail(new FakeUpstreamError()));
      const gate = makeExecutionLimitGate(balance.check);
      const gated = gate.decorate("org_erroring", engine);

      const result = yield* gated.execute("code", { onElicitation });

      expect(balance.state.calls).toBe(1); // the check WAS attempted
      expect(result).toEqual({ result: "ok" }); // and the execution still ran
      expect(calls.execute).toBe(1);
    }),
  );

  // Live clock: the timeout budget is a real timer here (10ms), so the test
  // must actually wait for it rather than suspend on the virtual TestClock.
  it.live("fails open when the balance check exceeds its timeout", () =>
    Effect.gen(function* () {
      const { engine, calls } = makeFakeEngine();
      const balance = makeBalanceCheck(() => Effect.never);
      const gate = makeExecutionLimitGate(balance.check, { timeoutMs: 10 });
      const gated = gate.decorate("org_slow", engine);

      const result = yield* gated.execute("code", { onElicitation });

      expect(balance.state.calls).toBe(1); // the check WAS attempted
      expect(result).toEqual({ result: "ok" }); // timeout => allowed
      expect(calls.execute).toBe(1);
    }),
  );

  it.effect("caches the allowed outcome: one billing call across executes inside the TTL", () =>
    Effect.gen(function* () {
      const { engine, calls } = makeFakeEngine();
      const balance = makeBalanceCheck(() => Effect.succeed({ allowed: true }));
      const gate = makeExecutionLimitGate(balance.check);
      const gated = gate.decorate("org_cached", engine);

      yield* gated.execute("code", { onElicitation });
      yield* gated.execute("code", { onElicitation });

      expect(balance.state.calls).toBe(1);
      expect(calls.execute).toBe(2);
    }),
  );

  it.effect("caches the blocked outcome too", () =>
    Effect.gen(function* () {
      const balance = makeBalanceCheck(() => Effect.succeed({ allowed: false }));
      const gate = makeExecutionLimitGate(balance.check);
      const { engine, calls } = makeFakeEngine();
      const gated = gate.decorate("org_blocked_cached", engine);

      const first = yield* gated.execute("code", { onElicitation });
      const second = yield* gated.execute("code", { onElicitation });

      expect(first).toEqual({ result: null, error: EXECUTION_LIMIT_BLOCKED_MESSAGE });
      expect(second).toEqual({ result: null, error: EXECUTION_LIMIT_BLOCKED_MESSAGE });
      expect(balance.state.calls).toBe(1);
      expect(calls.execute).toBe(0);
    }),
  );

  it.effect("never caches errors: the next execute re-checks the balance", () =>
    Effect.gen(function* () {
      const { engine } = makeFakeEngine();
      let failNext = true;
      const balance = makeBalanceCheck(() => {
        if (failNext) {
          failNext = false;
          return Effect.fail(new FakeUpstreamError());
        }
        return Effect.succeed({ allowed: false });
      });
      const gate = makeExecutionLimitGate(balance.check);
      const gated = gate.decorate("org_transient", engine);

      const first = yield* gated.execute("code", { onElicitation });
      const second = yield* gated.execute("code", { onElicitation });

      expect(first).toEqual({ result: "ok" }); // failed open, not cached
      expect(second).toEqual({ result: null, error: EXECUTION_LIMIT_BLOCKED_MESSAGE });
      expect(balance.state.calls).toBe(2);
    }),
  );

  it.effect("caches per organization, not globally", () =>
    Effect.gen(function* () {
      const allowedByOrg: Record<string, boolean> = { org_a: true, org_b: false };
      const state = { calls: 0 };
      const gate = makeExecutionLimitGate((organizationId) =>
        Effect.sync(() => {
          state.calls += 1;
          return { allowed: allowedByOrg[organizationId] ?? true };
        }),
      );
      const a = makeFakeEngine();
      const b = makeFakeEngine();

      const resultA = yield* gate.decorate("org_a", a.engine).execute("code", { onElicitation });
      const resultB = yield* gate.decorate("org_b", b.engine).execute("code", { onElicitation });

      expect(resultA).toEqual({ result: "ok" });
      expect(resultB).toEqual({ result: null, error: EXECUTION_LIMIT_BLOCKED_MESSAGE });
      expect(state.calls).toBe(2);
    }),
  );

  it.effect("never gates resume, even for a blocked organization", () =>
    Effect.gen(function* () {
      const { engine, calls } = makeFakeEngine();
      const balance = makeBalanceCheck(() => Effect.succeed({ allowed: false }));
      const gate = makeExecutionLimitGate(balance.check);
      const gated = gate.decorate("org_blocked", engine);

      const outcome = yield* gated.resume("exec_1", { action: "accept" });

      expect(outcome).toEqual({ status: "completed", result: { result: "resumed" } });
      expect(calls.resume).toBe(1);
      expect(balance.state.calls).toBe(0); // resume consults billing not at all
    }),
  );
});
