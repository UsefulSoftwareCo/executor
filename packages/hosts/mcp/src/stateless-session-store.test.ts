import { expect, test } from "@effect/vitest";
import { Effect } from "effect";
import type { ExecutionEngine } from "@executor-js/execution";

import { createExecutorMcpServer } from "./tool-server";
import type { McpBuildServer } from "./in-memory-session-store";
import { makeStatelessMcpSessionStore } from "./stateless-session-store";
import type { Principal } from "./seams";

const engine: ExecutionEngine<never> = {
  execute: () => Effect.succeed({ result: "ok" }),
  executeWithPause: () => Effect.succeed({ status: "completed", result: { result: "ok" } }),
  resume: () => Effect.succeed(null),
  getPausedExecution: () => Effect.succeed(null),
  pausedExecutionCount: () => Effect.succeed(0),
  hasPausedExecutions: () => Effect.succeed(false),
  getDescription: Effect.succeed("test executor"),
};

const principal: Principal = {
  accountId: "account",
  organizationId: "organization",
  organizationName: "Organization",
  email: "test@example.com",
  name: "Test",
  avatarUrl: null,
  roles: ["admin"],
};

const request = (body: unknown): Request =>
  new Request("https://executor.example.com/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify(body),
  });

const buildServer: McpBuildServer = (_principal, options) =>
  createExecutorMcpServer({ engine, ...options }).pipe(
    Effect.map((mcpServer) => ({ mcpServer, engine })),
  );

test("stateless MCP handles independent POSTs without issuing a session id", async () => {
  const sessions = makeStatelessMcpSessionStore(buildServer);

  const initialized = await Effect.runPromise(
    sessions.store.dispatch({
      request: request({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
      principal,
      resource: { kind: "default" },
      sessionId: null,
      method: "POST",
    }),
  );
  expect(initialized).toBeInstanceOf(Response);
  if (!(initialized instanceof Response)) return;
  expect(initialized.status).toBe(200);
  expect(initialized.headers.get("mcp-session-id")).toBeNull();

  const listed = await Effect.runPromise(
    sessions.store.dispatch({
      request: request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      principal,
      resource: { kind: "default" },
      sessionId: null,
      method: "POST",
    }),
  );
  expect(listed).toBeInstanceOf(Response);
  if (!(listed instanceof Response)) return;
  expect(listed.status).toBe(200);
  expect(JSON.stringify(await listed.json())).toContain("execute");
});

test("stateless MCP rejects session-addressed requests", async () => {
  const sessions = makeStatelessMcpSessionStore(buildServer);
  const result = await Effect.runPromise(
    sessions.store.dispatch({
      request: request({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
      principal,
      resource: { kind: "default" },
      sessionId: "stale-session",
      method: "POST",
    }),
  );
  expect(result).toBe("not-found");
});
