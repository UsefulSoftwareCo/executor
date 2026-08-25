import { describe, expect, it } from "@effect/vitest";
import { Data, Effect } from "effect";

import type { ExecutionEngine } from "@executor-js/execution";

import { makeExecutionRateLimiter } from "./execution-rate-limit";
import { RATE_LIMIT_BLOCKED_MESSAGE } from "./execution-limit-messages";

const ORG = "org_test";

/** Stands in for whatever the real lookups fail with (Autumn down, DO down). */
class UpstreamDownError extends Data.TaggedError("UpstreamDownError")<{
  readonly which: string;
}> {}

// A stand-in engine: `execute` resolves to a marker, so a test tells an allowed
// execution (marker) from a blocked one (the gate's error result) by which of
// the two came back. A blocked decision never reaches the engine at all.
const engineStub: ExecutionEngine = {
  execute: () => Effect.succeed({ result: "ran" }),
  executeWithPause: () => Effect.succeed({ status: "completed", result: { result: "ran" } }),
  resume: () => Effect.succeed(null),
  getPausedExecution: () => Effect.succeed(null),
  pausedExecutionCount: () => Effect.succeed(0),
  hasPausedExecutions: () => Effect.succeed(false),
  getDescription: Effect.succeed("stub"),
};

/** Counter that hands out a caller-controlled sequence of counts. */
const countingIncrement = (counts: ReadonlyArray<number>) => {
  let calls = 0;
  return () => Effect.succeed(counts[Math.min(calls++, counts.length - 1)] ?? 0);
};

const runExecute = (limiter: ReturnType<typeof makeExecutionRateLimiter>) =>
  Effect.runPromise(
    limiter.decorate(ORG, engineStub).execute("code", {
      // Never invoked: the stub ignores it, and a blocked execution never runs.
      onElicitation: () => Effect.die("elicitation is not exercised here"),
    }),
  );

describe("execution rate limiter — paid exemption", () => {
  it("allows executions under the cap without consulting the exemption", async () => {
    let exemptionCalls = 0;
    const limiter = makeExecutionRateLimiter(countingIncrement([1]), {
      limit: 10,
      isExempt: () => {
        exemptionCalls += 1;
        return Effect.succeed(false);
      },
    });

    expect(await runExecute(limiter)).toMatchObject({ result: "ran" });
    // The whole point of resolving lazily: the common path costs no lookup.
    expect(exemptionCalls).toBe(0);
  });

  it("blocks a non-exempt org over the cap", async () => {
    const limiter = makeExecutionRateLimiter(countingIncrement([11]), {
      limit: 10,
      isExempt: () => Effect.succeed(false),
    });

    expect(await runExecute(limiter)).toMatchObject({
      result: null,
      error: RATE_LIMIT_BLOCKED_MESSAGE,
    });
  });

  it("allows an exempt org over the cap", async () => {
    const limiter = makeExecutionRateLimiter(countingIncrement([11]), {
      limit: 10,
      isExempt: () => Effect.succeed(true),
    });

    expect(await runExecute(limiter)).toMatchObject({ result: "ran" });
  });

  it("caches the exemption so a paid org past the cap looks it up once", async () => {
    let exemptionCalls = 0;
    const limiter = makeExecutionRateLimiter(countingIncrement([11, 12, 13]), {
      limit: 10,
      exemptionTtlMs: 60_000,
      now: () => 1_000,
      isExempt: () => {
        exemptionCalls += 1;
        return Effect.succeed(true);
      },
    });

    for (let i = 0; i < 3; i += 1)
      expect(await runExecute(limiter)).toMatchObject({ result: "ran" });
    expect(exemptionCalls).toBe(1);
  });

  it("re-resolves once the cached exemption expires", async () => {
    let exemptionCalls = 0;
    let clock = 1_000;
    const limiter = makeExecutionRateLimiter(countingIncrement([11, 12]), {
      limit: 10,
      exemptionTtlMs: 1_000,
      now: () => clock,
      isExempt: () => {
        exemptionCalls += 1;
        return Effect.succeed(true);
      },
    });

    await runExecute(limiter);
    clock += 5_000;
    await runExecute(limiter);
    expect(exemptionCalls).toBe(2);
  });

  it("blocks when the exemption cannot be resolved and nothing is cached", async () => {
    // Deliberately NOT fail-open: an unresolvable exemption during an Autumn
    // outage must not switch the backstop off, which is the one scenario it
    // exists to cover.
    const limiter = makeExecutionRateLimiter(countingIncrement([11]), {
      limit: 10,
      isExempt: () => Effect.fail(new UpstreamDownError({ which: "autumn" })),
    });

    expect(await runExecute(limiter)).toMatchObject({
      result: null,
      error: RATE_LIMIT_BLOCKED_MESSAGE,
    });
  });

  it("honours a stale exemption when a later lookup fails", async () => {
    let clock = 1_000;
    let shouldFail = false;
    const limiter = makeExecutionRateLimiter(countingIncrement([11, 12]), {
      limit: 10,
      exemptionTtlMs: 1_000,
      now: () => clock,
      isExempt: () =>
        shouldFail ? Effect.fail(new UpstreamDownError({ which: "autumn" })) : Effect.succeed(true),
    });

    expect(await runExecute(limiter)).toMatchObject({ result: "ran" });

    // Cache expires and Autumn is now unreachable: the known-paid org keeps
    // running rather than getting blocked mid-workload by a blip.
    clock += 5_000;
    shouldFail = true;
    expect(await runExecute(limiter)).toMatchObject({ result: "ran" });
  });

  it("fails open when the counter itself is unreachable", async () => {
    const limiter = makeExecutionRateLimiter(
      () => Effect.fail(new UpstreamDownError({ which: "counter DO" })),
      {
        limit: 10,
        isExempt: () => Effect.succeed(false),
      },
    );

    expect(await runExecute(limiter)).toMatchObject({ result: "ran" });
  });

  it("applies the cap when no exemption predicate is wired", async () => {
    const limiter = makeExecutionRateLimiter(countingIncrement([11]), { limit: 10 });

    expect(await runExecute(limiter)).toMatchObject({
      result: null,
      error: RATE_LIMIT_BLOCKED_MESSAGE,
    });
  });
});
