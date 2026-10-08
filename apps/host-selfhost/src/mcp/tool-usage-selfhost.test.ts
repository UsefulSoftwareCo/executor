import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, expect, it } from "@effect/vitest";
import { createClient } from "@libsql/client";
import { Effect, Schema } from "effect";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk";
import { makeScopedExecutor } from "@executor-js/api/server";
import { createSelfHostDb, SelfHostDb } from "../db/self-host-db";
import { SelfHostScopedExecutorSeams } from "../execution";
import type { SelfHostPlugins } from "../plugins";

const dir = mkdtempSync(join(tmpdir(), "executor-usage-http-"));
process.env.EXECUTOR_DATA_DIR = dir;
process.env.BETTER_AUTH_SECRET = "usage-test-secret-0123456789-abcdefghij-klmnop";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "admin@usage.test";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "admin-pass-123456";
// The sandbox test calls a loopback OpenAPI upstream through the outbound guard.
const originalAllowLocalNetwork = process.env.EXECUTOR_ALLOW_LOCAL_NETWORK;
process.env.EXECUTOR_ALLOW_LOCAL_NETWORK = "true";

const decodeResponse = Schema.decodeUnknownSync(
  Schema.Struct({
    result: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Unknown),
  }),
);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeSummary = Schema.decodeUnknownSync(
  Schema.Struct({
    tools: Schema.Array(
      Schema.Struct({
        mcp_tool: Schema.String,
        target_tool: Schema.NullOr(Schema.String),
        integration_slug: Schema.NullOr(Schema.String),
        calls: Schema.Number,
        ok: Schema.Number,
        blocked: Schema.Number,
        error: Schema.Number,
      }),
    ),
    integrations: Schema.Array(
      Schema.Struct({ integration_slug: Schema.String, calls: Schema.Number }),
    ),
    losses: Schema.Struct({ dropped_events: Schema.Number }),
  }),
);
const decodeOrganization = Schema.decodeUnknownSync(
  Schema.Struct({ organization: Schema.Struct({ id: Schema.String }) }),
);
const decodeExecute = Schema.decodeUnknownSync(
  Schema.Struct({
    result: Schema.Struct({
      structuredContent: Schema.Struct({
        status: Schema.String,
        executionId: Schema.optional(Schema.String),
        approvalUrl: Schema.optional(Schema.String),
        toolPaths: Schema.optional(Schema.Array(Schema.String)),
        toolCalls: Schema.optional(
          Schema.Array(
            Schema.Struct({
              path: Schema.String,
              status: Schema.Literals(["ok", "error", "blocked"]),
            }),
          ),
        ),
      }),
    }),
  }),
);

const dbPath = join(dir, "usage.db");
const BASE = "http://localhost:4788";

// Real HTTP results pass through the OpenAPI plugin and sandbox invoker.
let flakyCalls = 0;
const target: Server = createServer((request, response) => {
  const failed = request.url === "/fail" || (request.url === "/flaky" && ++flakyCalls % 2 === 0);
  response.statusCode = failed ? 400 : 200;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ secret: "upstream-secret" }));
});
const targetUrl = await new Promise<string>((done) => {
  target.listen(0, "127.0.0.1", () => {
    const address = target.address();
    done(typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "");
  });
});
afterAll(async () => {
  if (originalAllowLocalNetwork === undefined) delete process.env.EXECUTOR_ALLOW_LOCAL_NETWORK;
  else process.env.EXECUTOR_ALLOW_LOCAL_NETWORK = originalAllowLocalNetwork;
  await new Promise<void>((done) => target.close(() => done()));
});

const fixtureSpec = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Usage fixture", version: "1" },
  servers: [{ url: targetUrl }],
  paths: {
    "/read": {
      get: { operationId: "readFirst", responses: { "200": { description: "ok" } } },
    },
    "/fail": {
      get: { operationId: "readFailed", responses: { "400": { description: "error" } } },
    },
    "/blocked": {
      get: { operationId: "readBlocked", responses: { "200": { description: "ok" } } },
    },
    "/flaky": {
      get: {
        operationId: "readFlaky",
        responses: { "200": { description: "ok" }, "400": { description: "error" } },
      },
    },
    "/other": {
      get: { operationId: "readOther", responses: { "200": { description: "ok" } } },
    },
  },
});

/** Register an org-owned connection on its own DB handle; WAL makes it visible to the app. */
const addOrgIntegration = async (
  organizationId: string,
  path = dbPath,
  approval = false,
): Promise<void> => {
  const seedDb = await createSelfHostDb({
    path,
    namespace: "executor_selfhost",
    version: "1.0.0",
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const admin = yield* makeScopedExecutor<SelfHostPlugins>("seed", organizationId, "Default");
      yield* admin.openapi.addSpec({
        spec: { kind: "blob", value: fixtureSpec },
        slug: "fixture",
        baseUrl: "",
      });
      yield* admin.policies.create({
        owner: "org",
        pattern: "fixture.org.shared.blocked.readBlocked",
        action: "block",
      });
      if (approval) {
        for (const pattern of [
          "fixture.org.shared.other.readOther",
          "fixture.org.shared.flaky.readFlaky",
        ])
          yield* admin.policies.create({ owner: "org", pattern, action: "require_approval" });
      }
      yield* admin.connections.create({
        owner: "org",
        name: ConnectionName.make("shared"),
        integration: IntegrationSlug.make("fixture"),
        template: AuthTemplateSlug.make("none"),
        value: "",
      });
    }).pipe(
      Effect.provide(SelfHostScopedExecutorSeams),
      Effect.provideService(SelfHostDb, seedDb),
      Effect.scoped,
    ),
  );
  await seedDb.close();
};

const readSummary = () => {
  const output = execFileSync(
    "bun",
    ["run", resolve("scripts/tool-usage-summary.ts"), "--db", dbPath],
    {
      encoding: "utf8",
    },
  );
  return { output, summary: decodeSummary(decodeJson(output)) };
};

const openSession = async (
  handler: (request: Request) => Promise<Response>,
  token: string,
  query: string,
) => {
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const init = await handler(
    new Request(`${BASE}/mcp?${query}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "usage-test", version: "1" },
        },
      }),
    }),
  );
  expect(init.status).toBe(200);
  await init.text();
  const sessionHeaders = { ...headers, "mcp-session-id": init.headers.get("mcp-session-id")! };
  return async (id: number, name: string, args: object) => {
    const response = await handler(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: sessionHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      }),
    );
    expect(response.status).toBe(200);
    return decodeResponse(await response.json());
  };
};

it("attributes real HTTP execution outcomes once across model and browser approval resumes", async () => {
  const { makeSelfHostApiHandler } = await import("../app");
  const pauseDbPath = join(dir, "pause.db");
  const app = await makeSelfHostApiHandler({ dbPath: pauseDbPath });
  const approvalStatuses: number[] = [];
  const browserSessions: string[] = [];
  const replays: unknown[] = [];
  const replayOutcomes: unknown[] = [];
  const expected: { mcp_tool: string; target_tool: string; status: string }[] = [];
  const addExpected = (path: string, status: string) =>
    expected.push({ mcp_tool: "execute", target_tool: `tools.fixture.org.shared.${path}`, status });
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: flush telemetry and close the app even when an assertion fails
  try {
    const login = await app.handler(
      new Request(`${BASE}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "admin@usage.test", password: "admin-pass-123456" }),
      }),
    );
    expect(login.status).toBe(200);
    const token = login.headers.get("set-auth-token")!;
    const me = await app.handler(
      new Request(`${BASE}/api/account/me`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    await addOrgIntegration(decodeOrganization(await me.json()).organization.id, pauseDbPath, true);
    let id = 2;
    for (const mode of ["model", "browser"] as const) {
      const call = await openSession(app.handler, token, `artifacts=0&elicitation_mode=${mode}`);
      for (const action of ["accept", "decline", "cancel"] as const) {
        const paused = decodeExecute(
          await call(id++, "execute", {
            code: [
              "await tools.search({ query: 'argument-secret' });",
              "await tools.fixture.org.shared.read.readFirst({});",
              "await tools.fixture.org.shared.other.readOther({});",
              "await tools.fixture.org.shared.fail.readFailed({});",
              "await tools.fixture.org.shared.blocked.readBlocked({});",
              "console.log('log-secret'); return 'code-secret';",
            ].join("\n"),
          }),
        ).result.structuredContent;
        expect(paused.status).toBe(
          mode === "model" ? "waiting_for_interaction" : "user_approval_required",
        );
        expect(paused.toolCalls).toBeUndefined();
        const executionId = paused.executionId!;
        if (mode === "browser") {
          const sessionId = new URL(paused.approvalUrl!).searchParams.get("mcp_session_id")!;
          browserSessions.push(sessionId);
          const approval = await app.handler(
            new Request(`${BASE}/api/mcp-sessions/${sessionId}/executions/${executionId}/resume`, {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              body: JSON.stringify({ action, content: { secret: "approval-secret" } }),
            }),
          );
          approvalStatuses.push(approval.status);
        }
        const resumed = decodeExecute(await call(id++, "resume", { executionId, action })).result
          .structuredContent;
        expect(resumed.status).toBe(action === "accept" ? "completed" : "error");
        expect(resumed.toolCalls).toEqual([
          { path: "fixture.org.shared.read.readFirst", status: "ok" },
          {
            path: "fixture.org.shared.other.readOther",
            status: action === "accept" ? "ok" : "blocked",
          },
          ...(action === "accept"
            ? [
                { path: "fixture.org.shared.fail.readFailed", status: "error" },
                { path: "fixture.org.shared.blocked.readBlocked", status: "blocked" },
              ]
            : []),
        ]);
        addExpected("read.readFirst", action === "accept" ? "ok" : "error");
        addExpected("other.readOther", action === "accept" ? "ok" : "error");
        if (action === "accept") {
          addExpected("fail.readFailed", "error");
          addExpected("blocked.readBlocked", "blocked");
        }
        // Cached resume responses must not count another logical execution.
        if (mode === "model") {
          replays.push(
            decodeExecute(await call(id++, "resume", { executionId, action })).result
              .structuredContent,
          );
          replayOutcomes.push(resumed);
        }
      }
    }
    expect(browserSessions.every(Boolean)).toBe(true);
    expect(approvalStatuses).toEqual([200, 200, 200]);
    expect(replays).toEqual(replayOutcomes);
    const call = await openSession(app.handler, token, "artifacts=0&elicitation_mode=model");
    const initial = decodeExecute(
      await call(id++, "execute", {
        code: [
          "await tools.fixture.org.shared.read.readFirst({});",
          "await tools.fixture.org.shared.other.readOther({});",
          "await tools.fixture.org.shared.flaky.readFlaky({});",
          "throw new Error('script-secret');",
        ].join("\n"),
      }),
    ).result.structuredContent;
    const firstId = initial.executionId!;
    const next = decodeExecute(
      await call(id++, "resume", { executionId: firstId, action: "accept" }),
    ).result.structuredContent;
    expect(next.status).toBe("waiting_for_interaction");
    expect(next.executionId).not.toBe(firstId);
    expect(
      decodeExecute(await call(id++, "resume", { executionId: firstId, action: "accept" })).result
        .structuredContent,
    ).toEqual(next);
    const results = await Promise.all([
      call(id++, "resume", { executionId: next.executionId!, action: "accept" }),
      call(id++, "resume", { executionId: next.executionId!, action: "accept" }),
    ]);
    expect(decodeExecute(results[0]).result.structuredContent.status).toBe("error");
    expect(decodeExecute(results[1]).result.structuredContent).toEqual(
      decodeExecute(results[0]).result.structuredContent,
    );
    for (const path of ["read.readFirst", "other.readOther", "flaky.readFlaky"])
      addExpected(path, "error");

    // Native mode takes engine.execute, with no pause or resume boundary.
    const inline = await openSession(app.handler, token, "artifacts=0&elicitation_mode=native");
    const final = decodeExecute(
      await inline(id++, "execute", {
        code: [
          "await tools.fixture.org.shared.read.readFirst({});",
          "await tools.fixture.org.shared.fail.readFailed({});",
          "await tools.fixture.org.shared.blocked.readBlocked({});",
          "console.log('log-secret'); return 'code-secret';",
        ].join("\n"),
      }),
    ).result.structuredContent;
    expect(final.status).toBe("completed");
    addExpected("read.readFirst", "ok");
    addExpected("fail.readFailed", "error");
    addExpected("blocked.readBlocked", "blocked");
  } finally {
    await app.dispose();
  }
  const metricsDb = createClient({ url: `file:${pauseDbPath}` });
  const rows = await metricsDb.execute("SELECT * FROM executor_tool_usage ORDER BY id");
  metricsDb.close();
  expect(
    rows.rows.map((row) => ({
      mcp_tool: row.mcp_tool,
      target_tool: row.target_tool,
      status: row.status,
    })),
  ).toEqual(expected);
  expect(
    rows.rows.every((row) => Number(row.response_bytes) > 0 && Number(row.duration_ms) >= 0),
  ).toBe(true);
  expect(JSON.stringify(rows.rows)).not.toMatch(
    /argument-secret|approval-secret|code-secret|upstream-secret|script-secret|log-secret|admin@usage.test|admin-pass|exec_|toolCalls|toolPaths/,
  );
});

it("records authenticated HTTP passthrough and sandbox execute calls and exposes a read-only CLI summary", async () => {
  const { makeSelfHostApiHandler } = await import("../app");
  const app = await makeSelfHostApiHandler({ dbPath });
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: always close the full app before reading its SQLite file
  try {
    const login = await app.handler(
      new Request(`${BASE}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "admin@usage.test", password: "admin-pass-123456" }),
      }),
    );
    expect(login.status).toBe(200);
    const token = login.headers.get("set-auth-token")!;
    const me = await app.handler(
      new Request(`${BASE}/api/account/me`, { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(me.status).toBe(200);
    await addOrgIntegration(decodeOrganization(await me.json()).organization.id);

    const call = await openSession(app.handler, token, "mode=passthrough&artifacts=0");
    await call(2, "search", { query: "argument-secret" });
    await call(3, "search", { query: "argument-secret" });
    const denied = await call(4, "invoke", {
      tool: "tools.sample.org.test.read",
      arguments: { secret: "invoke-secret" },
    });
    expect(JSON.stringify(denied)).toContain("Tool not found or blocked by policy");
    await call(5, "integrations", {});
    await call(6, "skills", {});

    const execute = await openSession(app.handler, token, "artifacts=0");
    const executed = decodeExecute(
      await execute(7, "execute", {
        code: [
          "const first = await tools.fixture.org.shared.read.readFirst({});",
          "const other = await tools.fixture.org.shared.other.readOther({});",
          "await tools.fixture.org.shared.read.readFirst({});",
          'await tools.search({ query: "code-secret" });',
          'return { first, other, note: "code-secret" };',
        ].join("\n"),
      }),
    );
    expect(executed.result.structuredContent.status).toBe("completed");
    expect(executed.result.structuredContent.toolPaths).toEqual([
      "fixture.org.shared.read.readFirst",
      "fixture.org.shared.other.readOther",
    ]);
    expect(executed.result.structuredContent.toolCalls).toEqual([
      { path: "fixture.org.shared.read.readFirst", status: "ok" },
      { path: "fixture.org.shared.other.readOther", status: "ok" },
    ]);
    const none = decodeExecute(await execute(8, "execute", { code: "return 6 * 7;" }));
    expect(none.result.structuredContent).not.toHaveProperty("toolPaths");
    expect(none.result.structuredContent).not.toHaveProperty("toolCalls");
    const mixed = decodeExecute(
      await execute(9, "execute", {
        code: [
          "await tools.fixture.org.shared.read.readFirst({});",
          "await tools.fixture.org.shared.fail.readFailed({});",
          "await tools.fixture.org.shared.blocked.readBlocked({});",
          "await tools.fixture.org.shared.flaky.readFlaky({});",
          "await tools.fixture.org.shared.flaky.readFlaky({});",
          "return 42;",
        ].join("\n"),
      }),
    );
    expect(mixed.result.structuredContent.status).toBe("completed");
    expect(mixed.result.structuredContent.toolPaths).toEqual([
      "fixture.org.shared.read.readFirst",
      "fixture.org.shared.flaky.readFlaky",
    ]);
    expect(mixed.result.structuredContent.toolCalls).toEqual([
      { path: "fixture.org.shared.read.readFirst", status: "ok" },
      { path: "fixture.org.shared.fail.readFailed", status: "error" },
      { path: "fixture.org.shared.blocked.readBlocked", status: "blocked" },
      { path: "fixture.org.shared.flaky.readFlaky", status: "error" },
    ]);
    const failed = decodeExecute(
      await execute(10, "execute", {
        code: "await tools.fixture.org.shared.read.readFirst({}); console.log('log-secret'); throw new Error('script-secret');",
      }),
    );
    expect(failed.result.structuredContent.status).toBe("error");
    expect(failed.result.structuredContent.toolPaths).toEqual([
      "fixture.org.shared.read.readFirst",
    ]);
    expect(failed.result.structuredContent.toolCalls).toEqual([
      { path: "fixture.org.shared.read.readFirst", status: "ok" },
    ]);
  } finally {
    await app.dispose();
  }
  const { output, summary } = readSummary();
  expect(summary.tools.find((tool) => tool.mcp_tool === "search")!.calls).toBe(2);
  expect(summary.tools.find((tool) => tool.mcp_tool === "invoke")!.blocked).toBe(1);
  const executes = summary.tools
    .filter((tool) => tool.mcp_tool === "execute")
    .map((tool) => [
      tool.target_tool,
      tool.integration_slug,
      tool.calls,
      tool.ok,
      tool.error,
      tool.blocked,
    ]);
  expect(executes).toEqual(
    expect.arrayContaining([
      ["tools.fixture.org.shared.read.readFirst", "fixture", 3, 2, 1, 0],
      ["tools.fixture.org.shared.other.readOther", "fixture", 1, 1, 0, 0],
      ["tools.fixture.org.shared.fail.readFailed", "fixture", 1, 0, 1, 0],
      ["tools.fixture.org.shared.flaky.readFlaky", "fixture", 1, 0, 1, 0],
      ["tools.fixture.org.shared.blocked.readBlocked", "fixture", 1, 0, 0, 1],
      [null, null, 1, 1, 0, 0],
    ]),
  );
  expect(executes).toHaveLength(6);
  // Execute targets rank beside the denied passthrough invoke, by integration.
  expect(summary.integrations).toEqual([
    { integration_slug: "fixture", calls: 7 },
    { integration_slug: "sample", calls: 1 },
  ]);
  expect(summary.tools.reduce((count, tool) => count + tool.calls, 0)).toBe(13);
  expect(summary.losses.dropped_events).toBe(0);
  expect(output).not.toMatch(
    /argument-secret|invoke-secret|code-secret|upstream-secret|admin@usage.test|admin-pass/,
  );
  const metricsDb = createClient({ url: `file:${dbPath}` });
  const rows = await metricsDb.execute("SELECT * FROM executor_tool_usage");
  metricsDb.close();
  expect(rows.rows).toHaveLength(13);
  expect(JSON.stringify(rows.rows)).not.toMatch(
    /argument-secret|invoke-secret|code-secret|upstream-secret|script-secret|log-secret|admin@usage.test|admin-pass|toolCalls|toolPaths/,
  );
  rmSync(dir, { recursive: true, force: true });
});
