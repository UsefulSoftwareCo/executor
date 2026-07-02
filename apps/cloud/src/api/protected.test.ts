import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { ExecutionEngine } from "@executor-js/execution";
import { withExecutionUsageTracking } from "../engine/execution-usage";

const makeBaseEngine = (): ExecutionEngine =>
  ({
    execute: () => Effect.succeed({ result: "ok", logs: [] }),
    executeWithPause: () =>
      Effect.succeed({
        status: "completed",
        result: { result: "ok", logs: [] },
      }),
    resume: () =>
      Effect.succeed({
        status: "completed",
        result: { result: "ok", logs: [] },
      }),
    getPausedExecution: () => Effect.succeed(null),
    pausedExecutionCount: () => Effect.succeed(0),
    hasPausedExecutions: () => Effect.succeed(false),
    getDescription: Effect.succeed("desc"),
  }) as ExecutionEngine;

describe("withExecutionUsageTracking", () => {
  it.effect("tracks successful execute and executeWithPause", () =>
    Effect.gen(function* () {
      const tracked: string[] = [];
      const engine = withExecutionUsageTracking("org_1", makeBaseEngine(), (organizationId) => {
        tracked.push(organizationId);
      });

      yield* engine.execute("1+1", { onElicitation: () => Effect.die("unused") });
      yield* engine.executeWithPause("2+2");

      expect(tracked).toEqual(["org_1", "org_1"]);
    }),
  );

  it.effect("does not track resume usage", () =>
    Effect.gen(function* () {
      const tracked: string[] = [];
      const base = makeBaseEngine();

      let shouldReturnNull = false;
      const engine = withExecutionUsageTracking(
        "org_2",
        {
          ...base,
          resume: (...args) => {
            if (shouldReturnNull) return Effect.succeed(null);
            return base.resume(...args);
          },
        },
        (organizationId) => {
          tracked.push(organizationId);
        },
      );

      yield* engine.resume("exec_1", {
        action: "accept",
      });
      shouldReturnNull = true;
      yield* engine.resume("missing", {
        action: "accept",
      });

      expect(tracked).toEqual([]);
    }),
  );
});
