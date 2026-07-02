// Cloud: the raw /mcp wire protocol — CORS preflight, OAuth discovery
// metadata, bearer-auth failures, org-scoped routing, and session lifecycle
// errors — asserted with hand-rolled JSON-RPC over fetch, exactly the bytes an
// MCP transport sends. Every hop is the production topology: real workerd,
// real McpSessionDO, and real bearers minted from the authorization server the
// product itself advertises (discovery → DCR → authorize → token).
//
// Ported from apps/cloud/src/mcp-flow.test.ts (workerd-pool SELF.fetch with
// test-seam bearers). DO-internal coverage from that file (forced runtime
// eviction, idle-alarm firing, alarm scheduling, storage seeding) is clock /
// internals dependent and intentionally NOT carried — only black-box
// guarantees live here.
import { randomBytes, randomUUID } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Mcp, Target } from "../src/services";
import type { Identity } from "../src/target";

const JSON_AND_SSE = "application/json, text/event-stream";
const PROTOCOL_VERSION = "2025-03-26";
const INITIALIZE_REQUEST = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "executor-e2e-mcp-protocol", version: "0.0.1" },
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

type JsonRpcError = {
  readonly jsonrpc: string;
  readonly error: { readonly code: number; readonly message: string };
};

const emailOf = (identity: Identity): string => identity.credentials?.email ?? identity.label;

/** The org the bearer is scoped to, read from the JWT's public claims. */
const orgIdOf = (bearer: string): string => {
  const claims = JSON.parse(Buffer.from(bearer.split(".")[1] ?? "", "base64url").toString()) as {
    readonly org_id?: string;
  };
  if (!claims.org_id) throw new Error("orgIdOf: bearer carries no org_id claim");
  return claims.org_id;
};

const mcpPost = (
  url: string | URL,
  init: { readonly bearer?: string; readonly sessionId?: string; readonly body: unknown },
): Promise<Response> =>
  fetch(url, {
    method: "POST",
    headers: {
      accept: JSON_AND_SSE,
      "content-type": "application/json",
      ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
      ...(init.sessionId ? { "mcp-session-id": init.sessionId } : {}),
    },
    body: JSON.stringify(init.body),
  });

/** initialize → session id (asserted present) → notifications/initialized. */
const openSession = async (mcpUrl: string, bearer: string): Promise<string> => {
  const initialize = await mcpPost(mcpUrl, { bearer, body: INITIALIZE_REQUEST });
  const sessionId = initialize.headers.get("mcp-session-id");
  await initialize.text();
  if (initialize.status !== 200 || !sessionId) {
    throw new Error(`openSession: initialize failed (${initialize.status})`);
  }
  const initialized = await mcpPost(mcpUrl, {
    bearer,
    sessionId,
    body: INITIALIZED_NOTIFICATION,
  });
  await initialized.text();
  if (initialized.status !== 202) {
    throw new Error(`openSession: notifications/initialized failed (${initialized.status})`);
  }
  return sessionId;
};

scenario(
  "MCP protocol · /mcp answers a CORS preflight allowing the headers an MCP client sends",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const response = yield* Effect.promise(() =>
      fetch(new URL("/mcp", target.baseUrl), {
        method: "OPTIONS",
        headers: {
          origin: "https://claude.ai",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization, content-type, mcp-session-id",
        },
      }),
    );
    expect(response.status, "the preflight succeeds").toBe(204);
    const allowedMethods = (response.headers.get("access-control-allow-methods") ?? "")
      .split(",")
      .map((method) => method.trim());
    expect(allowedMethods, "POST (requests) is allowed").toContain("POST");
    expect(allowedMethods, "GET (standalone SSE) is allowed").toContain("GET");
    expect(allowedMethods, "DELETE (session termination) is allowed").toContain("DELETE");
    const allowedHeaders = response.headers.get("access-control-allow-headers") ?? "";
    expect(allowedHeaders, "the bearer header is allowed").toContain("authorization");
    expect(allowedHeaders, "the JSON body header is allowed").toContain("content-type");
    expect(allowedHeaders, "the session header is allowed").toContain("mcp-session-id");
  }),
);

scenario(
  "MCP protocol · protected-resource metadata advertises a discoverable authorization server",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const response = yield* Effect.promise(() =>
      fetch(new URL("/.well-known/oauth-protected-resource/mcp", target.baseUrl), {
        headers: { origin: "https://claude.ai" },
      }),
    );
    expect(response.status, "the discovery document is public").toBe(200);
    expect(
      response.headers.get("access-control-allow-origin"),
      "discovery is readable cross-origin",
    ).toBe("*");

    const body = (yield* Effect.promise(() => response.json())) as {
      readonly resource: string;
      readonly authorization_servers: ReadonlyArray<string>;
      readonly bearer_methods_supported: ReadonlyArray<string>;
      readonly scopes_supported: ReadonlyArray<string>;
    };
    expect(body, "the metadata names the MCP resource and its auth server").toEqual({
      resource: new URL("/mcp", target.baseUrl).toString(),
      authorization_servers: [expect.any(String)],
      bearer_methods_supported: ["header"],
      // offline_access MUST stay advertised: spec-faithful clients request
      // exactly this list, and it is what earns them a refresh token (the
      // OpenCode daily re-auth bug).
      scopes_supported: ["openid", "profile", "email", "offline_access"],
    });

    // The advertised server must itself be discoverable — that is what lets
    // an MCP client complete OAuth from nothing but the resource URL.
    const issuer = body.authorization_servers[0] ?? "";
    const authServer = (yield* Effect.promise(async () =>
      (await fetch(new URL("/.well-known/oauth-authorization-server", issuer))).json(),
    )) as Record<string, unknown>;
    expect(
      authServer["authorization_endpoint"],
      "the auth server publishes its authorize endpoint",
    ).toEqual(expect.any(String));
    expect(authServer["token_endpoint"], "the auth server publishes its token endpoint").toEqual(
      expect.any(String),
    );
    expect(authServer["registration_endpoint"], "dynamic client registration is available").toEqual(
      expect.any(String),
    );
  }),
);

scenario(
  "MCP protocol · org-scoped discovery metadata points at the org-scoped resource",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const orgId = `org_e2e_${randomBytes(4).toString("hex")}`;
    const [bare, scoped] = yield* Effect.promise(() =>
      Promise.all([
        fetch(new URL("/.well-known/oauth-protected-resource/mcp", target.baseUrl)).then(
          (r) => r.json() as Promise<{ authorization_servers: ReadonlyArray<string> }>,
        ),
        fetch(new URL(`/.well-known/oauth-protected-resource/${orgId}/mcp`, target.baseUrl)),
      ]),
    );
    expect(scoped.status, "the org-scoped discovery path is served").toBe(200);
    const body = (yield* Effect.promise(() => scoped.json())) as Record<string, unknown>;
    expect(body["resource"], "the resource is the org-scoped MCP URL").toBe(
      new URL(`/${orgId}/mcp`, target.baseUrl).toString(),
    );
    expect(
      body["authorization_servers"],
      "the org-scoped variant points at the same auth server",
    ).toEqual(bare.authorization_servers);
  }),
);

scenario(
  "MCP protocol · a request without a bearer is challenged with the resource metadata",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const response = yield* Effect.promise(() =>
      mcpPost(target.mcpUrl, { body: INITIALIZE_REQUEST }),
    );
    expect(response.status, "anonymous requests are rejected").toBe(401);
    const wwwAuth = response.headers.get("www-authenticate") ?? "";
    expect(wwwAuth, "the challenge is a Bearer challenge").toContain('Bearer resource_metadata="');
    expect(wwwAuth, "the challenge points at the discovery document").toContain(
      new URL("/.well-known/oauth-protected-resource/mcp", target.baseUrl).toString(),
    );
    expect(wwwAuth, "a missing token carries no error code (per RFC 6750)").not.toContain("error=");
    expect(
      response.headers.get("access-control-expose-headers") ?? "",
      "browsers can read the challenge",
    ).toContain("WWW-Authenticate");
    expect(yield* Effect.promise(() => response.json()), "the body is a JSON-RPC error").toEqual({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
  }),
);

scenario(
  "MCP protocol · a garbage bearer is rejected as an invalid token",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const response = yield* Effect.promise(() =>
      mcpPost(target.mcpUrl, { bearer: "bogus.bogus.bogus", body: INITIALIZE_REQUEST }),
    );
    expect(response.status, "an unverifiable token is rejected").toBe(401);
    const wwwAuth = response.headers.get("www-authenticate") ?? "";
    expect(wwwAuth, "the challenge names the invalid_token error").toContain(
      'error="invalid_token"',
    );
    expect(wwwAuth, "the challenge still points at the discovery document").toContain(
      new URL("/.well-known/oauth-protected-resource/mcp", target.baseUrl).toString(),
    );
    expect(yield* Effect.promise(() => response.json()), "the body is a JSON-RPC error").toEqual({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
  }),
);

scenario(
  "MCP protocol · a valid bearer whose user has no organization cannot open a session",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    // A brand-new user straight through OAuth — never visited the web app,
    // never created or joined an org.
    const bearer = yield* mcp.mintBearer(`no-org-${randomUUID().slice(0, 8)}@e2e.test`);
    const response = yield* Effect.promise(() =>
      mcpPost(target.mcpUrl, { bearer, body: INITIALIZE_REQUEST }),
    );
    expect(response.status, "the org gate fires before any session is created").toBe(403);
    const body = (yield* Effect.promise(() => response.json())) as JsonRpcError;
    expect(body.error.code, "the error is the MCP auth error code").toBe(-32001);
    expect(body.error.message, "the error tells the user what is missing").toMatch(
      /no organization/i,
    );
  }),
);

scenario(
  "MCP protocol · the URL can pin the active org, but membership is enforced",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));
    const ownOrg = orgIdOf(bearer);

    const member = yield* Effect.promise(() =>
      mcpPost(new URL(`/${ownOrg}/mcp`, target.baseUrl), {
        bearer,
        body: INITIALIZE_REQUEST,
      }),
    );
    expect(member.status, "the member's own org-scoped URL opens a session").toBe(200);
    expect(
      member.headers.get("mcp-session-id"),
      "the org-scoped session is a real session",
    ).toBeTruthy();
    yield* Effect.promise(() => member.text());

    // The slug form — what the install card prints (`/acme/mcp`) — selects
    // the same org. The slug comes from the account surface.
    const me = yield* Effect.promise(() =>
      fetch(new URL("/api/account/me", target.baseUrl), { headers: identity.headers }).then(
        (r) => r.json() as Promise<{ organization: { slug: string } | null }>,
      ),
    );
    const ownSlug = me.organization?.slug;
    expect(ownSlug, "the account surface advertises the org's URL slug").toBeTruthy();
    const slugged = yield* Effect.promise(() =>
      mcpPost(new URL(`/${ownSlug}/mcp`, target.baseUrl), {
        bearer,
        body: INITIALIZE_REQUEST,
      }),
    );
    expect(slugged.status, "the member's slug-pinned URL opens a session").toBe(200);
    expect(
      slugged.headers.get("mcp-session-id"),
      "the slug-pinned session is a real session",
    ).toBeTruthy();
    yield* Effect.promise(() => slugged.text());

    // An unknown slug selects nothing — same rejection as a foreign org id.
    const unknownSlug = yield* Effect.promise(() =>
      mcpPost(new URL(`/zz-no-such-org-${randomBytes(3).toString("hex")}/mcp`, target.baseUrl), {
        bearer,
        body: INITIALIZE_REQUEST,
      }),
    );
    expect(unknownSlug.status, "an unknown slug authorizes nothing").toBe(403);

    const foreignOrg = `org_e2e_${randomBytes(4).toString("hex")}`;
    const foreign = yield* Effect.promise(() =>
      mcpPost(new URL(`/${foreignOrg}/mcp`, target.baseUrl), {
        bearer,
        body: INITIALIZE_REQUEST,
      }),
    );
    expect(foreign.status, "an org the user is no member of is rejected").toBe(403);
    const body = (yield* Effect.promise(() => foreign.json())) as JsonRpcError;
    expect(body.error.code, "the rejection is the MCP auth error code").toBe(-32001);
    expect(body.error.message, "the URL is a selector, not a trust boundary").toMatch(
      /no organization/i,
    );
  }),
);

scenario(
  "MCP protocol · a non-org path segment is not claimed by the MCP route",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));
    // `/settings/mcp` must fall through to app routing rather than being
    // swallowed by the MCP filter — only `org_…`-shaped segments are claimed.
    const response = yield* Effect.promise(() =>
      mcpPost(new URL("/settings/mcp", target.baseUrl), {
        bearer,
        body: INITIALIZE_REQUEST,
      }),
    );
    expect(
      response.headers.get("mcp-session-id"),
      "no MCP session is opened on an app route",
    ).toBeNull();
    const body = (yield* Effect.promise(() => response.text())) as string;
    expect(body, "the response is not a JSON-RPC envelope").not.toContain('"jsonrpc"');
  }),
);

scenario(
  "MCP protocol · verbs outside the MCP transport are rejected with a JSON-RPC 405",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));
    const statuses: Array<{ method: string; status: number; body: JsonRpcError }> = [];
    for (const method of ["PUT", "PATCH"]) {
      const response = yield* Effect.promise(() =>
        fetch(target.mcpUrl, {
          method,
          headers: {
            accept: JSON_AND_SSE,
            "content-type": "application/json",
            authorization: `Bearer ${bearer}`,
          },
          body: JSON.stringify(TOOLS_LIST_REQUEST),
        }),
      );
      statuses.push({
        method,
        status: response.status,
        body: (yield* Effect.promise(() => response.json())) as JsonRpcError,
      });
    }
    expect(
      statuses.map(({ method, status }) => `${method}:${status}`),
      "PUT and PATCH never reach the session engine",
    ).toEqual(["PUT:405", "PATCH:405"]);
    for (const { body } of statuses) {
      expect(body.error.code, "the rejection is a JSON-RPC error").toBe(-32001);
      expect(body.error.message, "the rejection names the problem").toMatch(/method not allowed/i);
    }
  }),
);

scenario(
  "MCP protocol · initialize opens a session and notifications are accepted with 202",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));

    const initialize = yield* Effect.promise(() =>
      mcpPost(target.mcpUrl, { bearer, body: INITIALIZE_REQUEST }),
    );
    expect(initialize.status, "initialize succeeds").toBe(200);
    const sessionId = initialize.headers.get("mcp-session-id");
    expect(sessionId, "the server assigns a session id").toBeTruthy();
    expect(
      initialize.headers.get("access-control-expose-headers") ?? "",
      "browser clients can read the session id",
    ).toContain("mcp-session-id");
    yield* Effect.promise(() => initialize.text());

    const notification = yield* Effect.promise(() =>
      mcpPost(target.mcpUrl, {
        bearer,
        sessionId: sessionId ?? "",
        body: INITIALIZED_NOTIFICATION,
      }),
    );
    expect(notification.status, "notifications are accepted, not answered").toBe(202);
    expect(yield* Effect.promise(() => notification.text()), "the body is empty").toBe("");
  }),
);

scenario(
  "MCP protocol · a terminated session's id is rejected with a reconnect error",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));
    const sessionId = yield* Effect.promise(() => openSession(target.mcpUrl, bearer));

    const terminate = yield* Effect.promise(() =>
      fetch(target.mcpUrl, {
        method: "DELETE",
        headers: { authorization: `Bearer ${bearer}`, "mcp-session-id": sessionId },
      }),
    );
    expect(terminate.status, "the client can terminate its session").toBe(200);
    yield* Effect.promise(() => terminate.text());

    const reuse = yield* Effect.promise(() =>
      mcpPost(target.mcpUrl, { bearer, sessionId, body: TOOLS_LIST_REQUEST }),
    );
    expect(reuse.status, "the dead session id no longer works").toBe(404);
    const body = (yield* Effect.promise(() => reuse.json())) as JsonRpcError;
    expect(body.error.code, "the rejection is a JSON-RPC error").toBe(-32001);
    expect(body.error.message, "the client is told to reconnect").toMatch(/timed out|reconnect/i);
  }),
);

scenario(
  "MCP protocol · a session cannot be ridden by a different account's bearer",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const victim = yield* target.newIdentity();
    const attacker = yield* target.newIdentity();
    const victimBearer = yield* mcp.mintBearer(emailOf(victim));
    const attackerBearer = yield* mcp.mintBearer(emailOf(attacker));
    const sessionId = yield* Effect.promise(() => openSession(target.mcpUrl, victimBearer));

    // The attacker authenticates fine — but with a leaked session id of a
    // session that is not theirs.
    const hijack = yield* Effect.promise(() =>
      mcpPost(target.mcpUrl, {
        bearer: attackerBearer,
        sessionId,
        body: TOOLS_LIST_REQUEST,
      }),
    );
    expect(hijack.status, "the leaked session id is useless to another account").toBe(403);
    const body = (yield* Effect.promise(() => hijack.json())) as JsonRpcError;
    expect(body.error.code, "the rejection is the session-ownership error").toBe(-32003);
    expect(body.error.message, "the error names the ownership violation").toMatch(
      /does not belong/i,
    );

    // The owner is unaffected.
    const owner = yield* Effect.promise(() =>
      mcpPost(target.mcpUrl, { bearer: victimBearer, sessionId, body: TOOLS_LIST_REQUEST }),
    );
    expect(owner.status, "the rightful owner keeps using the session").toBe(200);
    yield* Effect.promise(() => owner.text());
  }),
);

scenario(
  "MCP protocol · a dropped standalone SSE stream can be reopened",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));
    const sessionId = yield* Effect.promise(() => openSession(target.mcpUrl, bearer));

    const openSse = () =>
      fetch(target.mcpUrl, {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${bearer}`,
          "mcp-protocol-version": PROTOCOL_VERSION,
          "mcp-session-id": sessionId,
        },
      });

    const first = yield* Effect.promise(openSse);
    expect(first.status, "the standalone SSE stream opens").toBe(200);
    expect(first.headers.get("content-type") ?? "", "the stream speaks SSE").toContain(
      "text/event-stream",
    );

    // A client that lost its stream (network blip, laptop sleep) reconnects
    // with the same session id — the server accepts the replacement.
    const second = yield* Effect.promise(openSse);
    expect(second.status, "a reconnect on the same session succeeds").toBe(200);
    expect(second.headers.get("content-type") ?? "", "the reconnect speaks SSE").toContain(
      "text/event-stream",
    );

    yield* Effect.promise(() => first.body?.cancel().catch(() => undefined) ?? Promise.resolve());
    yield* Effect.promise(() => second.body?.cancel().catch(() => undefined) ?? Promise.resolve());
  }),
);

scenario(
  "MCP protocol · overlapping tools/call requests with colliding JSON-RPC ids both complete",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));
    const sessionId = yield* Effect.promise(() => openSession(target.mcpUrl, bearer));

    // Both calls use id 1 — a sloppy-but-legal client. Each POST must get
    // its own response back; neither may be dropped or cross-wired.
    const callExecute = (code: string) =>
      mcpPost(target.mcpUrl, {
        bearer,
        sessionId,
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "execute", arguments: { code } },
        },
      });

    const responses = yield* Effect.promise(() =>
      Promise.all([
        callExecute('await new Promise((resolve) => setTimeout(resolve, 500));\nreturn "first";'),
        callExecute('return "second";'),
      ]),
    );
    expect(
      responses.map((response) => response.status),
      "both overlapping calls return",
    ).toEqual([200, 200]);

    const bodies = (yield* Effect.promise(() =>
      Promise.all(responses.map((response) => response.json())),
    )) as Array<{
      readonly result?: { readonly content?: ReadonlyArray<{ readonly text?: string }> };
      readonly error?: unknown;
    }>;
    const texts = bodies.map(
      (body) => body.result?.content?.map((item) => item.text).join("\n") ?? "",
    );
    expect(texts.join(" | "), "the slow call's result arrives").toContain("first");
    expect(texts.join(" | "), "the fast call's result arrives").toContain("second");
    expect(
      bodies.map((body) => body.error),
      "neither call errors",
    ).toEqual([undefined, undefined]);
  }),
);
