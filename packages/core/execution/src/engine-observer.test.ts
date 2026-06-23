import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";

import { createExecutor, definePlugin } from "@executor-js/sdk";
import type { ExecutionEvent, ExecutionObserver } from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";
import type { CodeExecutor, ExecuteResult } from "@executor-js/codemode-core";

import { createExecutionEngine } from "./engine";

const emptyPlugin = definePlugin(() => ({
  id: "observer-test" as const,
  storage: () => ({}),
  staticSources: () => [],
}));

const makeExecutor = () => createExecutor(makeTestConfig({ plugins: [emptyPlugin()] as const }));

// A code executor that issues one builtin tool call (tools.search) and then
// completes, enough to exercise the full event sequence.
const toolCallingExecutor: CodeExecutor = {
  execute: (_code, invoker) =>
    invoker
      .invoke({ path: "search", args: { query: "anything" } })
      .pipe(Effect.as({ result: "ok", logs: [] } satisfies ExecuteResult), Effect.orDie),
};

const collectingObserver = () => {
  const events: ExecutionEvent[] = [];
  const observer: ExecutionObserver = {
    handle: (event) => Effect.sync(() => void events.push(event)),
  };
  return { events, observer };
};

describe("execution engine observer emission", () => {
  it.effect("emits the full lifecycle for a completed run with a tool call", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const { events, observer } = collectingObserver();
      const engine = createExecutionEngine({
        executor,
        codeExecutor: toolCallingExecutor,
        observer,
      });

      const result = yield* engine.executeWithPause("noop", { trigger: { kind: "test" } });
      expect(result.status).toBe("completed");

      // First event opens the run, last closes it; tool calls land in between.
      // `.find` with isTagged narrows each result, so the assertions read the
      // typed fields directly via optional chaining (no conditional blocks).
      const started = events.find((e) => Predicate.isTagged(e, "ExecutionStarted"));
      const finished = events.find((e) => Predicate.isTagged(e, "ExecutionFinished"));
      const toolStarted = events.find((e) => Predicate.isTagged(e, "ToolCallStarted"));
      const toolFinished = events.find((e) => Predicate.isTagged(e, "ToolCallFinished"));

      expect(Predicate.isTagged(events[0], "ExecutionStarted")).toBe(true);
      expect(Predicate.isTagged(events[events.length - 1], "ExecutionFinished")).toBe(true);

      expect(started?.trigger?.kind).toBe("test");
      expect(started?.owner.tenant).toBeDefined();
      expect(toolStarted).toBeDefined();
      expect(finished?.status).toBe("completed");

      // Tool-call events share the run's executionId and carry the path.
      expect(toolFinished?.path).toBe("search");
      expect(toolFinished?.status).toBe("completed");
      expect(toolFinished?.executionId).toBe(started?.executionId);
    }),
  );

  it.effect("does nothing observable when no observer is configured", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const engine = createExecutionEngine({ executor, codeExecutor: toolCallingExecutor });
      const result = yield* engine.executeWithPause("noop");
      expect(result.status).toBe("completed");
    }),
  );
});
