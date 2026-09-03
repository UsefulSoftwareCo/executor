import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, test } from "@effect/vitest";

import { mintInviteCode } from "../testing/mint-invite";

process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-mcp-"));
process.env.BETTER_AUTH_SECRET = "mcp-test-secret-0123456789-abcdefghij-klmnop";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "admin@mcp.test";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "admin-pass-123456";

const { makeSelfHostApiHandler } = await import("../app");

const { handler, dispose } = await makeSelfHostApiHandler();
afterAll(() => dispose());

const BASE = "http://localhost:4788";

interface AuthenticatedIdentity {
  readonly token: string;
  readonly cookie: string;
}

const identityFromResponse = (response: Response): AuthenticatedIdentity => ({
  token: response.headers.get("set-auth-token") ?? "",
  cookie: response.headers.get("set-cookie")?.split(";", 1)[0] ?? "",
});

const signUpIdentity = async (email: string): Promise<AuthenticatedIdentity> => {
  const inviteCode = await mintInviteCode(handler);
  const res = await handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password-12345678", name: email, inviteCode }),
    }),
  );
  expect(res.status).toBe(200);
  return identityFromResponse(res);
};

const signUp = async (email: string): Promise<string> => (await signUpIdentity(email)).token;

const signInBootstrap = async (): Promise<AuthenticatedIdentity> => {
  const response = await handler(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL,
        password: process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD,
      }),
    }),
  );
  expect(response.status).toBe(200);
  return identityFromResponse(response);
};

const mcp = (token: string, body: unknown, sessionId?: string, browser = false) =>
  handler(
    new Request(`${BASE}/mcp${browser ? "?elicitation_mode=browser" : ""}`, {
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

const initSession = async (token: string, browser = false): Promise<string> => {
  const res = await mcp(
    token,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    },
    undefined,
    browser,
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");
  const sessionId = res.headers.get("mcp-session-id") ?? "";
  expect(sessionId).not.toBe("");
  await res.text();
  await mcp(token, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId, browser);
  return sessionId;
};

const account = (token: string, path: string, init?: RequestInit) =>
  handler(
    new Request(`${BASE}${path}`, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init?.headers)),
        authorization: `Bearer ${token}`,
      },
    }),
  );

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

test("a browser approval uses the bootstrap admin's demoted membership at the sink", async () => {
  const controller = await signInBootstrap();
  const actorEmail = "approval-role-actor@mcp.test";
  const actor = await signUpIdentity(actorEmail);

  const members = async (token: string) => {
    const response = await account(token, "/api/account/members");
    expect(response.status).toBe(200);
    return (await response.json()) as {
      readonly members: ReadonlyArray<{
        readonly id: string;
        readonly userId: string;
        readonly email: string;
        readonly role: string;
      }>;
    };
  };
  const setRole = (token: string, memberId: string, roleSlug: "admin" | "member") =>
    account(token, `/api/account/members/${encodeURIComponent(memberId)}/role`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roleSlug }),
    });

  const actorMember = (await members(controller.token)).members.find(
    (member) => member.email === actorEmail,
  );
  expect(actorMember?.role).toBe("member");
  if (!actorMember) return;
  expect((await setRole(controller.token, actorMember.id, "admin")).status).toBe(200);
  const globalAdmin = await account(controller.token, "/api/auth/admin/set-role", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: actorMember.userId, role: "admin" }),
  });
  expect(globalAdmin.status).toBe(200);

  const actorSession = await account(actor.token, "/api/auth/get-session");
  expect(actorSession.status).toBe(200);
  expect(
    ((await actorSession.json()) as { readonly user?: { readonly role?: string } }).user?.role,
  ).toBe("admin");

  const gateResponse = await account(actor.token, "/api/policies", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      owner: "org",
      pattern: "executor.coreTools.policies.create",
      action: "require_approval",
    }),
  });
  expect(gateResponse.status).toBe(200);
  const gate = (await gateResponse.json()) as { readonly id: string };

  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: async HTTP integration test guarantees role and policy cleanup after every assertion failure
  try {
    const sessionId = await initSession(actor.token, true);
    const pausedResponse = await mcp(
      actor.token,
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "execute",
          arguments: {
            code: [
              "return await tools.executor.coreTools.policies.create({",
              '  owner: "org",',
              '  pattern: "selfhost-live-role-regression.*",',
              '  action: "block"',
              "});",
            ].join("\n"),
          },
        },
      },
      sessionId,
      true,
    );
    const paused = (await pausedResponse.json()) as {
      readonly result?: {
        readonly structuredContent?: { readonly executionId?: string };
      };
    };
    const executionId = paused.result?.structuredContent?.executionId;
    expect(executionId).toBeTruthy();
    if (!executionId) return;

    expect((await setRole(controller.token, actorMember.id, "member")).status).toBe(200);

    const resumePromise = mcp(
      actor.token,
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "resume", arguments: { executionId } },
      },
      sessionId,
      true,
    );
    await Promise.resolve();
    const decision = await handler(
      new Request(
        `${BASE}/api/mcp-sessions/${encodeURIComponent(sessionId)}/executions/${encodeURIComponent(executionId)}/resume`,
        {
          method: "POST",
          headers: { "content-type": "application/json", cookie: actor.cookie },
          body: JSON.stringify({ action: "accept", content: {} }),
        },
      ),
    );
    expect(decision.status).toBe(200);
    const resumed = await resumePromise;
    expect(resumed.status).toBe(200);
    await resumed.text();

    const policiesResponse = await account(controller.token, "/api/policies");
    expect(policiesResponse.status).toBe(200);
    const policies = (await policiesResponse.json()) as ReadonlyArray<{ readonly pattern: string }>;
    expect(policies.some((policy) => policy.pattern === "selfhost-live-role-regression.*")).toBe(
      false,
    );
  } finally {
    await setRole(controller.token, actorMember.id, "admin");
    await account(actor.token, `/api/policies/${encodeURIComponent(gate.id)}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner: "org" }),
    });
    await account(controller.token, "/api/auth/admin/set-role", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: actorMember.userId, role: "user" }),
    });
  }
});
