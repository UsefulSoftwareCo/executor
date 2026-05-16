// ---------------------------------------------------------------------------
// Cloud API × MCP OAuth — real HTTP end-to-end
// ---------------------------------------------------------------------------
//
// Drives the ProtectedCloudApi through the node-pool harness against the shared
// real in-process OAuth test server. Every layer between the test and the
// plugin is real:
//
//   test → HttpApiClient → in-process webHandler → ProtectedCloudApi
//        → Core OAuthHandlers → executor.oauth.start / complete
//        → MCP SDK `auth()`
//        → OAuthTestServer (DCR, /authorize → login, /token, AS metadata,
//          protected resource metadata, MCP protected resource)
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

import { describe, expect, it } from "@effect/vitest";

import { Effect, Result } from "effect";
import { ScopeId } from "@executor-js/sdk";
import { serveOAuthTestServer, type OAuthTestServerShape } from "@executor-js/sdk/testing";

import { asOrg, asUser, testUserOrgScopeId } from "./__test-harness__/api-harness";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const countRequestsTo = (oauth: OAuthTestServerShape, path: string): Effect.Effect<number> =>
  oauth.requests.pipe(Effect.map((requests) => requests.filter((r) => r.path === path).length));

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
      Effect.scoped(
        Effect.gen(function* () {
          const oauth = yield* serveOAuthTestServer();
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
                endpoint: oauth.mcpResourceUrl,
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

          const { code, state } = yield* oauth.completeAuthorizationCodeFlow({
            authorizationUrl: started.authorizationUrl!,
          });
          expect(state).toBe(started.sessionId);

          const completed = yield* asUser(userId, orgId, (client) =>
            client.oauth.complete({
              params: { scopeId: userScope },
              payload: { state, code },
            }),
          );
          expect(completed.connectionId).toBe(connectionId);
        }),
      ),
    30_000,
  );

  it.effect(
    "second user on same source re-uses DCR client: registration endpoint is not re-hit",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const oauth = yield* serveOAuthTestServer();
          const orgId = `org_${crypto.randomUUID()}`;
          const userA = `user_${crypto.randomUUID()}`;
          const userB = `user_${crypto.randomUUID()}`;
          const scopeA = ScopeId.make(testUserOrgScopeId(userA, orgId));
          const scopeB = ScopeId.make(testUserOrgScopeId(userB, orgId));
          const namespace = `ns_${crypto.randomUUID().slice(0, 8)}`;
          const connectionId = `mcp-oauth2-${namespace}`;
          const endpoint = oauth.mcpResourceUrl;
          const redirectUrl = "http://test.local/api/mcp/oauth/callback";

          const regsBefore = yield* countRequestsTo(oauth, "/register");

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
          const redirA = yield* oauth.completeAuthorizationCodeFlow({
            authorizationUrl: startedA.authorizationUrl!,
          });
          const completedA = yield* asUser(userA, orgId, (client) =>
            client.oauth.complete({
              params: { scopeId: scopeA },
              payload: { state: redirA.state, code: redirA.code },
            }),
          );
          expect(completedA.connectionId).toBe(connectionId);
          expect(yield* countRequestsTo(oauth, "/register")).toBe(regsBefore + 1);

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
          const redirB = yield* oauth.completeAuthorizationCodeFlow({
            authorizationUrl: startedB.authorizationUrl!,
          });
          const completedB = yield* asUser(userB, orgId, (client) =>
            client.oauth.complete({
              params: { scopeId: scopeB },
              payload: { state: redirB.state, code: redirB.code },
            }),
          );
          expect(completedB.connectionId).toBe(connectionId);
          expect(yield* countRequestsTo(oauth, "/register")).toBe(regsBefore + 2);
        }),
      ),
    30_000,
  );
});
