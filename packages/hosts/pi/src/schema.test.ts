// ---------------------------------------------------------------------------
// The contract test.
//
// This package hand-writes TypeBox schemas for tools a DIFFERENT package
// serves. Nothing else in CI would notice if Executor renamed a parameter or
// made an optional one required — Pi would just start sending calls the server
// rejects. So: stand up the real Executor MCP server, ask it what it serves,
// and compare against what we register.
//
// Descriptions are deliberately NOT compared. Ours are thin on purpose (the
// long-form guidance lives behind `skills`), so only the call-breaking shape is
// asserted: parameter names, JSON types, enum values, and which are required.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ExecutionEngine } from "@executor-js/execution";
import { createExecutorMcpServer } from "@executor-js/host-mcp/tool-server";

import { EXECUTE_PARAMETERS, RESUME_PARAMETERS, SKILLS_PARAMETERS } from "./tools";

/** The narrowest engine `createExecutorMcpServer` will accept. */
const stubEngine = (): ExecutionEngine<never> => ({
  execute: () => Effect.succeed({ result: "stub" }),
  executeWithPause: () => Effect.succeed({ status: "completed", result: { result: "stub" } }),
  resume: () => Effect.succeed(null),
  isExecutionSettled: undefined,
  getPausedExecution: () => Effect.succeed(null),
  pausedExecutionCount: () => Effect.succeed(0),
  hasPausedExecutions: () => Effect.succeed(false),
  getDescription: Effect.succeed("contract-test executor"),
  shutdown: Effect.void,
});

/**
 * Model elicitation is what config.ts pins the endpoint to, and it is what
 * makes `resume` take `action`/`content` rather than `executionId` alone.
 */
const withExecutorTools = async (assert: (tools: Map<string, unknown>) => void): Promise<void> => {
  const server = await Effect.runPromise(
    createExecutorMcpServer({ engine: stubEngine(), elicitationMode: { mode: "model" } }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "pi-contract-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    assert(new Map(listed.tools.map((tool) => [tool.name, tool.inputSchema])));
  } finally {
    await clientTransport.close();
    await serverTransport.close();
  }
};

type SchemaShape = {
  readonly properties: Record<string, string>;
  readonly required: readonly string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Reduce a JSON Schema to the part a caller can get wrong: each property's
 * type (plus enum members, which are equally call-breaking), and the required
 * set. TypeBox schemas are JSON Schema at runtime, so both sides go through
 * this unchanged.
 */
const shapeOf = (schema: unknown): SchemaShape => {
  expect(isRecord(schema), "schema should be an object").toBe(true);
  const record = schema as Record<string, unknown>;
  const properties = isRecord(record.properties) ? record.properties : {};
  const described: Record<string, string> = {};
  for (const [name, property] of Object.entries(properties)) {
    if (!isRecord(property)) continue;
    const type = typeof property.type === "string" ? property.type : "unknown";
    described[name] = Array.isArray(property.enum)
      ? `${type}(${[...property.enum].sort().join("|")})`
      : type;
  }
  const required = Array.isArray(record.required)
    ? [...record.required].filter((name): name is string => typeof name === "string").sort()
    : [];
  return { properties: described, required };
};

describe("the registered schemas match the tools Executor serves", () => {
  it("execute, skills, and resume line up parameter for parameter", async () => {
    await withExecutorTools((served) => {
      expect(
        [...served.keys()],
        "Executor should still serve the three tools this package registers",
      ).toEqual(expect.arrayContaining(["execute", "skills", "resume"]));

      expect(shapeOf(served.get("execute")), "execute").toEqual(shapeOf(EXECUTE_PARAMETERS));
      expect(shapeOf(served.get("skills")), "skills").toEqual(shapeOf(SKILLS_PARAMETERS));
      expect(shapeOf(served.get("resume")), "resume").toEqual(shapeOf(RESUME_PARAMETERS));
    });
  });
});
