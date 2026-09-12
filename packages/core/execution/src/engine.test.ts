import { describe, expect, it } from "@effect/vitest";
import { Cause, Data, Deferred, Effect, Exit, Fiber, Ref, Schema } from "effect";

import {
  CurrentOrgWriteAccess,
  createExecutor,
  definePlugin,
  makeOrgWriteAccessState,
  tool,
} from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import type { CodeExecutor, ExecuteResult } from "@executor-js/codemode-core";

import { createExecutionEngine, formatExecuteResult, formatPausedExecution } from "./engine";
import { FormElicitation } from "@executor-js/sdk/core";

// Regression for the hang reported as the executor-MCP "180s timeout" against
// Cowork (Claude web). Cowork goes down the `executeWithPause` branch because
// it doesn't advertise managed elicitation. When the dynamic worker fails
// fast (e.g. user submits TS with a `:` type annotation, "Unexpected token
// ':'" inside ~25ms), the failure was swallowed and the request hung until
// the client gave up at 180s. The cause was `Effect.race` having
// prefer-success semantics in Effect v4: the racing pause-signal Deferred
// never resolves, so a fiber failure is never observed by the racer.

class FakeRuntimeError extends Data.TaggedError("FakeRuntimeError")<{
  readonly message: string;
}> {}

const failingExecutor: CodeExecutor<FakeRuntimeError> = {
  execute: () => Effect.fail(new FakeRuntimeError({ message: "Unexpected token ':'" })),
};

const succeedingExecutor: CodeExecutor<FakeRuntimeError> = {
  execute: () => Effect.succeed({ result: "ok", logs: [] } satisfies ExecuteResult),
};

const emptyPlugin = definePlugin(() => ({
  id: "empty-test" as const,
  storage: () => ({}),
  staticIntegrations: () => [],
}));

const makeExecutor = () => createExecutor(makeTestConfig({ plugins: [emptyPlugin()] as const }));

describe("executeWithPause failure propagation", () => {
  it.effect("surfaces a fast codeExecutor failure as an Exit.Failure", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const engine = createExecutionEngine({
        executor,
        codeExecutor: failingExecutor,
      });

      const exit = yield* Effect.exit(engine.executeWithPause("noop"));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("does not hang when codeExecutor fails", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const engine = createExecutionEngine({
        executor,
        codeExecutor: failingExecutor,
      });

      // Race the executeWithPause against a short sleep. With the bug
      // present this resolves to "hung" because the failure is swallowed
      // by the prefer-success race against the pause Deferred.
      const outcome = yield* Effect.race(
        Effect.exit(engine.executeWithPause("noop")).pipe(
          Effect.map((exit) => ({ kind: "settled" as const, exit })),
        ),
        Effect.sleep("500 millis").pipe(Effect.as({ kind: "hung" as const })),
      );

      expect(outcome.kind).toBe("settled");
    }),
  );

  it.effect("control: succeedingExecutor returns completed", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const engine = createExecutionEngine({
        executor,
        codeExecutor: succeedingExecutor,
      });

      const result = yield* engine.executeWithPause("noop");
      expect(result.status).toBe("completed");
    }),
  );
});

describe("paused execution authorization", () => {
  it.effect("uses the resumer's current org-write access after approval", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ coreTools: {}, orgWrites: "request" }),
      );
      const engine = createExecutionEngine({
        executor,
        codeExecutor: makeQuickJsExecutor(),
      });
      yield* Effect.addFinalizer(() =>
        engine.shutdown.pipe(Effect.andThen(executor.close()), Effect.ignore),
      );

      const started = yield* engine
        .executeWithPause(
          `
          return await tools.executor.coreTools.policies.create({
            owner: "org",
            pattern: "resume-demotion-regression.*",
            action: "block",
          });
        `,
        )
        .pipe(Effect.provideService(CurrentOrgWriteAccess, makeOrgWriteAccessState("allowed")));
      expect(started.status).toBe("paused");
      if (started.status !== "paused") return;

      const resumed = yield* engine
        .resume(started.execution.id, { action: "accept", content: {} })
        .pipe(Effect.provideService(CurrentOrgWriteAccess, makeOrgWriteAccessState("denied")));
      expect(resumed?.status).toBe("completed");
      if (resumed?.status !== "completed") return;
      expect(yield* executor.policies.list()).toEqual([]);
      expect(resumed.result.result).toEqual({
        ok: false,
        error: expect.objectContaining({ code: "org_write_denied" }),
      });
    }).pipe(Effect.scoped),
  );

  it.effect("rebinds an in-flight resume when a demoted browser decision joins it", () =>
    Effect.gen(function* () {
      const waitStarted = yield* Deferred.make<void>();
      const releaseWait = yield* Deferred.make<void>();
      let writeWorkspacePolicy: () => Effect.Effect<unknown, Cause.YieldableError> = () =>
        Effect.die("workspace policy sink was not initialized");
      const joinPlugin = definePlugin(() => ({
        id: "resume-join-test" as const,
        storage: () => ({}),
        staticIntegrations: () => [
          {
            id: "resumeJoinTest.latch",
            kind: "in-memory" as const,
            name: "Resume latch",
            tools: [
              tool({
                name: "write",
                description: "Hold a resumed execution while another resume joins it.",
                annotations: { requiresApproval: true } as const,
                inputSchema: Schema.toStandardSchemaV1(
                  Schema.toStandardJSONSchemaV1(Schema.Struct({})),
                ),
                execute: () =>
                  Deferred.succeed(waitStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseWait)),
                    Effect.andThen(Effect.suspend(writeWorkspacePolicy)),
                  ),
              }),
            ],
          },
        ],
      }));
      const executor = yield* createExecutor(
        makeTestConfig({
          coreTools: {},
          orgWrites: "request",
          plugins: [joinPlugin()] as const,
        }),
      );
      writeWorkspacePolicy = () =>
        executor.policies.create({
          owner: "org",
          pattern: "resume-join-demotion.*",
          action: "block",
        });
      const engine = createExecutionEngine({ executor, codeExecutor: makeQuickJsExecutor() });
      yield* Effect.addFinalizer(() =>
        engine.shutdown.pipe(Effect.andThen(executor.close()), Effect.ignore),
      );

      const executionAccess = makeOrgWriteAccessState("allowed");
      const started = yield* engine
        .executeWithPause(
          `
          return await tools.resumeJoinTest.latch.write({});
        `,
        )
        .pipe(Effect.provideService(CurrentOrgWriteAccess, executionAccess));
      expect(started.status).toBe("paused");
      if (started.status !== "paused") return;

      const first = yield* engine
        .resume(started.execution.id, { action: "accept", content: {} })
        .pipe(
          Effect.provideService(CurrentOrgWriteAccess, makeOrgWriteAccessState("allowed")),
          Effect.forkChild,
        );
      yield* Deferred.await(waitStarted);

      const joined = yield* engine
        .resume(started.execution.id, { action: "accept", content: {} })
        .pipe(
          Effect.provideService(CurrentOrgWriteAccess, makeOrgWriteAccessState("denied")),
          Effect.forkChild,
        );
      while ((yield* Ref.get(executionAccess.current)) !== "denied") {
        yield* Effect.yieldNow;
      }
      yield* Deferred.succeed(releaseWait, undefined);

      const [firstOutcome, joinedOutcome] = yield* Effect.all([
        Fiber.join(first),
        Fiber.join(joined),
      ]);
      expect(firstOutcome?.status).toBe("completed");
      expect(joinedOutcome).toEqual(firstOutcome);
      expect(yield* executor.policies.list()).toEqual([]);
      if (firstOutcome?.status !== "completed") return;
      expect(firstOutcome.result.result).toEqual({
        ok: false,
        error: expect.objectContaining({ code: "org_write_denied" }),
      });
    }).pipe(Effect.scoped),
  );
});

describe("pausedExecutionCount", () => {
  it.effect("starts at zero", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const engine = createExecutionEngine({
        executor,
        codeExecutor: succeedingExecutor,
      });

      expect(yield* engine.pausedExecutionCount()).toBe(0);
      expect(yield* engine.hasPausedExecutions()).toBe(false);
    }),
  );
});

describe("formatPausedExecution approval terms", () => {
  const paused = (request: FormElicitation) =>
    ({
      id: "exec_1",
      elicitationContext: {
        address: "tools.x.org.default.y",
        args: {},
        request,
      },
    }) as Parameters<typeof formatPausedExecution>[0];

  it("states the terms an upstream attached to the approval", () => {
    // An empty schema makes this look like a plain yes/no, but the metadata
    // says accepting persists for the origin — so the answer differs, and the
    // caller has to be able to see it.
    const result = formatPausedExecution(
      paused(
        FormElicitation.make({
          message: "Allow Browser use to access https://example.com?",
          requestedSchema: {},
          meta: { persist: "always", origin: "https://example.com" },
        }),
      ),
    );

    expect(result.text).toContain("Approval terms:");
    expect(result.text).toContain('"persist": "always"');
    expect((result.structured["interaction"] as { readonly meta?: unknown }).meta).toEqual({
      persist: "always",
      origin: "https://example.com",
    });
  });

  it("says nothing about terms when the upstream attached none", () => {
    const result = formatPausedExecution(
      paused(FormElicitation.make({ message: "Proceed?", requestedSchema: {} })),
    );

    expect(result.text).not.toContain("Approval terms:");
    expect((result.structured["interaction"] as Record<string, unknown>)["meta"]).toBeUndefined();
  });
});

// Pins the exact preview and structured shapes so the serialization dedupe in
// the engine cannot drift them: the preview stays pretty-printed (indent 2),
// truncation keeps its exact suffix, and structured carries the raw value.
describe("formatExecuteResult output identity", () => {
  const MAX_PREVIEW_CHARS = 30_000;

  it("renders an object result as pretty-printed JSON and keeps the raw value in structured", () => {
    const value = { café: "naïve — ✓", emoji: "🎉", nested: { π: 3.14159 } };
    const formatted = formatExecuteResult({ result: value, logs: [] });

    expect(formatted.text).toBe(JSON.stringify(value, null, 2));
    expect(formatted.structured).toEqual({
      status: "completed",
      result: value,
      logs: [],
    });
    expect(formatted.structured["result"]).toBe(value);
    expect(formatted.isError).toBe(false);
  });

  it("truncates a long preview with the exact suffix and untouched structured value", () => {
    const value = { data: "é🎉".repeat(12_000) };
    const pretty = JSON.stringify(value, null, 2);
    expect(pretty.length).toBeGreaterThan(MAX_PREVIEW_CHARS);

    const formatted = formatExecuteResult({ result: value });

    expect(formatted.text).toBe(
      `${pretty.slice(0, MAX_PREVIEW_CHARS)}\n... [truncated ${pretty.length - MAX_PREVIEW_CHARS} chars]`,
    );
    expect(formatted.structured["result"]).toBe(value);
  });

  it("returns a string result verbatim", () => {
    const formatted = formatExecuteResult({
      result: "plain — ✓",
      logs: ["l1", "l2"],
    });

    expect(formatted.text).toBe("plain — ✓\n\nLogs:\nl1\nl2");
    expect(formatted.structured).toEqual({
      status: "completed",
      result: "plain — ✓",
      logs: ["l1", "l2"],
    });
  });

  it("renders an error result with logs and truncation", () => {
    const formatted = formatExecuteResult({
      result: null,
      error: "boom",
      errorKind: "tool_error",
      logs: ["x".repeat(MAX_PREVIEW_CHARS)],
    });

    const untruncated = `Error: boom\n\nLogs:\n${"x".repeat(MAX_PREVIEW_CHARS)}`;
    expect(formatted.text).toBe(
      `${untruncated.slice(0, MAX_PREVIEW_CHARS)}\n... [truncated ${untruncated.length - MAX_PREVIEW_CHARS} chars]`,
    );
    expect(formatted.isError).toBe(true);
    expect(formatted.structured).toEqual({
      status: "error",
      error: "boom",
      logs: ["x".repeat(MAX_PREVIEW_CHARS)],
    });
  });
});

// The result-size span metric walks the whole result value with
// `JSON.stringify`. A `toJSON` probe inside the fixture counts full walks:
// every complete stringify of the value visits the probe exactly once.
describe("execute outcome measurement cost", () => {
  const instrumented = () => {
    let walks = 0;
    const probe = {
      toJSON: () => {
        walks += 1;
        return "probe";
      },
    };
    return { value: { data: [1, 2, 3], probe }, walks: () => walks };
  };

  const executorFor = (result: ExecuteResult): CodeExecutor<FakeRuntimeError> => ({
    execute: () => Effect.succeed(result),
  });

  it.effect("walks the result value once on the pausable path", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const fixture = instrumented();
      const engine = createExecutionEngine({
        executor,
        codeExecutor: executorFor({ result: fixture.value, logs: [] }),
      });

      const outcome = yield* engine.executeWithPause("noop");

      expect(outcome.status).toBe("completed");
      expect(fixture.walks()).toBe(1);
    }),
  );

  it.effect("walks the result value once even when autoApprove stamps two spans", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const fixture = instrumented();
      const engine = createExecutionEngine({
        executor,
        codeExecutor: executorFor({ result: fixture.value, logs: [] }),
      });

      // autoApprove runs the inline path (inner span annotation) and then
      // annotates the outer pausable span with the same result.
      const outcome = yield* engine.executeWithPause("noop", {
        autoApprove: true,
      });

      expect(outcome.status).toBe("completed");
      expect(fixture.walks()).toBe(1);
    }),
  );

  it.effect("a completed execution plus its preview pays two walks total", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const fixture = instrumented();
      const engine = createExecutionEngine({
        executor,
        codeExecutor: executorFor({ result: fixture.value, logs: [] }),
      });

      const outcome = yield* engine.executeWithPause("noop");
      expect(outcome.status).toBe("completed");
      if (outcome.status !== "completed") return;

      // One compact walk for the span size metric, one pretty walk for the
      // preview. They produce different strings (compact vs indent 2), so
      // neither can be derived from the other.
      formatExecuteResult(outcome.result);
      expect(fixture.walks()).toBe(2);
    }),
  );
});
