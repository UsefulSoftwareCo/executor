// ---------------------------------------------------------------------------
// Cloud API × MCP OAuth — real HTTP end-to-end
// ---------------------------------------------------------------------------
//
// Drives the ProtectedCloudApi through the node-pool harness against a
// real in-process OAuth + MCP server (Node `http.createServer` bound to
// a random port). Every layer between the test and the plugin is real:
//
//   test → HttpApiClient → in-process webHandler → ProtectedCloudApi
//        → Core OAuthHandlers → executor.oauth.start / complete
//        → MCP SDK `auth()`
//        → fake OAuth server (DCR, /authorize → 302, /token, AS metadata,
//          protected resource metadata)
//
// Two scenarios:
//
//   1. Single user: startOAuth → follow redirect → completeOAuth. Asserts
//      the response carries the Connection id the exchange minted.
//
//   2. Two users, same source: both users complete the shared OAuth flow
//      and end up with their own Connection (same id, different scope)
//      via the SDK's innermost-wins shadowing.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";

import { Effect, Option, Result, Schema } from "effect";
import { ScopeId } from "@executor-js/sdk";

import { asOrg, asUser, testUserOrgScopeId } from "./__test-harness__/api-harness";

// ---------------------------------------------------------------------------
// Fake OAuth + MCP server
// ---------------------------------------------------------------------------

interface FakeServer {
  readonly url: string;
  readonly registrations: () => number;
  readonly tokens: () => number;
  readonly close: () => Promise<void>;
}

const RegistrationBody = Schema.Struct({
  redirect_uris: Schema.optional(Schema.Array(Schema.String)),
  grant_types: Schema.optional(Schema.Array(Schema.String)),
  response_types: Schema.optional(Schema.Array(Schema.String)),
});
const decodeRegistrationBody = Schema.decodeUnknownOption(Schema.fromJsonString(RegistrationBody));

const startFakeServer = async (): Promise<FakeServer> => {
  const clients = new Map<string, { redirect_uris: readonly string[] }>();
  const codes = new Map<string, { readonly clientId: string; readonly codeChallenge: string }>();
  const accessTokens = new Map<string, { readonly refresh: string }>();
  const refreshTokens = new Map<string, string>();
  let seq = 0;
  const next = (p: string) => `${p}_${++seq}_${randomBytes(6).toString("hex")}`;
  let registrations = 0;
  let tokenCalls = 0;

  const readBody = (req: import("node:http").IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let buf = "";
      req.on("data", (chunk) => (buf += chunk));
      req.on("end", () => resolve(buf));
      req.on("error", reject);
    });

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      res.writeHead(status, {
        "content-type": typeof body === "string" ? "text/plain" : "application/json",
        ...headers,
      });
      res.end(payload);
    };

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: fake HTTP server returns stable 500 responses for unexpected handler failures
    try {
      if (url.pathname === "/.well-known/oauth-protected-resource") {
        const origin = `http://${req.headers.host}`;
        return send(200, {
          resource: origin,
          authorization_servers: [origin],
          bearer_methods_supported: ["header"],
        });
      }

      if (url.pathname === "/.well-known/oauth-authorization-server") {
        const issuer = `http://${req.headers.host}`;
        return send(200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          registration_endpoint: `${issuer}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }

      if (url.pathname === "/register" && req.method === "POST") {
        const body = await readBody(req);
        const parsedOption = decodeRegistrationBody(body);
        if (Option.isNone(parsedOption)) {
          return send(400, { error: "invalid_registration" });
        }
        const parsed = parsedOption.value;
        const clientId = next("client");
        clients.set(clientId, { redirect_uris: parsed.redirect_uris ?? [] });
        registrations += 1;
        return send(201, {
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          redirect_uris: parsed.redirect_uris ?? [],
          grant_types: parsed.grant_types ?? ["authorization_code", "refresh_token"],
          response_types: parsed.response_types ?? ["code"],
          token_endpoint_auth_method: "none",
        });
      }

      if (url.pathname === "/authorize" && req.method === "GET") {
        const clientId = url.searchParams.get("client_id") ?? "";
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const state = url.searchParams.get("state") ?? "";
        const codeChallenge = url.searchParams.get("code_challenge") ?? "";
        const method = url.searchParams.get("code_challenge_method") ?? "";
        if (!clients.has(clientId)) {
          return send(400, { error: "unknown_client" });
        }
        if (method !== "S256" || !codeChallenge) {
          return send(400, { error: "invalid_request" });
        }
        const code = next("code");
        codes.set(code, { clientId, codeChallenge });
        const destination = new URL(redirectUri);
        destination.searchParams.set("code", code);
        if (state) destination.searchParams.set("state", state);
        return send(302, "", { location: destination.toString() });
      }

      if (url.pathname === "/token" && req.method === "POST") {
        tokenCalls += 1;
        const body = await readBody(req);
        const params = new URLSearchParams(body);
        const grant = params.get("grant_type");

        if (grant === "authorization_code") {
          const code = params.get("code") ?? "";
          const verifier = params.get("code_verifier") ?? "";
          const record = codes.get(code);
          if (!record) return send(400, { error: "invalid_grant" });
          codes.delete(code);
          const computed = createHash("sha256").update(verifier).digest("base64url");
          if (computed !== record.codeChallenge) {
            return send(400, { error: "invalid_grant" });
          }
          const access = next("at");
          const refresh = next("rt");
          accessTokens.set(access, { refresh });
          refreshTokens.set(refresh, access);
          return send(200, {
            access_token: access,
            refresh_token: refresh,
            token_type: "Bearer",
            expires_in: 3600,
          });
        }

        if (grant === "refresh_token") {
          const rt = params.get("refresh_token") ?? "";
          const prev = refreshTokens.get(rt);
          if (!prev) return send(400, { error: "invalid_grant" });
          refreshTokens.delete(rt);
          accessTokens.delete(prev);
          const access = next("at");
          const refresh = next("rt");
          accessTokens.set(access, { refresh });
          refreshTokens.set(refresh, access);
          return send(200, {
            access_token: access,
            refresh_token: refresh,
            token_type: "Bearer",
            expires_in: 3600,
          });
        }

        return send(400, { error: "unsupported_grant_type" });
      }

      // Default: 401 with WWW-Authenticate so any MCP probe on /mcp
      // gets the resource-metadata pointer the auth() discovery uses.
      if (url.pathname === "/mcp") {
        const origin = `http://${req.headers.host}`;
        return send(
          401,
          { error: "unauthorized" },
          {
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
          },
        );
      }

      send(404, { error: "not_found", params: url.pathname });
    } catch {
      send(500, { error: "server_error", message: "fake server failed" });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    registrations: () => registrations,
    tokens: () => tokenCalls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Browser popup equivalent: GET the authorization URL, pull the code +
// state out of the 302 Location.
const followAuthorize = async (
  authorizationUrl: string,
): Promise<{ code: string; state: string }> => {
  const response = await fetch(authorizationUrl, { redirect: "manual" });
  expect(response.status).toBe(302);
  const location = response.headers.get("location");
  // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: browser redirect helper rejects malformed fake OAuth responses
  if (!location) throw new Error("no location header on authorize redirect");
  const dest = new URL(location);
  const code = dest.searchParams.get("code");
  const state = dest.searchParams.get("state");
  // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: browser redirect helper rejects malformed fake OAuth responses
  if (!code || !state) throw new Error(`redirect missing code/state: ${location}`);
  return { code, state };
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let fake: FakeServer;
beforeAll(async () => {
  fake = await startFakeServer();
});
afterAll(async () => {
  await fake.close();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mcp oauth end-to-end (node pool, real OAuth + MCP server)", () => {
  it.effect(
    "start rejects a redirectUrl on a different origin before discovery",
    () =>
      Effect.gen(function* () {
        const org = `org_${crypto.randomUUID()}`;
        const scopeId = ScopeId.make(org);
        const start = Date.now();

        const result = yield* asOrg(org, (client) =>
          client.oauth.start({
            params: { scopeId },
            payload: {
              endpoint: "https://example.test/api",
              redirectUrl: "https://other.example/cb",
              connectionId: "conn-foreign-redirect",
              tokenScope: String(scopeId),
              pluginId: "mcp",
              strategy: { kind: "dynamic-dcr" },
            },
          }),
        ).pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
        expect(Date.now() - start).toBeLessThan(1000);
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "start rejects non-http redirectUrl schemes",
    () =>
      Effect.gen(function* () {
        const org = `org_${crypto.randomUUID()}`;
        const scopeId = ScopeId.make(org);

        for (const redirectUrl of [
          "javascript:alert(1)",
          "data:text/html,<script>alert(1)</script>",
        ]) {
          const start = Date.now();
          const result = yield* asOrg(org, (client) =>
            client.oauth.start({
              params: { scopeId },
              payload: {
                endpoint: "https://example.test/api",
                redirectUrl,
                connectionId: `conn-${crypto.randomUUID().slice(0, 8)}`,
                tokenScope: String(scopeId),
                pluginId: "mcp",
                strategy: { kind: "dynamic-dcr" },
              },
            }),
          ).pipe(Effect.result);

          expect(Result.isFailure(result)).toBe(true);
          expect(Date.now() - start).toBeLessThan(1000);
        }
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "startOAuth → authorize → completeOAuth writes tokens at the invoker scope",
    () =>
      Effect.gen(function* () {
        const orgId = `org_${crypto.randomUUID()}`;
        const userId = `user_${crypto.randomUUID()}`;
        const userScope = ScopeId.make(testUserOrgScopeId(userId, orgId));
        const namespace = `ns_${crypto.randomUUID().slice(0, 8)}`;
        const connectionId = `mcp-oauth2-${namespace}`;
        const redirectUrl = "http://test.local/api/mcp/oauth/callback";

        const started = yield* asUser(userId, orgId, (client) =>
          client.oauth.start({
            params: { scopeId: userScope },
            payload: {
              endpoint: `${fake.url}/mcp`,
              redirectUrl,
              connectionId,
              tokenScope: String(userScope),
              strategy: { kind: "dynamic-dcr" },
              pluginId: "mcp",
            },
          }),
        );
        expect(started.sessionId).toMatch(/^oauth2_session_/);
        expect(started.authorizationUrl).not.toBeNull();

        const { code, state } = yield* Effect.promise(() =>
          followAuthorize(started.authorizationUrl!),
        );
        expect(state).toBe(started.sessionId);

        const completed = yield* asUser(userId, orgId, (client) =>
          client.oauth.complete({
            params: { scopeId: userScope },
            payload: { state, code },
          }),
        );
        expect(completed.connectionId).toBe(connectionId);
      }),
    30_000,
  );

  it.effect(
    "second user on same source re-uses DCR client: registration endpoint is not re-hit",
    () =>
      Effect.gen(function* () {
        const orgId = `org_${crypto.randomUUID()}`;
        const userA = `user_${crypto.randomUUID()}`;
        const userB = `user_${crypto.randomUUID()}`;
        const scopeA = ScopeId.make(testUserOrgScopeId(userA, orgId));
        const scopeB = ScopeId.make(testUserOrgScopeId(userB, orgId));
        const namespace = `ns_${crypto.randomUUID().slice(0, 8)}`;
        const connectionId = `mcp-oauth2-${namespace}`;
        const endpoint = `${fake.url}/mcp`;
        const redirectUrl = "http://test.local/api/mcp/oauth/callback";

        const regsBefore = fake.registrations();

        // --- User A: full OAuth round-trip, fresh DCR. ---
        const startedA = yield* asUser(userA, orgId, (client) =>
          client.oauth.start({
            params: { scopeId: scopeA },
            payload: {
              endpoint,
              redirectUrl,
              connectionId,
              tokenScope: String(scopeA),
              strategy: { kind: "dynamic-dcr" },
              pluginId: "mcp",
            },
          }),
        );
        const redirA = yield* Effect.promise(() => followAuthorize(startedA.authorizationUrl!));
        const completedA = yield* asUser(userA, orgId, (client) =>
          client.oauth.complete({
            params: { scopeId: scopeA },
            payload: { state: redirA.state, code: redirA.code },
          }),
        );
        expect(completedA.connectionId).toBe(connectionId);
        expect(fake.registrations()).toBe(regsBefore + 1);

        // --- User B: gets the same logical connection id in a different scope. ---
        const startedB = yield* asUser(userB, orgId, (client) =>
          client.oauth.start({
            params: { scopeId: scopeB },
            payload: {
              endpoint,
              redirectUrl,
              connectionId,
              tokenScope: String(scopeB),
              strategy: { kind: "dynamic-dcr" },
              pluginId: "mcp",
            },
          }),
        );
        const redirB = yield* Effect.promise(() => followAuthorize(startedB.authorizationUrl!));
        const completedB = yield* asUser(userB, orgId, (client) =>
          client.oauth.complete({
            params: { scopeId: scopeB },
            payload: { state: redirB.state, code: redirB.code },
          }),
        );
        expect(completedB.connectionId).toBe(connectionId);
        expect(fake.registrations()).toBe(regsBefore + 2);
      }),
    30_000,
  );
});
