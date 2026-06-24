import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate, Schema } from "effect";

import { createExecutor, definePlugin, ElicitationResponse, tool } from "@executor-js/sdk";
import type { ExecutionEvent, ExecutionObserver } from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";
import type { CodeExecutor, ExecuteResult } from "@executor-js/codemode-core";

import { createExecutionEngine } from "./engine";

const emptyPlugin = definePlugin(() => ({
  id: "observer-test" as const,
  storage: () => ({}),
  staticSources: () => [],
}));

const approvalPlugin = definePlugin(() => ({
  id: "observer-approval-test" as const,
  storage: () => ({}),
  staticSources: () => [
    {
      id: "approval.ctl",
      kind: "control" as const,
      name: "Approval Ctl",
      tools: [
        tool({
          name: "run",
          description: "Requires approval",
          annotations: { requiresApproval: true } as const,
          inputSchema: Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(Schema.Struct({}))),
          execute: () => Effect.succeed("ran"),
        }),
      ],
    },
  ],
}));

const makeExecutor = () => createExecutor(makeTestConfig({ plugins: [emptyPlugin()] as const }));

const makeApprovalExecutor = () =>
  createExecutor(makeTestConfig({ plugins: [approvalPlugin()] as const }));

// A code executor that issues one builtin tool call (tools.search) and then
// completes, enough to exercise the full event sequence.
const toolCallingExecutor: CodeExecutor = {
  execute: (_code, invoker) =>
    invoker
      .invoke({ path: "search", args: { query: "anything" } })
      .pipe(Effect.as({ result: "ok", logs: [] } satisfies ExecuteResult), Effect.orDie),
};

const approvalCallingExecutor: CodeExecutor = {
  execute: (_code, invoker) =>
    invoker
      .invoke({ path: "approval.ctl.run", args: {} })
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

  it.effect("emits inline interaction events when execute handles elicitation", () =>
    Effect.gen(function* () {
      const executor = yield* makeApprovalExecutor();
      const { events, observer } = collectingObserver();
      const engine = createExecutionEngine({
        executor,
        codeExecutor: approvalCallingExecutor,
        observer,
      });

      const result = yield* engine.execute("noop", {
        trigger: { kind: "test" },
        onElicitation: () => Effect.succeed(ElicitationResponse.make({ action: "accept" })),
      });
      expect(result.result).toBe("ok");

      const started = events.find((e) => Predicate.isTagged(e, "ExecutionStarted"));
      const interactionStarted = events.find((e) => Predicate.isTagged(e, "InteractionStarted"));
      const interactionResolved = events.find((e) => Predicate.isTagged(e, "InteractionResolved"));

      expect(interactionStarted?.executionId).toBe(started?.executionId);
      expect(interactionResolved?.executionId).toBe(started?.executionId);
      expect(interactionResolved?.interactionId).toBe(interactionStarted?.interactionId);
      expect(interactionStarted?.context.request.message).toContain("approval");
      expect(interactionResolved?.status).toBe("accepted");
      expect(interactionResolved?.response?.action).toBe("accept");
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
