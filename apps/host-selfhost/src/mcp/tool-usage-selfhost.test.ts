import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, expect, it } from "@effect/vitest";
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
        toolPaths: Schema.optional(Schema.Array(Schema.String)),
      }),
    }),
  }),
);

const dbPath = join(dir, "usage.db");
const BASE = "http://localhost:4788";

// A loopback OpenAPI target: the sandbox only reports connected tools whose
// call succeeded, so the fixture integration must answer for real.
const target: Server = createServer((_request, response) => {
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
    "/other": {
      get: { operationId: "readOther", responses: { "200": { description: "ok" } } },
    },
  },
});

/** Register an org-owned connection on its own DB handle; WAL makes it visible to the app. */
const addOrgIntegration = async (organizationId: string): Promise<void> => {
  const seedDb = await createSelfHostDb({
    path: dbPath,
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
    const none = decodeExecute(await execute(8, "execute", { code: "return 6 * 7;" }));
    expect(none.result.structuredContent).not.toHaveProperty("toolPaths");
  } finally {
    await app.dispose();
  }
  const { output, summary } = readSummary();
  expect(summary.tools.find((tool) => tool.mcp_tool === "search")!.calls).toBe(2);
  expect(summary.tools.find((tool) => tool.mcp_tool === "invoke")!.blocked).toBe(1);
  const executes = summary.tools
    .filter((tool) => tool.mcp_tool === "execute")
    .map((tool) => [tool.target_tool, tool.integration_slug, tool.calls, tool.ok]);
  expect(executes).toEqual(
    expect.arrayContaining([
      ["tools.fixture.org.shared.read.readFirst", "fixture", 1, 1],
      ["tools.fixture.org.shared.other.readOther", "fixture", 1, 1],
      [null, null, 1, 1],
    ]),
  );
  expect(executes).toHaveLength(3);
  // Execute targets rank beside the denied passthrough invoke, by integration.
  expect(summary.integrations).toEqual([
    { integration_slug: "fixture", calls: 2 },
    { integration_slug: "sample", calls: 1 },
  ]);
  expect(summary.tools.reduce((count, tool) => count + tool.calls, 0)).toBe(8);
  expect(summary.losses.dropped_events).toBe(0);
  expect(output).not.toMatch(
    /argument-secret|invoke-secret|code-secret|upstream-secret|admin@usage.test|admin-pass/,
  );
  rmSync(dir, { recursive: true, force: true });
});
