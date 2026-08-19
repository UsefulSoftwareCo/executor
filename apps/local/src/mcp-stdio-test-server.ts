import { Effect } from "effect";

import type { ExecutionEngine, ExecutionResult } from "@executor-js/execution";
import { FormElicitation, ToolAddress } from "@executor-js/sdk";

import { runMcpStdioServer } from "./mcp";

const TOOL_ADDRESS = ToolAddress.make("tools.test.org.main.approve");
const paused: Extract<ExecutionResult, { status: "paused" }> = {
  status: "paused",
  execution: {
    id: "stdio-execution",
    elicitationContext: {
      address: TOOL_ADDRESS,
      args: {},
      request: FormElicitation.make({
        message: "Approve the stdio action?",
        requestedSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      }),
    },
  },
};

const engine: ExecutionEngine = {
  execute: () => Effect.succeed({ result: "unused" }),
  executeWithPause: (code) =>
    code === "needs approval"
      ? Effect.succeed(paused)
      : Effect.succeed({ status: "completed", result: { result: 4 } }),
  resume: (_executionId, response) =>
    Effect.succeed({ status: "completed", result: { result: response.content?.value } }),
  isExecutionSettled: () => Effect.succeed(false),
  getPausedExecution: (executionId) =>
    Effect.succeed(executionId === paused.execution.id ? paused.execution : null),
  pausedExecutionCount: () => Effect.succeed(1),
  hasPausedExecutions: () => Effect.succeed(true),
  getDescription: Effect.succeed("stdio integration test executor"),
};

await runMcpStdioServer({ engine, elicitationMode: { mode: "native" } });
