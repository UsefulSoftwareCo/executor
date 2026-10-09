/**
 * Cloud's role hosts (`notes/cloud-domains.md`): `app.` serves the dashboard and sign-in, `mcp.`
 * MCP and its discovery, `api.` the API, its discovery and app webhooks, and the edge (standing in
 * for `executor.sh`) the issuer's metadata and provider returns. The deployment origin keeps
 * everything but browser pages. Each grant is for one resource and works at every origin of that
 * resource's kind. Every request's server span names the host it arrived at and that host's role.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schedule, Schema } from "effect";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { Telemetry } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { McpClient } from "../support/mcp-client.ts";
import { McpOAuth, type Grant } from "../support/mcp-oauth.ts";
import { Target } from "../support/platform.ts";
import { rawRequest, roleHost } from "../support/role-hosts.ts";
import { scenarios } from "../test-plan.ts";

const ProtectedResource = Schema.fromJsonString(
  Schema.Struct({
    resource: Schema.String,
    authorization_servers: Schema.Array(Schema.String),
  }),
);
const AuthorizationServer = Schema.fromJsonString(
  Schema.Struct({
    issuer: Schema.String,
    authorization_endpoint: Schema.String,
    token_endpoint: Schema.String,
  }),
);
const Token = Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) });
const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "executor-e2e", version: "1" },
  },
});
const mcpPost = (bearer?: string) => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
  },
  body: initialize,
});
const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
const accessToken = (grant: Grant) => Redacted.value(grant.tokens).access_token;

layer(HostedLive, { excludeTestServices: true })("Cloud role hosts", (it) => {
  it.effect(scenarios.cloudRoleHostRoutes.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          target = yield* Target;
        const origin = target.metadata.origin;
        const mcp = roleHost(origin, "mcp"),
          apiHost = roleHost(origin, "api"),
          app = roleHost(origin, "app"),
          edge = roleHost(origin, "edge");
        const inventory = `/api/organizations/${actors.organization.id}/inventory`;
        const issued = yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
          name: "Cloud role hosts",
        });
        expect(issued.status).toBe(200);
        const pat = yield* body(Token, issued);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: pat.id })
            .pipe(Effect.orDie),
        );
        const key = Redacted.value(pat.key);

        // Discovery on each host names that host's resource and the issuer on the edge.
        const issuer = `${edge}/api/auth`;
        for (const [at, path, resource] of [
          [mcp, "/.well-known/oauth-protected-resource/mcp", `${mcp}/mcp`],
          [mcp, "/.well-known/oauth-protected-resource", `${mcp}/mcp`],
          [origin, "/.well-known/oauth-protected-resource/mcp", `${origin}/mcp`],
          [apiHost, "/.well-known/oauth-protected-resource/api", `${apiHost}/api`],
          [origin, "/.well-known/oauth-protected-resource/api", `${origin}/api`],
        ] as const) {
          const response = yield* rawRequest(`${at}${path}`);
          expect(response.status, `${at}${path}`).toBe(200);
          expect(yield* Schema.decodeUnknownEffect(ProtectedResource)(response.text)).toEqual({
            resource,
            authorization_servers: [issuer],
          });
        }
        // The edge serves the issuer's metadata itself; every endpoint is on the browser origin.
        for (const at of [edge, mcp, apiHost, origin]) {
          const metadata = yield* rawRequest(
            `${at}/.well-known/oauth-authorization-server/api/auth`,
          );
          expect(metadata.status, at).toBe(200);
          expect(yield* Schema.decodeUnknownEffect(AuthorizationServer)(metadata.text), at).toEqual(
            {
              issuer,
              authorization_endpoint: `${app}/api/auth/oauth2/authorize`,
              token_endpoint: `${app}/api/auth/oauth2/token`,
            },
          );
        }
        // Challenges point a client at the discovery document of the host it called.
        const mcpChallenge = yield* rawRequest(`${mcp}/mcp`, mcpPost());
        expect(mcpChallenge.status).toBe(401);
        expect(mcpChallenge.challenge).toContain(
          `resource_metadata="${mcp}/.well-known/oauth-protected-resource/mcp?`,
        );
        const apiChallenge = yield* rawRequest(`${apiHost}/api`);
        expect(apiChallenge.status).toBe(401);
        expect(apiChallenge.challenge).toContain(
          `resource_metadata="${apiHost}/.well-known/oauth-protected-resource/api"`,
        );

        // `api.` serves the API to a personal access token, as the deployment origin does.
        for (const at of [apiHost, origin])
          expect((yield* rawRequest(`${at}${inventory}`, bearer(key))).status, at).toBe(200);
        expect((yield* rawRequest(`${apiHost}/openapi.json`)).status).toBe(200);
        // App webhooks reach the same handler on `api.` as on the deployment origin.
        const hook = `/api/webhooks/${randomUUID()}/${randomUUID()}`;
        const hookAtOrigin = yield* rawRequest(`${origin}${hook}`, { method: "POST", body: "{}" });
        expect(hookAtOrigin.status).not.toBe(404);
        expect(
          (yield* rawRequest(`${apiHost}${hook}`, { method: "POST", body: "{}" })).status,
        ).toBe(hookAtOrigin.status);

        // Each role host and the edge refuse every other route, whatever credential it carries.
        const refused: ReadonlyArray<readonly [string, string, RequestInit?]> = [
          [mcp, inventory, bearer(key)],
          [mcp, "/api"],
          [mcp, "/.well-known/oauth-protected-resource/api"],
          [mcp, "/openapi.json"],
          [mcp, "/api/auth/get-session"],
          [mcp, "/login"],
          [mcp, hook, { method: "POST", body: "{}" }],
          [apiHost, "/mcp", mcpPost(key)],
          [apiHost, `/org/${actors.organization.slug}/mcp`, mcpPost(key)],
          [apiHost, "/.well-known/oauth-protected-resource/mcp"],
          [apiHost, "/api/auth/get-session"],
          [apiHost, "/api/entry"],
          [apiHost, "/api/oauth/callback"],
          [apiHost, "/login"],
          [app, "/mcp", mcpPost(key)],
          [app, `/org/${actors.organization.slug}/mcp`, mcpPost(key)],
          [app, "/.well-known/oauth-protected-resource/mcp"],
          [edge, "/mcp", mcpPost(key)],
          [edge, "/login"],
          [edge, inventory, bearer(key)],
          [edge, "/api/auth/get-session"],
          [edge, "/api/auth/oauth2/token", { method: "POST" }],
          [edge, "/.well-known/oauth-protected-resource/mcp"],
          [edge, "/api/auth/callback"],
          // No OpenID configuration exists, so the edge forwards none.
          [edge, "/api/auth/.well-known/openid-configuration"],
        ];
        for (const [at, path, init] of refused)
          expect((yield* rawRequest(`${at}${path}`, init)).status, `${at}${path}`).toBe(404);
        // The deployment origin keeps MCP, the API and Better Auth's client endpoints.
        expect((yield* rawRequest(`${origin}/mcp`, mcpPost())).status).toBe(401);
        expect((yield* rawRequest(`${origin}/api/auth/get-session`)).status).toBe(200);
        expect((yield* rawRequest(`${origin}${inventory}`, bearer(key))).status).toBe(200);

        // The browser origin serves sign-in and the dashboard API.
        const login = yield* rawRequest(`${app}/login`, { headers: { accept: "text/html" } });
        expect(login.status).toBe(200);
        expect((yield* rawRequest(`${app}/api/auth/get-session`)).status).toBe(200);
        // The deployment origin's browser pages, and the authorization a browser opens, move to
        // the browser origin for good, path and query intact.
        for (const path of [
          "/login?redirect=%2Forg%2Fexample",
          `/org/${actors.organization.slug}/apps`,
          "/mcp/authorize?client_id=example",
          "/api/auth/oauth2/authorize?client_id=example&state=s",
        ]) {
          const page = yield* rawRequest(`${origin}${path}`, { headers: { accept: "text/html" } });
          expect(page.status, path).toBe(308);
          expect(page.location).toBe(`${app}${path}`);
          expect(page.cacheControl).toBe("no-store");
        }
        // A provider's return to the edge goes, once, to the browser origin, where the sign-in's
        // state cookie is.
        const callback = "/api/auth/callback/google?code=single-use&state=signed";
        const bounced = yield* rawRequest(`${edge}${callback}`);
        expect(bounced.status).toBe(302);
        expect(bounced.location).toBe(`${app}${callback}`);
        expect(bounced.cacheControl).toBe("no-store");
      }),
    ),
  );

  it.effect(scenarios.cloudRoleHostGrants.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          target = yield* Target,
          browser = yield* Browser,
          oauth = yield* McpOAuth,
          clients = yield* McpClient;
        // Consent happens in the owner's browser on the browser origin.
        yield* browser.login(actors.owner);
        const origin = target.metadata.origin;
        const mcp = roleHost(origin, "mcp"),
          apiHost = roleHost(origin, "api");
        const inventory = `/api/organizations/${actors.organization.id}/inventory`;
        const listTools = (token: string, label: string, at: string) =>
          Effect.gen(function* () {
            const client = yield* clients.connect(Redacted.make(token), label, { origin: at });
            const tools = yield* client.use("List tools", (client, signal) =>
              client.listTools(undefined, { signal }),
            );
            expect(tools.tools.length, label).toBeGreaterThan(0);
          }).pipe(Effect.scoped);

        // A grant for the MCP resource the client found on `mcp.` works there and at the
        // deployment origin; so does a grant for the deployment origin's resource.
        const atRoleHost = yield* oauth.authorizeAt("mcp", mcp);
        expect(atRoleHost.resource).toBe(`${mcp}/mcp`);
        const atOrigin = yield* oauth.authorize;
        expect(atOrigin.resource).toBe(`${origin}/mcp`);
        for (const [grant, label] of [
          [atRoleHost, "role-host-grant"],
          [atOrigin, "origin-grant"],
        ] as const) {
          yield* listTools(accessToken(grant), `${label}-on-role-host`, mcp);
          yield* listTools(accessToken(grant), `${label}-on-origin`, origin);
          // An MCP grant is not an API grant on either API origin.
          for (const at of [apiHost, origin])
            expect(
              (yield* rawRequest(`${at}${inventory}`, bearer(accessToken(grant)))).status,
              `${label} at ${at}`,
            ).toBe(401);
        }
        // Refreshing keeps the role host's resource.
        const refreshed = yield* oauth.refresh(atRoleHost);
        yield* listTools(accessToken(refreshed), "refreshed-on-role-host", mcp);

        // An API grant found on `api.` serves the API at both origins and never MCP.
        const api = yield* oauth.authorizeAt("api", apiHost);
        expect(api.resource).toBe(`${apiHost}/api`);
        for (const at of [apiHost, origin])
          expect(
            (yield* rawRequest(`${at}${inventory}`, bearer(accessToken(api)))).status,
            at,
          ).toBe(200);
        for (const at of [mcp, origin])
          expect((yield* rawRequest(`${at}/mcp`, mcpPost(accessToken(api)))).status, at).toBe(401);
      }).pipe(Effect.provide(Layer.merge(McpOAuth.layer, McpClient.layer))),
    ),
  );

  it.effect(scenarios.cloudRoleHostSpans.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          target = yield* Target,
          telemetry = yield* Telemetry;
        const origin = target.metadata.origin;
        const issued = yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
          name: "Cloud role host spans",
        });
        expect(issued.status).toBe(200);
        const pat = yield* body(Token, issued);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: pat.id })
            .pipe(Effect.orDie),
        );
        const inventory = `/api/organizations/${actors.organization.id}/inventory`;
        const inventoryRoute = "/api/organizations/:organization/inventory";
        // A private value in each query string; no span may record it.
        const marker = `private-${randomUUID()}`;
        const requests = [
          {
            role: "deployment",
            url: `${origin}${inventory}?marker=${marker}`,
            init: bearer(Redacted.value(pat.key)),
            status: 200,
            route: inventoryRoute,
          },
          {
            role: "api",
            url: `${roleHost(origin, "api")}${inventory}?marker=${marker}`,
            init: bearer(Redacted.value(pat.key)),
            status: 200,
            route: inventoryRoute,
          },
          {
            role: "mcp",
            url: `${roleHost(origin, "mcp")}/org/${actors.organization.slug}/mcp?marker=${marker}`,
            init: mcpPost(),
            status: 401,
            route: "/org/:organization/mcp",
          },
          // `app.` refuses MCP before any router runs, so it has no route to name.
          {
            role: "app",
            url: `${roleHost(origin, "app")}/mcp?marker=${marker}`,
            init: mcpPost(),
            status: 404,
            route: undefined,
          },
          // A provider's return; the redirect's `Location` carries the query, and no span may.
          {
            role: "edge",
            url: `${roleHost(origin, "edge")}/api/auth/callback/github?code=${marker}&state=${marker}`,
            init: { headers: {} },
            status: 302,
            route: "/api/auth/callback/:provider",
          },
        ] as const;
        for (const request of requests) {
          const traceId = randomBytes(16).toString("hex"),
            parent = randomBytes(8).toString("hex");
          const response = yield* rawRequest(request.url, {
            ...request.init,
            headers: { ...request.init.headers, traceparent: `00-${traceId}-${parent}-01` },
          });
          expect(response.status, request.url).toBe(request.status);
          const server = yield* telemetry.query(traceId).pipe(
            Effect.flatMap((result) => {
              const found = result.data.find(
                ({ span }) =>
                  span.parentSpanId === parent && span.operationName.startsWith("http.server"),
              );
              return found === undefined
                ? Effect.fail(new Error(`No server span for ${request.role}`))
                : Effect.succeed(found.span);
            }),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
          );
          const url = new URL(request.url);
          expect(
            {
              address: server.tags["server.address"],
              role: server.tags["executor.host_role"],
              path: server.tags["url.path"],
              route: server.tags["http.route"],
            },
            request.role,
          ).toEqual({
            address: url.hostname,
            role: request.role,
            // A matched route's path is its template; the request's own values are not recorded.
            path: request.route ?? url.pathname,
            route: request.route,
          });
          // The path is recorded without its query string, and nothing else carries it.
          expect(JSON.stringify(server), request.role).not.toContain(marker);
          expect(server.tags["url.full"]).toBeUndefined();
          expect(server.tags["url.query"]).toBeUndefined();
        }
      }),
    ),
  );
});
