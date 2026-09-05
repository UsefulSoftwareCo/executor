import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type {
  ExecutionEngine,
  ExecutionResult,
  PausedExecution,
  ResumeResponse,
} from "@executor-js/execution/promise";

import {
  createExecutorEveTools,
  type ExecuteToolInput,
  type ExecutorEveTool,
  type ExecutorEveTools,
  type ExecutorEveToolsConfig,
  type ExecutorToolEnvelope,
  type ResumeToolInput,
} from "./index";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const stubEngine = (overrides: Partial<ExecutionEngine>): ExecutionEngine => ({
  execute: async () => ({ result: "default" }),
  executeWithPause: async (): Promise<ExecutionResult> => ({
    status: "completed",
    result: { result: "default" },
  }),
  resume: async (): Promise<ExecutionResult | null> => null,
  getPausedExecution: async () => null,
  getDescription: async () => "test executor",
  ...overrides,
});

// A structural ElicitationContext is all `formatPausedExecution` reads
// (request._tag/message/requestedSchema, address, args), so no need to build
// the real tagged Schema instances here.
const formPause = (id: string): PausedExecution =>
  // oxlint-disable-next-line executor/no-double-cast -- test fixture: structural shape is sufficient for formatPausedExecution
  ({
    id,
    elicitationContext: {
      request: { _tag: "FormElicitation", message: "Approve this action?", requestedSchema: {} },
      address: "github.issues.create",
      args: { title: "Hi" },
    },
  }) as unknown as PausedExecution;

// ---------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------

describe("execute tool", () => {
  it("returns a completed envelope and projects text to the model", async () => {
    const tools: ExecutorEveTools = await createExecutorEveTools({
      engine: stubEngine({
        executeWithPause: async () => ({ status: "completed", result: { result: "hello" } }),
      }),
    });

    const out: ExecutorToolEnvelope = await tools.execute.execute({ code: "return 'hello'" });

    expect(out.status).toBe("completed");
    expect(out.text).toContain("hello");
    expect(out.data.status).toBe("completed");
    expect(tools.execute.toModelOutput(out)).toEqual({ type: "text", value: out.text });
  });

  it("surfaces a pause as a resumable envelope carrying the executionId", async () => {
    const tools = await createExecutorEveTools({
      engine: stubEngine({
        executeWithPause: async () => ({ status: "paused", execution: formPause("exec_1") }),
      }),
    });

    const out = await tools.execute.execute({ code: "await tools.github.issues.create({})" });

    expect(out.status).toBe("waiting_for_interaction");
    expect(out.data.executionId).toBe("exec_1");
    expect(out.text).toContain("Approve this action?");
    expect(out.text).toContain("exec_1");
  });

  it("never throws to the agent: a defect becomes an opaque error envelope", async () => {
    const seen: Array<{ error: unknown; correlationId: string }> = [];
    const tools = await createExecutorEveTools({
      engine: stubEngine({
        // Simulate a sandbox defect rejecting at the host boundary, the way the
        // Promise engine surfaces a failed Effect.
        executeWithPause: () => Effect.runPromise(Effect.fail({ kind: "sandbox-defect" })),
      }),
      onDefect: (error, correlationId) => seen.push({ error, correlationId }),
    });

    const out = await tools.execute.execute({ code: "boom" });

    expect(out.status).toBe("error");
    expect(out.text).toMatch(/Internal tool error \[[0-9a-f]{8}\]/);
    // The internal cause is logged out-of-band, never surfaced to the model.
    expect(out.text).not.toContain("sandbox-defect");
    expect(out.data).not.toMatchObject({ kind: "sandbox-defect" });
    expect(seen).toHaveLength(1);
    expect(out.text).toContain(seen[0]!.correlationId);
  });

  it("rejects empty/whitespace code at the schema", async () => {
    const tools = await createExecutorEveTools({ engine: stubEngine({}), description: "x" });
    const execute: ExecutorEveTool<ExecuteToolInput> = tools.execute;
    expect(execute.inputSchema.safeParse({ code: "" }).success).toBe(false);
    expect(execute.inputSchema.safeParse({ code: "   " }).success).toBe(false);
    expect(execute.inputSchema.safeParse({ code: "return 1" }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

describe("resume tool", () => {
  it("parses JSON content and forwards the response to the same engine", async () => {
    const calls: Array<{ id: string; response: ResumeResponse }> = [];
    const tools = await createExecutorEveTools({
      engine: stubEngine({
        resume: async (id, response) => {
          calls.push({ id, response });
          return { status: "completed", result: { result: "done" } };
        },
      }),
    });

    const input: ResumeToolInput = {
      executionId: "exec_1",
      action: "accept",
      content: '{"name":"value"}',
    };
    const out = await tools.resume.execute(input);

    expect(out.status).toBe("completed");
    expect(calls).toEqual([
      { id: "exec_1", response: { action: "accept", content: { name: "value" } } },
    ]);
  });

  it("treats default/empty/non-object content as no content", async () => {
    const seen: Array<ResumeResponse["content"]> = [];
    const tools = await createExecutorEveTools({
      engine: stubEngine({
        resume: async (_id, response) => {
          seen.push(response.content);
          return { status: "completed", result: { result: "ok" } };
        },
      }),
    });

    await tools.resume.execute({ executionId: "e", action: "accept", content: "{}" });
    await tools.resume.execute({ executionId: "e", action: "accept", content: "   " });
    await tools.resume.execute({ executionId: "e", action: "accept", content: "[1,2]" });

    expect(seen).toEqual([undefined, undefined, undefined]);
  });

  it("explains how to recover when the executionId is unknown", async () => {
    const tools = await createExecutorEveTools({
      engine: stubEngine({ resume: async () => null }),
    });

    const out = await tools.resume.execute({
      executionId: "gone",
      action: "cancel",
      content: "{}",
    });

    expect(out.status).toBe("execution_not_found");
    expect(out.data).toMatchObject({ executionId: "gone", recovery: "re_execute" });
    expect(out.text).toContain("Re-run execute");
  });

  it("defaults content so the schema accepts a bare accept", async () => {
    const { resume } = await createExecutorEveTools({ engine: stubEngine({}), description: "x" });
    const parsed = resume.inputSchema.parse({ executionId: "e", action: "accept" });
    expect(parsed.content).toBe("{}");
  });
});

// ---------------------------------------------------------------------------
// description / wiring
// ---------------------------------------------------------------------------

describe("description", () => {
  it("bakes the engine's dynamic description by default", async () => {
    let calls = 0;
    const tools = await createExecutorEveTools({
      engine: stubEngine({
        getDescription: async () => {
          calls += 1;
          return "dynamic: github, gmail";
        },
      }),
    });

    expect(tools.execute.description).toBe("dynamic: github, gmail");
    expect(calls).toBe(1);
  });

  it("uses an explicit description override without touching the engine", async () => {
    let calls = 0;
    const config: ExecutorEveToolsConfig = {
      engine: stubEngine({
        getDescription: async () => {
          calls += 1;
          return "unused";
        },
      }),
      description: "custom execute description",
    };
    const tools = await createExecutorEveTools(config);

    expect(tools.execute.description).toBe("custom execute description");
    expect(calls).toBe(0);
  });
});
