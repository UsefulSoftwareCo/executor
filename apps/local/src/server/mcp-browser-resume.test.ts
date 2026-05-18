// ---------------------------------------------------------------------------
// Local app × MCP browser resume — real MCP execute + real approval API
// ---------------------------------------------------------------------------
//
// Exercises the browser-approval shape used by CLI/MCP clients that do not
// support managed MCP elicitation:
//
//   test → MCP SDK Client.callTool("execute") → Executor MCP host
//        → execution engine → sandbox code → real executor tool elicitations
//        → local approval API records the user's response
//        → MCP resume consumes the approved response and returns the result
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";

import { createExecutionEngine } from "@executor-js/execution";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import {
  FormElicitation,
  Scope,
  ScopeId,
  collectTables,
  createExecutor,
  definePlugin,
  type Executor,
} from "@executor-js/sdk";

import { createMcpRequestHandler } from "./mcp";
import { createSqliteFumaDb } from "./sqlite-fumadb";

const TEST_BASE_URL = "http://local.test";

const EmptyInputSchema = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(Schema.Struct({})),
);

const approvalPlugin = definePlugin(() => ({
  id: "browser-resume-test" as const,
  storage: () => ({}),
  staticSources: () => [
    {
      id: "api",
      kind: "in-memory",
      name: "API",
      tools: [
        {
          name: "singleApproval",
          description: "Elicit exactly once and return the user's response.",
          inputSchema: EmptyInputSchema,
          handler: ({ elicit }) =>
            Effect.gen(function* () {
              const response = yield* elicit(
                FormElicitation.make({
                  message: "Approve browser-resume test call",
                  requestedSchema: {
                    type: "object",
                    properties: {
                      note: { type: "string", title: "Approval note" },
                    },
                    required: ["note"],
                  },
                }),
              );
              return { ok: true, response };
            }),
        },
      ],
    },
  ],
}));

const makeExecutor = async (tmpDir: string): Promise<Executor> => {
  const plugins = [approvalPlugin()] as const;
  const sqlite = await createSqliteFumaDb({
    tables: collectTables(plugins),
    namespace: "executor_local_browser_resume_test",
    path: join(tmpDir, "data.db"),
  });
  const scope = Scope.make({
    id: ScopeId.make(`test-${randomBytes(4).toString("hex")}`),
    name: "test",
    createdAt: new Date(),
  });
  const executor = await Effect.runPromise(
    createExecutor({
      scopes: [scope],
      db: sqlite.db,
      plugins,
      onElicitation: "accept-all",
    }),
  );

  const close = executor.close;
  return {
    ...executor,
    close: () =>
      Effect.gen(function* () {
        yield* close();
        yield* Effect.promise(() => sqlite.close());
      }),
  };
};

const makeMcpFetch = (executor: Executor) => {
  const engine = createExecutionEngine({ executor, codeExecutor: makeQuickJsExecutor() });
  const mcp = createMcpRequestHandler({ engine });

  const fetchImpl: typeof globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.startsWith("/mcp")) return mcp.handleRequest(request);
      if (url.pathname.startsWith("/api/mcp-sessions/")) {
        return mcp.handleApprovalRequest(request);
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    },
    { preconnect: globalThis.fetch.preconnect },
  );

  return { fetch: fetchImpl, dispose: mcp.close };
};

const readStructuredRecord = (value: unknown): Record<string, unknown> => {
  expect(typeof value).toBe("object");
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
};

const readApproval = (structured: unknown): { readonly executionId: string; readonly url: URL } => {
  const record = readStructuredRecord(structured);
  expect(record.status).toBe("user_approval_required");
  expect(record).not.toHaveProperty("interaction");
  expect(typeof record.executionId).toBe("string");
  expect(typeof record.approvalUrl).toBe("string");
  expect(record.resumePrompt).toBe(
    "Return text to the user telling them to approve the action at this approvalUrl. Only after you have prompted the user, call the `resume` tool with this executionId; `resume` will wait for the user's browser decision.",
  );
  const { executionId, approvalUrl } = record as {
    readonly executionId: string;
    readonly approvalUrl: string;
  };
  return {
    executionId,
    url: new URL(approvalUrl),
  };
};

const readResultArray = (structured: unknown): ReadonlyArray<unknown> => {
  const record = readStructuredRecord(structured);
  expect(record.status).toBe("completed");
  expect(Array.isArray(record.result)).toBe(true);
  return record.result as ReadonlyArray<unknown>;
};

describe("local MCP browser approval resume", () => {
  it("continues multiple elicitations from one MCP execute call through the HTTP API path", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "executor-local-browser-resume-"));
    const executor = await makeExecutor(tmpDir);
    const { fetch, dispose } = makeMcpFetch(executor);
    const mcpClient = new Client(
      { name: "browser-resume-test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", TEST_BASE_URL), { fetch });

    await mcpClient.connect(transport);

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: test owns MCP transports, web handler, and executor lifecycle
    try {
      const first = await mcpClient.callTool({
        name: "execute",
        arguments: {
          code: `
            return await Promise.all([
              tools.api.singleApproval({}),
              tools.api.singleApproval({}),
              tools.api.singleApproval({})
            ]);
          `,
        },
      });

      expect(first.isError).toBeFalsy();
      const firstApproval = readApproval(first.structuredContent);

      const second = await approveInBrowserThenResume(fetch, mcpClient, firstApproval);
      const secondApproval = readApproval(second.structuredContent);
      expect(secondApproval.executionId).not.toBe(firstApproval.executionId);

      const third = await approveInBrowserThenResume(fetch, mcpClient, secondApproval);
      const thirdApproval = readApproval(third.structuredContent);
      expect(thirdApproval.executionId).not.toBe(firstApproval.executionId);
      expect(thirdApproval.executionId).not.toBe(secondApproval.executionId);

      const completed = await approveInBrowserThenResume(fetch, mcpClient, thirdApproval);
      const result = readResultArray(completed.structuredContent);
      expect(result).toHaveLength(3);
      expect(result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              response: expect.objectContaining({
                action: "accept",
                content: expect.objectContaining({ note: expect.stringContaining("approved-") }),
              }),
            }),
          }),
        ]),
      );
    } finally {
      await mcpClient.close();
      await Effect.runPromise(Effect.ignore(Effect.tryPromise(() => dispose())));
      await Effect.runPromise(
        Effect.ignore(Effect.tryPromise(() => Effect.runPromise(executor.close()))),
      );
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 10_000);
});

const approveInBrowserThenResume = async (
  fetch: typeof globalThis.fetch,
  client: Client,
  approval: { readonly executionId: string; readonly url: URL },
) => {
  const sessionId = approval.url.searchParams.get("mcp_session_id");
  expect(sessionId).not.toBeNull();

  const resume = client.callTool({
    name: "resume",
    arguments: { executionId: approval.executionId },
  });

  const approvalResponse = await fetch(
    new URL(
      `/api/mcp-sessions/${encodeURIComponent(sessionId!)}/executions/${encodeURIComponent(approval.executionId)}/resume`,
      TEST_BASE_URL,
    ),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "accept",
        content: { note: `approved-${approval.executionId}` },
      }),
    },
  );
  expect(approvalResponse.status).toBe(200);

  return await resume;
};
