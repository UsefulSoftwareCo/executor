import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { createExecutor, definePlugin } from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import { createExecutionEngine } from "@executor-js/execution";
import { toPromiseExecutionEngine } from "@executor-js/execution/promise";

import { createExecutorEveTools } from "./index";

// ---------------------------------------------------------------------------
// Integration: drive the eve tools against the REAL execution stack (real
// QuickJS sandbox + real Executor), not a stubbed engine. Proves the adapter
// actually runs model-authored TypeScript and surfaces real results/errors.
//
// `createExecutor` requires a Scope, so these run as `it.effect`: the executor
// is acquired in the test scope and the adapter's Promise API is bridged back
// with `Effect.promise`.
// ---------------------------------------------------------------------------

const codeExecutor = makeQuickJsExecutor();

const emptyPlugin = definePlugin(() => ({
  id: "empty-eve-test" as const,
  storage: () => ({}),
  staticSources: () => [],
}));

const buildTools = Effect.gen(function* () {
  const executor = yield* createExecutor(makeTestConfig({ plugins: [emptyPlugin()] as const }));
  const engine = toPromiseExecutionEngine(createExecutionEngine({ executor, codeExecutor }));
  return yield* Effect.promise(() => createExecutorEveTools({ engine }));
});

describe("integration: real engine + QuickJS sandbox", () => {
  it.effect("evaluates real TypeScript and returns the result", () =>
    Effect.gen(function* () {
      const tools = yield* buildTools;
      const out = yield* Effect.promise(() => tools.execute.execute({ code: "return 1 + 1" }));

      expect(out.status).toBe("completed");
      expect(out.data.result).toBe(2);
      expect(out.text).toContain("2");
    }),
  );

  it.effect("injects the Executor tools runtime into the sandbox", () =>
    Effect.gen(function* () {
      const tools = yield* buildTools;
      // `tools` is the runtime surface the model drives; proving it exists in
      // the sandbox confirms the adapter wired the real engine, not bare JS.
      const out = yield* Effect.promise(() =>
        tools.execute.execute({ code: "return typeof tools.search" }),
      );

      expect(out.status).toBe("completed");
      expect(out.data.result).toBe("function");
    }),
  );

  it.effect("surfaces a real runtime error as an error envelope (never throws)", () =>
    Effect.gen(function* () {
      const tools = yield* buildTools;
      const out = yield* Effect.promise(() =>
        tools.execute.execute({ code: "return missingReference" }),
      );

      expect(out.status).toBe("error");
      expect(out.text.toLowerCase()).toContain("error");
    }),
  );

  it.effect("resume against the real engine reports an unknown execution", () =>
    Effect.gen(function* () {
      const tools = yield* buildTools;
      const out = yield* Effect.promise(() =>
        tools.resume.execute({ executionId: "exec_nope", action: "accept", content: "{}" }),
      );

      expect(out.status).toBe("execution_not_found");
      expect(out.data).toMatchObject({ executionId: "exec_nope", recovery: "re_execute" });
    }),
  );
});
