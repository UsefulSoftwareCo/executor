// ---------------------------------------------------------------------------
// Resume is metered work — the regression guard for the un-metered-resume
// bypass.
//
// One execution can pause MANY times (every elicitation is a pause point, and
// each pause mints a new execution id), and each `resume` continues the
// sandbox from where it stopped — fresh arbitrary code and tool calls. Both
// pre-execution guards used to pass `resume` through untouched ("a paused
// execution already consumed its quota slot"), so a single billable
// `executeWithPause` that paused in a loop drove an unbounded chain of
// continuations past the balance gate and the rate limiter: one quota slot,
// zero further checks, unlimited resumed work between the pauses.
//
// These tests pin the fix: a blocked decision refuses the resume with the same
// descriptive error a blocked execute returns, WITHOUT invoking the inner
// engine — nothing runs un-gated, the paused execution and its unconsumed
// approval decision stay intact, and the work completes once the org is back
// under its limit.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { ExecutionEngine } from "@executor-js/execution";

import { makeExecutionLimitGate } from "./execution-gate";
import { makeExecutionRateLimiter } from "./execution-rate-limit";
import {
  EXECUTION_LIMIT_BLOCKED_MESSAGE,
  RATE_LIMIT_BLOCKED_MESSAGE,
} from "./execution-limit-messages";

const ORG = "org_free_tier";

/**
 * The exploit shape: one execute that pauses, then a chain of resumes — each
 * one a fresh unit of continued work that used to run with no gate in front
 * of it.
 */
const multiPauseEngine = (work: Array<string>): ExecutionEngine => ({
  execute: () => {
    work.push("execute");
    return Effect.succeed({ result: "ran" });
  },
  executeWithPause: () => {
    work.push("execute");
    return Effect.succeed({
      status: "paused",
      execution: { id: "exec_1", elicitationContext: {} },
    } as never);
  },
  resume: () => {
    work.push("resume");
    return Effect.succeed({ status: "completed", result: { result: "ran" } });
  },
  getPausedExecution: () => Effect.succeed({ id: "exec_1", elicitationContext: {} } as never),
  pausedExecutionCount: () => Effect.succeed(1),
  hasPausedExecutions: () => Effect.succeed(true),
  getDescription: Effect.succeed("stub"),
  // The stub forks nothing, so there is no sandbox fiber to end.
  shutdown: Effect.void,
});

describe("metered resume — every continuation is gated work", () => {
  it("the balance gate refuses a resumed continuation when the quota is spent", async () => {
    const work: Array<string> = [];
    const gate = makeExecutionLimitGate(() => Effect.succeed({ allowed: false }));
    const engine = gate.decorate(ORG, multiPauseEngine(work));

    const refused = await Effect.runPromise(engine.resume("exec_1", { action: "accept" }));
    expect(refused).toMatchObject({
      status: "completed",
      result: { result: null, error: EXECUTION_LIMIT_BLOCKED_MESSAGE },
    });
    expect(work, "a blocked resume runs nothing").toEqual([]);

    // The refusal happened BEFORE the engine: the pause is still live and the
    // human's approval decision was never consumed by the refused attempt.
    expect(await Effect.runPromise(engine.getPausedExecution("exec_1"))).toMatchObject({
      id: "exec_1",
    });
  });

  it("each resume counts against the rate limiter's hourly cap", async () => {
    const work: Array<string> = [];
    let count = 0;
    const limiter = makeExecutionRateLimiter(() => Effect.succeed(++count), { limit: 10 });
    const engine = limiter.decorate(ORG, multiPauseEngine(work));

    // The billable execute spends count 1; nine continuations spend 2-10 and
    // all run; the eleventh increment (count 11) is over the cap and refuses.
    await Effect.runPromise(engine.executeWithPause("code"));
    for (let i = 0; i < 9; i += 1)
      expect(await Effect.runPromise(engine.resume("exec_1", { action: "accept" }))).toMatchObject({
        status: "completed",
        result: { result: "ran" },
      });
    expect(work, "execute plus nine allowed resumes reached the engine").toEqual([
      "execute",
      ...Array.from({ length: 9 }, () => "resume"),
    ]);

    const blocked = await Effect.runPromise(engine.resume("exec_1", { action: "accept" }));
    expect(blocked).toMatchObject({
      status: "completed",
      result: { result: null, error: RATE_LIMIT_BLOCKED_MESSAGE },
    });
    expect(work.length, "the blocked resume ran nothing").toBe(10);
  });

  it("an allowed balance reaches the engine — gating, not stranding", async () => {
    const work: Array<string> = [];
    const gate = makeExecutionLimitGate(() => Effect.succeed({ allowed: true }));
    const engine = gate.decorate(ORG, multiPauseEngine(work));

    const resumed = await Effect.runPromise(engine.resume("exec_1", { action: "accept" }));
    expect(resumed).toMatchObject({ status: "completed", result: { result: "ran" } });
    expect(work).toEqual(["resume"]);
  });
});
