import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Result } from "effect";

import { ToolAddress, UrlElicitation, ElicitationId } from "@executor-js/sdk";
import type { ExecutionEngine, ExecutionResult } from "@executor-js/execution";

import type { AnalyticsEvents, AnalyticsEventName } from "./events";
import { withExecutionAnalytics } from "./engine";

class FakeExecutionError extends Data.TaggedError("FakeExecutionError")<{}> {}

type Recorded = { readonly name: AnalyticsEventName; readonly properties: unknown };

const makeRecorder = () => {
  const events: Recorded[] = [];
  return {
    events,
    analytics: {
      record: <Name extends AnalyticsEventName>(name: Name, properties: AnalyticsEvents[Name]) =>
        Effect.sync(() => {
          events.push({ name, properties });
        }),
      flush: Effect.void,
    },
  };
};

const completedResult = (error?: string): ExecutionResult => ({
  status: "completed",
  result: { result: error ? null : "ok", ...(error ? { error } : {}) },
});

const pausedResult: ExecutionResult = {
  status: "paused",
  execution: {
    id: "exec-1",
    elicitationContext: {
      address: ToolAddress.make("github.issues.create"),
      args: {},
      request: UrlElicitation.make({
        message: "approve",
        url: "https://example.test/approve",
        elicitationId: ElicitationId.make("elic-1"),
      }),
    },
  },
};

const makeFakeEngine = (
  outcomes: Partial<{
    execute: Effect.Effect<{ result: unknown; error?: string }, FakeExecutionError>;
    executeWithPause: Effect.Effect<ExecutionResult, FakeExecutionError>;
    resume: Effect.Effect<ExecutionResult | null, FakeExecutionError>;
  }>,
): ExecutionEngine<FakeExecutionError> => ({
  execute: () => outcomes.execute ?? Effect.succeed({ result: "ok" }),
  executeWithPause: () => outcomes.executeWithPause ?? Effect.succeed(completedResult()),
  resume: () => outcomes.resume ?? Effect.succeed(null),
  getPausedExecution: () => Effect.succeed(null),
  pausedExecutionCount: () => Effect.succeed(0),
  hasPausedExecutions: () => Effect.succeed(false),
  getDescription: Effect.succeed("fake"),
});

describe("withExecutionAnalytics", () => {
  it.effect("records ok on a completed execution", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder();
      const engine = withExecutionAnalytics(makeFakeEngine({}), recorder.analytics, {
        plane: "mcp",
        toolkit: false,
      });
      yield* engine.executeWithPause("code");
      expect(recorder.events).toEqual([
        {
          name: "execution_completed",
          properties: { ok: true, plane: "mcp", toolkit: false },
        },
      ]);
    }),
  );

  it.effect("records not-ok when the sandbox reports an error value", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder();
      const engine = withExecutionAnalytics(
        makeFakeEngine({ executeWithPause: Effect.succeed(completedResult("boom")) }),
        recorder.analytics,
        { plane: "api", toolkit: false },
      );
      yield* engine.executeWithPause("code");
      expect(recorder.events).toEqual([
        {
          name: "execution_completed",
          properties: { ok: false, plane: "api", toolkit: false },
        },
      ]);
    }),
  );

  it.effect("records not-ok when the engine fails on the error channel", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder();
      const engine = withExecutionAnalytics(
        makeFakeEngine({ executeWithPause: Effect.fail(new FakeExecutionError()) }),
        recorder.analytics,
        { plane: "mcp", toolkit: true },
      );
      const result = yield* Effect.result(engine.executeWithPause("code"));
      expect(Result.isFailure(result)).toBe(true);
      expect(recorder.events).toEqual([
        {
          name: "execution_completed",
          properties: { ok: false, plane: "mcp", toolkit: true },
        },
      ]);
    }),
  );

  it.effect("does not record a pause; records when the resume completes", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder();
      const paused = withExecutionAnalytics(
        makeFakeEngine({ executeWithPause: Effect.succeed(pausedResult) }),
        recorder.analytics,
        { plane: "mcp", toolkit: false },
      );
      yield* paused.executeWithPause("code");
      expect(recorder.events).toEqual([]);

      const resumed = withExecutionAnalytics(
        makeFakeEngine({ resume: Effect.succeed(completedResult()) }),
        recorder.analytics,
        { plane: "mcp", toolkit: false },
      );
      yield* resumed.resume("exec-1", { action: "accept" });
      expect(recorder.events).toEqual([
        {
          name: "execution_completed",
          properties: { ok: true, plane: "mcp", toolkit: false },
        },
      ]);
    }),
  );

  it.effect("resume of an unknown execution records nothing", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder();
      const engine = withExecutionAnalytics(makeFakeEngine({}), recorder.analytics, {
        plane: "api",
        toolkit: false,
      });
      yield* engine.resume("missing", { action: "accept" });
      expect(recorder.events).toEqual([]);
    }),
  );
});
