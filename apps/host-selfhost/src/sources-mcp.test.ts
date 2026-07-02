import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";
import { afterAll, expect, test } from "@effect/vitest";

import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk";
import { makeScopedExecutor } from "@executor-js/api/server";

import { createSelfHostDb, SelfHostDb } from "./db/self-host-db";
import { mintInviteCode } from "./testing/mint-invite";
import { SelfHostScopedExecutorSeams } from "./execution";
import type { SelfHostPlugins } from "./plugins";

// The self-host scoped-executor seams (DbProvider over the long-lived SelfHostDb,
// fresh per-request plugins, host config) over the shared `makeScopedExecutor`,
// leaving `SelfHostDb` as the only requirement (the production path provides the
// same seams via `SelfHostExecutionStackLayer`).
const createScopedExecutor = (
  accountId: string,
  organizationId: string,
  organizationName: string,
) =>
  makeScopedExecutor<SelfHostPlugins>(accountId, organizationId, organizationName).pipe(
    Effect.provide(SelfHostScopedExecutorSeams),
  );

// End-to-end: an org-owned connection's tools are reachable from a user's MCP
// `execute` sandbox.
const dataDir = mkdtempSync(join(tmpdir(), "eh-srcmcp-"));
const dbPath = join(dataDir, "data.db");
process.env.EXECUTOR_DATA_DIR = dataDir;
process.env.BETTER_AUTH_SECRET = "srcmcp-secret-0123456789-abcdefghij-klmnop";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "admin@srcmcp.test";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "admin-pass-123456";

const TINY_SPEC = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Tiny", version: "1.0.0" },
  servers: [{ url: "https://httpbin.org" }],
  paths: {
    "/get": {
      get: {
        operationId: "httpGet",
        summary: "Tiny get operation",
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

const { makeSelfHostApiHandler } = await import("./app");
const { handler, dispose } = await makeSelfHostApiHandler({ dbPath });
afterAll(() => dispose());

const BASE = "http://localhost:4788";

const addOrgSource = async (organizationId: string): Promise<void> => {
  // Register the integration and attach an org-owned connection, on its own
  // connection to the shared DB file. WAL makes the committed rows visible to
  // the server. Org-owned connections (and their per-connection tools) are
  // shared across every member of the tenant.
  const seedDb = await createSelfHostDb({
    path: dbPath,
    namespace: "executor_selfhost",
    version: "1.0.0",
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const admin = yield* createScopedExecutor("seed", organizationId, "Default");
      yield* admin.openapi.addSpec({
        spec: { kind: "blob", value: TINY_SPEC },
        slug: "tiny",
        baseUrl: "",
      });
      yield* admin.connections.create({
        owner: "org",
        name: ConnectionName.make("shared"),
        integration: IntegrationSlug.make("tiny"),
        template: AuthTemplateSlug.make("none"),
        value: "",
      });
    }).pipe(Effect.provide(Layer.succeed(SelfHostDb)(seedDb)), Effect.scoped),
  );
  await seedDb.close();
};

test("a user's MCP execute sandbox can reach an org-owned connection's tools", async () => {
  const inviteCode = await mintInviteCode(handler);
  const su = await handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "u@srcmcp.test",
        password: "password-12345678",
        name: "U",
        inviteCode,
      }),
    }),
  );
  const token = su.headers.get("set-auth-token") ?? "";
  expect(token).not.toBe("");

  // The user's real org id (Better Auth assigns a random org id) — the tenant the
  // per-request executor binds to.
  const meRes = await handler(
    new Request(`${BASE}/api/account/me`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  const organizationId = ((await meRes.json()) as { organization: { id: string } }).organization.id;

  await addOrgSource(organizationId);

  const mcp = (body: unknown, sessionId?: string) =>
    handler(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: JSON.stringify(body),
      }),
    );

  const init = await mcp({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    },
  });
  const sessionId = init.headers.get("mcp-session-id") ?? "";
  expect(sessionId).not.toBe("");
  await init.text();
  await mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);

  const call = await mcp(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "execute",
        arguments: {
          code: 'export default (await tools.search({ query: "tiny get operation", limit: 10 })).items.map((m) => m.path)',
        },
      },
    },
    sessionId,
  );
  expect(call.status).toBe(200);
  expect(JSON.stringify(await call.json())).toContain("tiny");
});
