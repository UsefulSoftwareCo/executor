import { beforeEach, describe, expect, it, vi } from "@effect/vitest";
import { Effect, Layer } from "effect";

import {
  authenticated,
  McpAuthProvider,
  unauthorized,
  type Principal,
} from "@executor-js/host-mcp";

import type { CloudflareConfig, CloudflareEnv } from "../config";
import { cloudflareDeadSessionCacheForTest, makeCloudflareMcpAgentHandler } from "./agent-handler";

const principal: Principal = {
  accountId: "acct_test",
  organizationId: "org_test",
  organizationName: "Test Org",
  email: "test@example.com",
  name: "Test",
  avatarUrl: null,
  roles: ["member"],
};

const config = {
  accessTeamDomain: "test.cloudflareaccess.com",
  accessAud: "aud_test",
  accessNameClaim: "name",
  accessGroupsClaim: "groups",
  adminEmails: [],
  organizationId: "org_test",
  organizationName: "Test Org",
  organizationSlug: "test-org",
  secretKey: "test-secret-key-0123456789",
  allowLocalNetwork: false,
  enableDevAuth: false,
} satisfies CloudflareConfig;

const AuthProviderLive = Layer.succeed(McpAuthProvider)({
  discoveryRoutes: [],
  resourceMetadataUrl: (request) => new URL("/.well-known/mcp", request.url).toString(),
  authenticate: (request) =>
    Effect.succeed(
      request.headers.has("authorization") ? authenticated(principal) : unauthorized(),
    ),
});

const requestFor = (method: "GET" | "POST", sessionId: string, authenticated = true): Request =>
  new Request("https://executor.test/mcp", {
    method,
    headers: {
      ...(authenticated ? { authorization: "Bearer test" } : {}),
      "mcp-session-id": sessionId,
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
    },
    ...(method === "POST"
      ? {
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        }
      : {}),
  });

const makeHarness = (owner: "not_found" | "terminated" = "not_found") => {
  const ownerChecks = { count: 0 };
  const stub = {
    validateMcpSessionOwner: async () => {
      ownerChecks.count += 1;
      return owner;
    },
  };
  const namespace = {
    idFromString: (sessionId: string) => sessionId,
    get: () => stub,
  };
  // oxlint-disable-next-line executor/no-double-cast -- test boundary: the handler only reads the MCP_SESSION namespace in these legacy dead-session cases
  const env = { MCP_SESSION: namespace } as unknown as CloudflareEnv;
  // oxlint-disable-next-line executor/no-double-cast -- test boundary: no ExecutionContext capability is used before the dead-session response
  const ctx = {} as unknown as ExecutionContext;
  const handler = makeCloudflareMcpAgentHandler(config, {
    authProvider: AuthProviderLive,
    makeModernServerBuilder: () => ({ build: () => Effect.die("unused modern builder") }),
  });
  return { ctx, env, handler, ownerChecks };
};

describe("standalone Cloudflare MCP dead-session negative cache", () => {
  beforeEach(() => {
    vi.useRealTimers();
    cloudflareDeadSessionCacheForTest.clear();
  });

  it.each([
    { method: "GET" as const, status: 405 },
    { method: "POST" as const, status: 404 },
  ])("serves a repeated $method without another DO lookup", async ({ method, status }) => {
    const { ctx, env, handler, ownerChecks } = makeHarness();
    const sessionId = `dead-${method.toLowerCase()}`;

    const first = await handler(requestFor(method, sessionId), env, ctx);
    const second = await handler(requestFor(method, sessionId), env, ctx);

    expect(first.status).toBe(status);
    expect(second.status).toBe(status);
    expect(ownerChecks.count).toBe(1);
  });

  it("keeps authentication ahead of cached session existence", async () => {
    const { ctx, env, handler, ownerChecks } = makeHarness();
    const sessionId = "dead-auth";

    expect((await handler(requestFor("GET", sessionId), env, ctx)).status).toBe(405);
    const unauthenticated = await handler(requestFor("GET", sessionId, false), env, ctx);

    expect(unauthenticated.status).toBe(401);
    expect(ownerChecks.count).toBe(1);
  });

  it("preserves the terminated-session response on a cached hit", async () => {
    const { ctx, env, handler, ownerChecks } = makeHarness("terminated");
    const sessionId = "dead-terminated";

    const first = await handler(requestFor("POST", sessionId), env, ctx);
    const second = await handler(requestFor("POST", sessionId), env, ctx);

    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect(await second.text()).toBe(await first.text());
    expect(ownerChecks.count).toBe(1);
  });

  it("consults the DO again after five minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { ctx, env, handler, ownerChecks } = makeHarness();
    const sessionId = "dead-expiry";

    expect((await handler(requestFor("GET", sessionId), env, ctx)).status).toBe(405);
    vi.advanceTimersByTime(5 * 60 * 1_000 + 1);
    expect((await handler(requestFor("GET", sessionId), env, ctx)).status).toBe(405);

    expect(ownerChecks.count).toBe(2);
  });

  it("evicts the oldest entry without exceeding 4,096 sessions", () => {
    for (let index = 0; index <= 4_096; index += 1) {
      cloudflareDeadSessionCacheForTest.remember(`dead-${index}`, 0);
    }

    expect(cloudflareDeadSessionCacheForTest.size()).toBe(4_096);
    expect(cloudflareDeadSessionCacheForTest.has("dead-0", 1)).toBe(false);
    expect(cloudflareDeadSessionCacheForTest.has("dead-1", 1)).toBe(true);
    expect(cloudflareDeadSessionCacheForTest.has("dead-4096", 1)).toBe(true);
  });
});
