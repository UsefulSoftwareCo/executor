// ---------------------------------------------------------------------------
// /mcp — end-to-end tests via SELF.fetch into the workerd test pool
// ---------------------------------------------------------------------------
//
// These tests drive the real pipeline, not a stub:
//
//   SELF.fetch
//     → test-worker's default.fetch
//     → HttpApp.toWebHandler(mcpApp, { McpAuth: test })
//     → mcpApp: CORS / OAuth metadata / auth / dispatch
//     → env.MCP_SESSION.idFromString() → stub.handleRequest()
//     → the real McpSessionDO stale-session path
//
// Two auth seams are faked: `McpAuth.verifyBearer` and the live WorkOS
// membership check. The real bearer impl calls WorkOS's JWKS endpoint,
// which we can't reach from the test isolate.
// Test bearer format is `test-accept::<accountId>::<orgId|none>`
// (see `makeTestBearer` in test-worker.ts).
//
// The node-pool test (`mcp-session.e2e.node.test.ts`) covers the DO's
// internal wiring with an InMemoryTransport and skips HTTP entirely.
// This suite is its complement: it drives edge behavior that workerd can
// exercise without violating its cross-request I/O guard. Multi-request live
// MCP session coverage lives in `mcp-miniflare.e2e.node.test.ts`.
// ---------------------------------------------------------------------------

import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";

import { makeTestBearer } from "./test-bearer";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE = "https://test-resource.example.com";
const MCP_URL = `${BASE}/mcp`;
const OAUTH_RESOURCE_URL = `${BASE}/.well-known/oauth-protected-resource/mcp`;

const JSON_AND_SSE = "application/json, text/event-stream";
const CONTENT_TYPE_JSON = "application/json";
const HEARTBEAT_MS = 30 * 1000;
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;
const SESSION_META_KEY = "session-meta";
const LAST_ACTIVITY_KEY = "last-activity-ms";

const doRuntimeControls = (
  instance: unknown,
): {
  closeRuntime: () => Effect.Effect<void>;
} => instance as { closeRuntime: () => Effect.Effect<void> };

const doActivityState = (instance: unknown): { lastActivityMs: number } =>
  instance as { lastActivityMs: number };

const INITIALIZE_REQUEST = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "mcp-flow-e2e", version: "0.0.1" },
  },
};

const TOOLS_LIST_REQUEST = {
  jsonrpc: "2.0" as const,
  id: 2,
  method: "tools/list",
  params: {},
};

const INITIALIZED_NOTIFICATION = {
  jsonrpc: "2.0" as const,
  method: "notifications/initialized",
};

const nextOrgId = (() => {
  let seq = 0;
  return () => `org_mcp_flow_${++seq}_${crypto.randomUUID().slice(0, 8)}`;
})();

const nextAccountId = (() => {
  let seq = 0;
  return () => `user_mcp_flow_${++seq}_${crypto.randomUUID().slice(0, 8)}`;
})();

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

type McpPostInit = {
  readonly bearer?: string;
  readonly sessionId?: string | null;
  readonly body: unknown;
  readonly accept?: string;
};

const mcpPost = (init: McpPostInit): Promise<Response> => {
  const headers: Record<string, string> = {
    "content-type": CONTENT_TYPE_JSON,
    accept: init.accept ?? JSON_AND_SSE,
  };
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  if (init.sessionId) headers["mcp-session-id"] = init.sessionId;
  return SELF.fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(init.body),
  });
};

const mcpGet = (init: { readonly bearer: string; readonly sessionId: string }): Promise<Response> =>
  SELF.fetch(MCP_URL, {
    method: "GET",
    headers: {
      accept: "text/event-stream",
      authorization: `Bearer ${init.bearer}`,
      "mcp-session-id": init.sessionId,
    },
  });

const seedOrg = async (id: string, name = "MCP Flow Org"): Promise<void> => {
  const response = await SELF.fetch(`${BASE}/__test__/seed-org`, {
    method: "POST",
    headers: { "content-type": CONTENT_TYPE_JSON },
    body: JSON.stringify({ id, name }),
  });
  expect(response.status).toBe(204);
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(() => {
  // Env presence guard — avoids confusing errors downstream if the test
  // wrangler forgot to bind something the DO needs.
  expect(env.MCP_SESSION, "MCP_SESSION binding missing from test wrangler").toBeDefined();
});

afterAll(() => undefined);

// ---------------------------------------------------------------------------
// 1. OPTIONS preflight on /mcp
// ---------------------------------------------------------------------------

describe("/mcp CORS preflight", () => {
  it("returns 204 with the expected CORS headers", async () => {
    const response = await SELF.fetch(MCP_URL, {
      method: "OPTIONS",
      headers: {
        origin: "https://claude.ai",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type, mcp-session-id",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, DELETE, OPTIONS");
    const allowedHeaders = response.headers.get("access-control-allow-headers") ?? "";
    expect(allowedHeaders).toContain("mcp-session-id");
    expect(allowedHeaders).toContain("authorization");
    expect(allowedHeaders).toContain("content-type");
    expect(response.headers.get("access-control-expose-headers")).toBe("mcp-session-id");
  });
});

// ---------------------------------------------------------------------------
// 2. OAuth protected resource metadata
// ---------------------------------------------------------------------------

describe("/.well-known/oauth-protected-resource", () => {
  it("returns the protected resource metadata with CORS", async () => {
    const response = await SELF.fetch(OAUTH_RESOURCE_URL);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");

    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      resource: "https://test-resource.example.com/mcp",
      authorization_servers: ["https://test-authkit.example.com"],
      bearer_methods_supported: ["header"],
      scopes_supported: [],
    });
  });
});

// ---------------------------------------------------------------------------
// 3. POST /mcp without Authorization
// ---------------------------------------------------------------------------

describe("/mcp unauthorized", () => {
  it("returns 401 with www-authenticate and an error body", async () => {
    const response = await mcpPost({ body: INITIALIZE_REQUEST });
    expect(response.status).toBe(401);
    const wwwAuth = response.headers.get("www-authenticate") ?? "";
    expect(wwwAuth).toContain("Bearer resource_metadata=");
    expect(wwwAuth).not.toContain("error=");
    expect(wwwAuth).toContain('resource_metadata="');
    expect(wwwAuth).toContain(
      "https://test-resource.example.com/.well-known/oauth-protected-resource/mcp",
    );
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });
});

// ---------------------------------------------------------------------------
// 4. POST /mcp with a valid bearer but no org in the token
// ---------------------------------------------------------------------------

describe("/mcp verified token without org", () => {
  it("returns JSON-RPC -32001", async () => {
    const response = await mcpPost({
      bearer: makeTestBearer(nextAccountId(), null),
      body: INITIALIZE_REQUEST,
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as {
      jsonrpc: string;
      error: { code: number; message: string };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toMatch(/No organization/i);
  });
});

describe("/mcp transient auth failure", () => {
  it("returns a retryable JSON-RPC error instead of a generic 500", async () => {
    const response = await mcpPost({
      bearer: "test-system-error",
      body: TOOLS_LIST_REQUEST,
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await response.json()) as {
      jsonrpc: string;
      error: { code: number; message: string };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toMatch(/temporarily unavailable/i);
  });
});

describe("/mcp verified token without live org access", () => {
  it("returns JSON-RPC -32001 before creating a session", async () => {
    const response = await mcpPost({
      bearer: makeTestBearer(nextAccountId(), `revoked_${nextOrgId()}`),
      body: INITIALIZE_REQUEST,
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as {
      jsonrpc: string;
      error: { code: number; message: string };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toMatch(/No organization/i);
  });
});

// ---------------------------------------------------------------------------
// 5. POST /mcp on an unknown session-id
// ---------------------------------------------------------------------------
//
// A DO id that was never initialized behaves just like a timed-out
// session — `handleRequest` short-circuits on `!this.initialized`. The
// DO id must be a valid hex id for the namespace or `idFromString`
// throws; generate a fresh unique one (never used) rather than hand-rolling.
// ---------------------------------------------------------------------------

describe("/mcp unknown session id", () => {
  it("returns the session-timeout JSON-RPC error", async () => {
    // No seedOrg needed — the DO never reaches init() (its `initialized`
    // flag is still false), so `resolveOrganization` never runs.
    const bearer = makeTestBearer(nextAccountId(), nextOrgId());

    const staleSessionId = env.MCP_SESSION.newUniqueId().toString();

    const response = await mcpPost({
      bearer,
      sessionId: staleSessionId,
      body: TOOLS_LIST_REQUEST,
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      jsonrpc: string;
      error: { code: number; message: string };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toMatch(/timed out/i);
  });
});

describe("/mcp notification responses", () => {
  it("returns 202 with an empty body for notifications/initialized", async () => {
    const orgId = nextOrgId();
    const accountId = nextAccountId();
    await seedOrg(orgId);

    const initializeResponse = await mcpPost({
      bearer: makeTestBearer(accountId, orgId),
      body: INITIALIZE_REQUEST,
    });
    expect(initializeResponse.status).toBe(200);
    const sessionId = initializeResponse.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const notificationResponse = await mcpPost({
      bearer: makeTestBearer(accountId, orgId),
      sessionId,
      body: INITIALIZED_NOTIFICATION,
    });

    expect(notificationResponse.status).toBe(202);
    expect(notificationResponse.headers.get("content-type")).toBeNull();
    expect(await notificationResponse.text()).toBe("");
  });
});

describe("/mcp session restore", () => {
  it("restores an initialized SDK transport from durable storage", async () => {
    const orgId = nextOrgId();
    const accountId = nextAccountId();
    await seedOrg(orgId);

    const initializeResponse = await mcpPost({
      bearer: makeTestBearer(accountId, orgId),
      body: INITIALIZE_REQUEST,
    });
    expect(initializeResponse.status).toBe(200);
    const sessionId = initializeResponse.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const ns = env.MCP_SESSION;
    const stub = ns.get(ns.idFromString(sessionId!));
    await runInDurableObject(stub, async (instance) => {
      await Effect.runPromise(doRuntimeControls(instance).closeRuntime());
    });

    const response = await mcpPost({
      bearer: makeTestBearer(accountId, orgId),
      sessionId,
      body: TOOLS_LIST_REQUEST,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly jsonrpc: string;
      readonly result?: { readonly tools?: ReadonlyArray<{ readonly name: string }> };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.result?.tools?.some((tool) => tool.name === "execute")).toBe(true);
  }, 15_000);

  it("keeps JSON POST responses after a session is restored by a GET reconnect", async () => {
    const orgId = nextOrgId();
    const accountId = nextAccountId();
    const bearer = makeTestBearer(accountId, orgId);
    await seedOrg(orgId);

    const initializeResponse = await mcpPost({
      bearer,
      body: INITIALIZE_REQUEST,
    });
    expect(initializeResponse.status).toBe(200);
    const sessionId = initializeResponse.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const ns = env.MCP_SESSION;
    const stub = ns.get(ns.idFromString(sessionId!));
    await runInDurableObject(stub, async (instance) => {
      await Effect.runPromise(doRuntimeControls(instance).closeRuntime());
    });

    const getResponse = await mcpGet({ bearer, sessionId: sessionId! });
    expect(getResponse.status).toBe(200);
    expect(getResponse.headers.get("content-type") ?? "").toContain("text/event-stream");
    const responseBody = getResponse.body;
    if (responseBody) {
      await Effect.runPromise(
        Effect.ignore(
          Effect.tryPromise({
            try: () => responseBody.cancel(),
            catch: () => "ResponseBodyCancelFailed" as const,
          }),
        ),
      );
    }

    const postResult = await Promise.race([
      mcpPost({
        bearer,
        sessionId,
        body: TOOLS_LIST_REQUEST,
      }).then((response) => ({ kind: "response" as const, response })),
      new Promise<{ readonly kind: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), 5_000),
      ),
    ]);
    expect(postResult).toEqual(expect.objectContaining({ kind: "response" }));
    if (postResult.kind !== "response") return;

    const response = postResult.response;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    const body = (await response.json()) as {
      readonly jsonrpc: string;
      readonly result?: { readonly tools?: ReadonlyArray<{ readonly name: string }> };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.result?.tools?.some((tool) => tool.name === "execute")).toBe(true);
  }, 15_000);

  it("restores an initialized session after the idle alarm suspends the runtime", async () => {
    const orgId = nextOrgId();
    const accountId = nextAccountId();
    const bearer = makeTestBearer(accountId, orgId);
    await seedOrg(orgId);

    const initializeResponse = await mcpPost({
      bearer,
      body: INITIALIZE_REQUEST,
    });
    expect(initializeResponse.status).toBe(200);
    const sessionId = initializeResponse.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const ns = env.MCP_SESSION;
    const stub = ns.get(ns.idFromString(sessionId!));
    await runInDurableObject(stub, async (instance, state) => {
      doActivityState(instance).lastActivityMs = 0;
      await state.storage.put(LAST_ACTIVITY_KEY, Date.now() - SESSION_TIMEOUT_MS - 1_000);
      await state.storage.setAlarm(Date.now() - 1);
    });

    await runDurableObjectAlarm(stub);

    const response = await mcpPost({
      bearer,
      sessionId,
      body: TOOLS_LIST_REQUEST,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly jsonrpc: string;
      readonly result?: { readonly tools?: ReadonlyArray<{ readonly name: string }> };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.result?.tools?.some((tool) => tool.name === "execute")).toBe(true);
  }, 15_000);

  it("reproduces cross-account session reuse via leaked mcp-session-id", async () => {
    const victimOrgId = nextOrgId();
    const attackerOrgId = nextOrgId();
    const victimAccountId = nextAccountId();
    const attackerAccountId = nextAccountId();
    await seedOrg(victimOrgId);

    const initializeResponse = await mcpPost({
      bearer: makeTestBearer(victimAccountId, victimOrgId),
      body: INITIALIZE_REQUEST,
    });
    expect(initializeResponse.status).toBe(200);
    const sessionId = initializeResponse.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const ns = env.MCP_SESSION;
    const stub = ns.get(ns.idFromString(sessionId!));
    await runInDurableObject(stub, async (instance) => {
      await Effect.runPromise(doRuntimeControls(instance).closeRuntime());
    });

    const response = await mcpPost({
      bearer: makeTestBearer(attackerAccountId, attackerOrgId),
      sessionId,
      body: TOOLS_LIST_REQUEST,
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as {
      readonly jsonrpc: string;
      readonly error?: { readonly code: number; readonly message: string };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error?.code).toBe(-32003);
    expect(body.error?.message).toMatch(/does not belong/i);
  }, 15_000);

  it("clears an existing session when live org access is revoked", async () => {
    const orgId = `revoked_${nextOrgId()}`;
    const accountId = nextAccountId();
    const stub = env.MCP_SESSION.get(env.MCP_SESSION.newUniqueId());
    const sessionId = stub.id.toString();

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(SESSION_META_KEY, {
        organizationId: orgId,
        organizationName: "Revoked Org",
        userId: accountId,
      });
      await state.storage.put(LAST_ACTIVITY_KEY, Date.now());
      await state.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    });

    const revokedResponse = await mcpPost({
      bearer: makeTestBearer(accountId, orgId),
      sessionId,
      body: TOOLS_LIST_REQUEST,
    });
    expect(revokedResponse.status).toBe(403);
    const body = (await revokedResponse.json()) as {
      readonly jsonrpc: string;
      readonly error?: { readonly code: number; readonly message: string };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error?.code).toBe(-32001);
    expect(body.error?.message).toMatch(/No organization/i);

    const stored = await runInDurableObject(stub, async (_instance, state) => ({
      sessionMeta: await state.storage.get(SESSION_META_KEY),
      lastActivity: await state.storage.get(LAST_ACTIVITY_KEY),
      alarm: await state.storage.getAlarm(),
    }));
    expect(stored.sessionMeta).toBeUndefined();
    expect(stored.lastActivity).toBeUndefined();
    expect(stored.alarm).toBeNull();
  }, 15_000);
});

describe("McpSessionDO alarm lifecycle", () => {
  it("rejects browser approval reads and resumes from a different signed-in user", async () => {
    const stub = env.MCP_SESSION.get(env.MCP_SESSION.newUniqueId());
    const sessionMeta = {
      organizationId: "org_browser_resume_owner",
      organizationName: "Browser Resume Owner",
      userId: "user_browser_resume_owner",
    };

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(SESSION_META_KEY, sessionMeta);
      await state.storage.put(LAST_ACTIVITY_KEY, Date.now());
    });

    const attackerIdentity = {
      accountId: "user_browser_resume_attacker",
      organizationId: sessionMeta.organizationId,
    };

    await expect(
      stub.getPausedExecutionForApproval("exec_approval", attackerIdentity),
    ).resolves.toEqual({
      status: "forbidden",
    });

    await expect(
      stub.resumeExecutionForApproval("exec_approval", attackerIdentity, { action: "accept" }),
    ).resolves.toEqual({
      status: "forbidden",
    });
  });

  it("keeps a recently active session after a cold-started alarm", async () => {
    const stub = env.MCP_SESSION.get(env.MCP_SESSION.newUniqueId());
    const sessionMeta = {
      organizationId: "org_alarm_recent",
      organizationName: "Alarm Recent",
      userId: "user_alarm_recent",
    };

    await runInDurableObject(stub, async (_instance, state) => {
      const now = Date.now();
      await state.storage.put(SESSION_META_KEY, sessionMeta);
      await state.storage.put(LAST_ACTIVITY_KEY, now);
      await state.storage.setAlarm(now - 1);
    });
    await runInDurableObject(stub, (instance) => {
      doActivityState(instance).lastActivityMs = 0;
    });

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    const stored = await runInDurableObject(stub, async (_instance, state) => ({
      sessionMeta: await state.storage.get(SESSION_META_KEY),
      lastActivity: await state.storage.get<number>(LAST_ACTIVITY_KEY),
      alarm: await state.storage.getAlarm(),
    }));

    expect(stored.sessionMeta).toEqual(sessionMeta);
    expect(stored.lastActivity).toBeGreaterThan(Date.now() - SESSION_TIMEOUT_MS);
    expect(stored.alarm).toBeGreaterThan(Date.now());
    expect(stored.alarm).toBeLessThanOrEqual(Date.now() + HEARTBEAT_MS + 1_000);
  });

  it("suspends an expired session after a cold-started alarm", async () => {
    const stub = env.MCP_SESSION.get(env.MCP_SESSION.newUniqueId());
    const sessionMeta = {
      organizationId: "org_alarm_expired",
      organizationName: "Alarm Expired",
      userId: "user_alarm_expired",
    };
    const lastActivity = Date.now() - SESSION_TIMEOUT_MS - 1_000;

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(SESSION_META_KEY, sessionMeta);
      await state.storage.put(LAST_ACTIVITY_KEY, lastActivity);
      await state.storage.setAlarm(Date.now() - 1);
    });
    await runInDurableObject(stub, (instance) => {
      doActivityState(instance).lastActivityMs = 0;
    });

    await runDurableObjectAlarm(stub);

    const stored = await runInDurableObject(stub, async (_instance, state) => ({
      sessionMeta: await state.storage.get(SESSION_META_KEY),
      lastActivity: await state.storage.get(LAST_ACTIVITY_KEY),
      alarm: await state.storage.getAlarm(),
    }));

    expect(stored.sessionMeta).toEqual(sessionMeta);
    expect(stored.lastActivity).toBe(lastActivity);
    expect(stored.alarm).toBeNull();
  });
});
