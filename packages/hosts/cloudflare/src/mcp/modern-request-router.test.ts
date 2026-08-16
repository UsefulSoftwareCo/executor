import { describe, expect, it } from "@effect/vitest";
import { createRequestStateCodec } from "@modelcontextprotocol/server";
import { Effect } from "effect";

import type { ExecutionEngine } from "@executor-js/execution";
import {
  defaultMcpResource,
  type McpModernServerBuilder,
  type Principal,
} from "@executor-js/host-mcp";
import { buildMcpServer, mcpRequestStatePrincipal } from "@executor-js/host-mcp/tool-server";

import type { McpSessionProps } from "./agent-session-durable-object";
import {
  modernMcpExecutionOwnerRoute,
  type McpExecutionOwnerDirectory,
  type McpExecutionOwnerRecord,
} from "./execution-owner-directory";
import {
  classifyMcpProtocolEra,
  makeMcpModernRequestRouter,
  mcpCorsPreflightResponse,
  requireMcpRequestStateKey,
  type McpModernSessionNamespace,
  type McpModernSessionStub,
} from "./modern-request-router";

const REQUEST_STATE_KEY = "0123456789abcdef0123456789abcdef";

const principal: Principal = {
  accountId: "acct_1",
  organizationId: "org_1",
  organizationName: "Org 1",
  email: "user@example.test",
  name: "Test User",
  avatarUrl: null,
  roles: [],
};

const props: McpSessionProps = {
  session: {
    organizationId: principal.organizationId,
    userId: principal.accountId,
    elicitationMode: "native",
    resource: defaultMcpResource,
    webOrigin: "https://executor.test",
  },
};

const engine: ExecutionEngine = {
  execute: (code) => Effect.succeed({ result: code }),
  executeWithPause: (code) =>
    Effect.succeed({ status: "completed" as const, result: { result: code } }),
  resume: () => Effect.succeed(null),
  isExecutionSettled: () => Effect.succeed(false),
  getPausedExecution: () => Effect.succeed(null),
  pausedExecutionCount: () => Effect.succeed(0),
  hasPausedExecutions: () => Effect.succeed(false),
  getDescription: Effect.succeed("test engine"),
};

const modernBody = (input: {
  readonly method: string;
  readonly name?: string;
  readonly arguments?: Record<string, unknown>;
  readonly requestState?: string;
}) => ({
  jsonrpc: "2.0",
  id: 1,
  method: input.method,
  params: {
    ...(input.name ? { name: input.name } : {}),
    ...(input.arguments ? { arguments: input.arguments } : {}),
    ...(input.requestState ? { requestState: input.requestState } : {}),
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
});

const modernRequest = (body: ReturnType<typeof modernBody>): Request =>
  new Request("https://executor.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": body.method,
      ...(typeof body.params.name === "string" ? { "mcp-name": body.params.name } : {}),
    },
    body: JSON.stringify(body),
  });

class MemoryDirectory implements McpExecutionOwnerDirectory {
  readonly records = new Map<string, McpExecutionOwnerRecord>();

  put(record: McpExecutionOwnerRecord): Effect.Effect<void> {
    return Effect.sync(() => {
      this.records.set(record.executionId, record);
    });
  }

  get(executionId: string): Effect.Effect<McpExecutionOwnerRecord | null> {
    return Effect.sync(() => this.records.get(executionId) ?? null);
  }

  delete(executionId: string): Effect.Effect<void> {
    return Effect.sync(() => {
      this.records.delete(executionId);
    });
  }
}

type ForwardedRequest = {
  readonly id: string;
  readonly body: unknown;
};

class MemorySessions implements McpModernSessionNamespace<string> {
  readonly forwarded: ForwardedRequest[] = [];
  uniqueIds = 0;

  newUniqueId(): string {
    this.uniqueIds += 1;
    return `unique-${this.uniqueIds}`;
  }

  idFromName(name: string): string {
    return `name:${name}`;
  }

  idFromString(id: string): string {
    return `id:${id}`;
  }

  get(id: string): McpModernSessionStub {
    return {
      serveModernMcp: async (_request, _props, parsedBody) => {
        this.forwarded.push({ id, body: parsedBody });
        return new Response(JSON.stringify({ id }), {
          headers: { "content-type": "application/json" },
        });
      },
    };
  }
}

const makeBuilder = (builds: { count: number }): McpModernServerBuilder["Service"] => ({
  build: (_principal, options) => {
    builds.count += 1;
    const { resource: _resource, ...requestOptions } = options;
    return buildMcpServer({
      engine,
      elicitationMode: { mode: "native" },
      ...requestOptions,
    });
  },
});

const dispatch = async (input: {
  readonly body: ReturnType<typeof modernBody>;
  readonly sessions: MemorySessions;
  readonly directory: MemoryDirectory;
  readonly builder: McpModernServerBuilder["Service"];
}) => {
  const request = modernRequest(input.body);
  return makeMcpModernRequestRouter().fetch({
    request,
    parsedBody: input.body,
    principal,
    resource: defaultMcpResource,
    props,
    requestStateSigningKey: REQUEST_STATE_KEY,
    builder: input.builder,
    sessions: input.sessions,
    executionOwners: input.directory,
  });
};

const mintRequestState = async (executionId: string, ttlSeconds = 60): Promise<string> => {
  const binding = `tools/call\u0000${mcpRequestStatePrincipal(principal)}`;
  const codec = createRequestStateCodec<{ readonly executionId: string }>({
    key: REQUEST_STATE_KEY,
    ttlSeconds,
    bind: () => binding,
  });
  const encoded: unknown = await Reflect.apply(codec.mint, codec, [{ executionId }, {}]);
  return typeof encoded === "string" ? encoded : "";
};

describe("modern Cloudflare MCP worker routing", () => {
  it("echoes dynamic preflight headers with a static modern fallback", () => {
    const requested = "content-type, authorization, mcp-param-search";
    expect(mcpCorsPreflightResponse(requested).headers.get("access-control-allow-headers")).toBe(
      requested,
    );
    expect(mcpCorsPreflightResponse().headers.get("access-control-allow-headers")).toContain(
      "mcp-method",
    );
  });

  it("fails clearly when the shared modern signing secret is missing or short", () => {
    expect(() => requireMcpRequestStateKey(undefined)).toThrow("MCP_REQUEST_STATE_KEY");
    expect(() => requireMcpRequestStateKey("too-short")).toThrow("at least 32 bytes");
    expect(requireMcpRequestStateKey(REQUEST_STATE_KEY)).toBe(REQUEST_STATE_KEY);
  });

  it("keeps the canonical legacy classification on the existing transport branch", async () => {
    const legacyBody = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    const legacy = new Request("https://executor.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(legacyBody),
    });
    const modern = modernRequest(modernBody({ method: "tools/list" }));

    await expect(classifyMcpProtocolEra(legacy, legacyBody)).resolves.toBe("legacy");
    await expect(
      classifyMcpProtocolEra(modern, modernBody({ method: "tools/list" })),
    ).resolves.toBe("modern");
  });

  it("serves modern non-tools/call methods worker-side without touching a DO", async () => {
    const sessions = new MemorySessions();
    const builds = { count: 0 };
    const response = await dispatch({
      body: modernBody({ method: "tools/list" }),
      sessions,
      directory: new MemoryDirectory(),
      builder: makeBuilder(builds),
    });

    expect(response.status).toBe(200);
    expect(builds.count).toBe(1);
    expect(sessions.uniqueIds).toBe(0);
    expect(sessions.forwarded).toEqual([]);
  });

  it("forwards a fresh modern execute call to a new unique DO", async () => {
    const sessions = new MemorySessions();
    const builds = { count: 0 };
    const response = await dispatch({
      body: modernBody({
        method: "tools/call",
        name: "execute",
        arguments: { code: "1 + 1" },
      }),
      sessions,
      directory: new MemoryDirectory(),
      builder: makeBuilder(builds),
    });

    expect(await response.json()).toEqual({ id: "unique-1" });
    expect(builds.count).toBe(0);
    expect(sessions.forwarded.map(({ id }) => id)).toEqual(["unique-1"]);
  });

  it("forwards malformed modern tools/call requests to a new unique DO", async () => {
    const sessions = new MemorySessions();
    const builds = { count: 0 };

    await dispatch({
      body: modernBody({ method: "tools/call" }),
      sessions,
      directory: new MemoryDirectory(),
      builder: makeBuilder(builds),
    });

    expect(builds.count).toBe(0);
    expect(sessions.forwarded.map(({ id }) => id)).toEqual(["unique-1"]);
  });

  it("verifies continuation state and forwards to its modern owner DO", async () => {
    const executionId = "exec-owned";
    const state = await mintRequestState(executionId);
    const directory = new MemoryDirectory();
    directory.records.set(executionId, {
      executionId,
      owner: modernMcpExecutionOwnerRoute("owner-do-id"),
      accountId: principal.accountId,
      organizationId: principal.organizationId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ttlMs: 60_000,
    });
    const sessions = new MemorySessions();
    const builds = { count: 0 };

    await dispatch({
      body: modernBody({
        method: "tools/call",
        name: "execute",
        arguments: { code: "1 + 1" },
        requestState: state,
      }),
      sessions,
      directory,
      builder: makeBuilder(builds),
    });

    expect(builds.count).toBe(0);
    expect(sessions.uniqueIds).toBe(0);
    expect(sessions.forwarded.map(({ id }) => id)).toEqual(["id:owner-do-id"]);
  });

  it("uses a fresh worker server for an unknown continuation owner", async () => {
    const state = await mintRequestState("exec-missing");
    const sessions = new MemorySessions();
    const response = await dispatch({
      body: modernBody({
        method: "tools/call",
        name: "execute",
        arguments: { code: "1 + 1" },
        requestState: state,
      }),
      sessions,
      directory: new MemoryDirectory(),
      builder: makeBuilder({ count: 0 }),
    });
    const body = await response.json();

    expect(body).toMatchObject({
      result: { structuredContent: { status: "execution_not_found" } },
    });
    expect(sessions.uniqueIds).toBe(0);
    expect(sessions.forwarded).toEqual([]);
  });

  it("routes modern resume calls to an existing legacy owner when recorded", async () => {
    const executionId = "exec-legacy";
    const directory = new MemoryDirectory();
    directory.records.set(executionId, {
      executionId,
      owner: { sessionId: "legacy-session" },
      accountId: principal.accountId,
      organizationId: principal.organizationId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ttlMs: 60_000,
    });
    const sessions = new MemorySessions();

    await dispatch({
      body: modernBody({
        method: "tools/call",
        name: "resume",
        arguments: { executionId, action: "accept" },
      }),
      sessions,
      directory,
      builder: makeBuilder({ count: 0 }),
    });

    expect(sessions.forwarded.map(({ id }) => id)).toEqual(["id:legacy-session"]);
  });

  it("rejects tampered and expired continuation state without touching a DO", async () => {
    const valid = await mintRequestState("exec-invalid");
    const middle = Math.floor(valid.length / 2);
    const tampered = `${valid.slice(0, middle)}${valid[middle] === "A" ? "B" : "A"}${valid.slice(middle + 1)}`;
    const expired = await mintRequestState("exec-expired", -1);

    for (const requestState of [tampered, expired]) {
      const sessions = new MemorySessions();
      const response = await dispatch({
        body: modernBody({
          method: "tools/call",
          name: "execute",
          arguments: { code: "1 + 1" },
          requestState,
        }),
        sessions,
        directory: new MemoryDirectory(),
        builder: makeBuilder({ count: 0 }),
      });

      const body = await response.json();
      expect(body).toMatchObject({ error: { code: -32602 } });
      expect(sessions.uniqueIds).toBe(0);
      expect(sessions.forwarded).toEqual([]);
    }
  });
});
