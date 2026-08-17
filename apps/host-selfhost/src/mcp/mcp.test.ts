import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, test } from "@effect/vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { mintInviteCode } from "../testing/mint-invite";

process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-mcp-"));
process.env.BETTER_AUTH_SECRET = "mcp-test-secret-0123456789-abcdefghij-klmnop";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "admin@mcp.test";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "admin-pass-123456";

const { makeSelfHostApiHandler } = await import("../app");

const { handler, dispose } = await makeSelfHostApiHandler();
afterAll(() => dispose());

const BASE = "http://localhost:4788";

const signUp = async (email: string): Promise<string> => {
  const inviteCode = await mintInviteCode(handler);
  const res = await handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password-12345678", name: email, inviteCode }),
    }),
  );
  expect(res.status).toBe(200);
  return res.headers.get("set-auth-token") ?? "";
};

const mcp = (token: string, body: unknown, sessionId?: string) =>
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

const initSession = async (token: string): Promise<string> => {
  const res = await mcp(token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");
  const sessionId = res.headers.get("mcp-session-id") ?? "";
  expect(sessionId).not.toBe("");
  await res.text();
  await mcp(token, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
  return sessionId;
};

test("an authenticated MCP client initializes, lists tools, and executes code", async () => {
  const token = await signUp("alice@mcp.test");
  const sessionId = await initSession(token);

  const list = await mcp(token, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sessionId);
  const listBody = (await list.json()) as { result: { tools: ReadonlyArray<{ name: string }> } };
  expect(listBody.result.tools.map((tool) => tool.name)).toContain("execute");

  const call = await mcp(
    token,
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "execute", arguments: { code: "export default 6 * 7" } },
    },
    sessionId,
  );
  expect(call.status).toBe(200);
  expect(JSON.stringify(await call.json())).toContain("42");
});

test("an authenticated modern MCP client discovers, lists tools, and executes code", async () => {
  const token = await signUp("modern@mcp.test");
  const seenMethods: string[] = [];
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
      const body = (await request.clone().json()) as { readonly method?: string };
      if (body.method) seenMethods.push(body.method);
      const headers = new Headers(request.headers);
      headers.set("authorization", `Bearer ${token}`);
      return handler(new Request(request, { headers }));
    },
  });
  const client = new Client(
    { name: "selfhost-modern-test", version: "1.0.0" },
    { capabilities: {}, versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );

  await client.connect(transport);
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: always close the authenticated modern client
  try {
    expect(seenMethods).toContain("server/discover");
    expect((await client.listTools()).tools.map(({ name }) => name)).toContain("execute");
    const result = await client.callTool({
      name: "execute",
      arguments: { code: "export default 6 * 7" },
    });
    expect(JSON.stringify(result)).toContain("42");
  } finally {
    await client.close();
  }
});

test("an MCP session cannot be reused by another user, and unauth is rejected", async () => {
  const alice = await signUp("alice2@mcp.test");
  const bob = await signUp("bob2@mcp.test");
  const aliceSession = await initSession(alice);

  // Bob presents Alice's session id with his own token. Cross-bearer access is
  // 403 JSON-RPC -32003 — unified with cloud's "does not belong" contract
  // (deliberate self-host change from the prior 404).
  const reuse = await mcp(bob, { jsonrpc: "2.0", id: 9, method: "tools/list" }, aliceSession);
  expect(reuse.status).toBe(403);
  const reuseBody = (await reuse.json()) as {
    readonly jsonrpc: string;
    readonly error?: { readonly code: number; readonly message: string };
  };
  expect(reuseBody.jsonrpc).toBe("2.0");
  expect(reuseBody.error?.code).toBe(-32003);
  expect(reuseBody.error?.message).toMatch(/does not belong/i);

  // No credentials at all -> 401.
  const noAuth = await handler(
    new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      }),
    }),
  );
  expect(noAuth.status).toBe(401);
});

test("an unknown MCP session id resolves to 404 (-32001), distinct from cross-bearer 403", async () => {
  const carol = await signUp("carol@mcp.test");
  // A well-formed but never-created session id -> not-found, not forbidden.
  const unknown = await mcp(
    carol,
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    crypto.randomUUID(),
  );
  expect(unknown.status).toBe(404);
  const body = (await unknown.json()) as {
    readonly jsonrpc: string;
    readonly error?: { readonly code: number; readonly message: string };
  };
  expect(body.jsonrpc).toBe("2.0");
  expect(body.error?.code).toBe(-32001);
});

test("GET /mcp without a session id is 400; DELETE without a session id is 204", async () => {
  const dave = await signUp("dave@mcp.test");

  // GET needs an existing session id (streamable-HTTP SSE channel) -> 400.
  const get = await handler(
    new Request(`${BASE}/mcp`, {
      method: "GET",
      headers: { authorization: `Bearer ${dave}`, accept: "text/event-stream" },
    }),
  );
  expect(get.status).toBe(400);
  const getBody = (await get.json()) as {
    readonly jsonrpc: string;
    readonly error?: { readonly code: number };
  };
  expect(getBody.jsonrpc).toBe("2.0");
  expect(getBody.error?.code).toBe(-32000);

  // DELETE with no session id is a no-op -> 204, empty body, no engine built.
  const del = await handler(
    new Request(`${BASE}/mcp`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${dave}` },
    }),
  );
  expect(del.status).toBe(204);
  expect(await del.text()).toBe("");
});
