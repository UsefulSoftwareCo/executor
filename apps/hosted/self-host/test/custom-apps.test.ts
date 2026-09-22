import { AppManagementHost } from "@executor-js/app-management";
import { SqlClient } from "effect/unstable/sql";
import { GroupDatabase } from "@executor-js/hosted-server/groups";
import { OrganizationId as ReferenceOrganizationId } from "@executor-js/hosted-server";
import { memorySourceStorage } from "@executor-js/sdk/testing";
/** Custom forms use the real hosted HTTP handlers, source generators, builder and storage. */
import { memoryBlobStore } from "@executor-js/sdk/blobs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, Redacted, Ref, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import { generateCustomApp } from "@executor-js/catalog";
import { defaultUrlPolicy } from "@executor-js/utils/url-policy";
import { pgliteLayer } from "fumadb-effect/pglite";
import {
  ToolBlocked,
  ToolApprovalRequired,
  ToolPolicyFailed,
  App,
  AppNameTaken,
  AppNotFound,
  Account,
  AccountConnection,
  OAuthClientUnavailable,
  OAuthCompletionFailed,
  OAuthSetupFailed,
  aesGcmCredentials,
  createExecutor,
  makeExecutorStorage,
} from "@executor-js/sdk/core";
import { nodeRuntime } from "@executor-js/sdk/node";
import {
  Authentication,
  HostedCatalog,
  HostedExecutor,
  ApiAuthentication,
  OrganizationDefaults,
  requireOrganizationLive,
  requireUserLive,
  OrganizationIcons,
  makeOrganizationIcons,
} from "@executor-js/hosted-server";
import { Principal } from "../../server/src/contracts/auth.ts";
import { hostedHandlers } from "@executor-js/hosted-server";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HostedApi } from "@executor-js/hosted-server/contracts";

// This legacy fixture exercises shared handlers; full product composition is verified in e2e.
const selfHostApi = HttpApiBuilder.layer(HostedApi).pipe(
  Layer.provide(hostedHandlers),
  HttpRouter.provideRequest(
    Layer.succeed(AppManagementHost, Effect.die("App authoring is outside this fixture")),
  ),
);
const fixtureEgress = {
  policy: defaultUrlPolicy,
  client: Effect.runSync(HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer))),
};

const origin = "http://localhost:4400";
test(
  "hosted custom imports compile all remote templates and enforce ownership, roles and create-only names",
  { timeout: 60_000 },
  async () => {
    const requests: string[] = [];
    const upstream = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      response.end(
        request.url === "/openapi.json"
          ? JSON.stringify({
              openapi: "3.0.3",
              info: { title: "Fixture", version: "1" },
              servers: [{ url: "/api" }],
              paths: {
                "/ping": {
                  get: { operationId: "ping", responses: { "200": { description: "OK" } } },
                },
              },
            })
          : JSON.stringify({ ok: true }),
      );
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const directory = yield* fs.makeTempDirectoryScoped({ prefix: "hosted-custom-" });
            const storage = yield* makeExecutorStorage({ provider: "postgresql" });
            yield* storage.migrate;
            const credentials = yield* aesGcmCredentials(Redacted.make("ab".repeat(32)), crypto);
            const executor = yield* createExecutor({
              blobs: memoryBlobStore(),
              sources: memorySourceStorage(),
              storage,
              credentials,
              runtime: nodeRuntime({ workDirectory: directory }),
            });
            const currentExecutor = yield* Ref.make(executor);
            const role = yield* Ref.make<"admin" | "member">("admin");
            const signedIn = yield* Ref.make(true);
            const principal = Schema.decodeUnknownSync(Principal)({
              userId: "fixture",
              sessionId: "fixture",
              name: "Fixture",
            });
            const auth = Layer.succeed(Authentication, {
              origin,
              organization: (reference) => Effect.succeed(ReferenceOrganizationId.make(reference)),
              organizationSlug: () => Effect.succeed("synthetic"),
              current: () => Ref.get(signedIn).pipe(Effect.map((yes) => (yes ? principal : null))),
              membership: () =>
                Ref.get(role).pipe(Effect.map((role) => ({ role, headers: new Headers() }))),
              removeOrganization: () => Effect.die("Organization removal is outside this fixture"),
            });
            const routes = selfHostApi.pipe(
              HttpRouter.provideRequest(
                Layer.succeed(GroupDatabase, Effect.succeed(yield* SqlClient.SqlClient)),
              ),
              HttpRouter.provideRequest(Layer.succeed(HostedExecutor, Ref.get(currentExecutor))),
              HttpRouter.provideRequest(
                Layer.succeed(HostedCatalog, {
                  list: Effect.succeed([]),
                  prepare: () => Effect.die("Custom imports do not use catalog entries"),
                  // This fixture is its own host, and its upstream runs on loopback.
                  custom: (input) => generateCustomApp(input, fixtureEgress),
                }),
              ),
              Layer.provide(requireUserLive),
              Layer.provide(requireOrganizationLive),
              Layer.provide(auth),
              HttpRouter.provideRequest(
                Layer.succeed(OrganizationIcons, makeOrganizationIcons(memoryBlobStore())),
              ),
              Layer.provide(HttpServer.layerServices),
              Layer.provide(
                Layer.succeed(ApiAuthentication, {
                  origin,
                  authenticate: () => Effect.die("Bearer access is not used in this fixture"),
                }),
              ),
              HttpRouter.provideRequest(Layer.succeed(OrganizationDefaults, () => Effect.void)),
            );
            const web = yield* Effect.acquireRelease(
              Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
              (web) => Effect.promise(() => web.dispose()),
            );
            const post = (body: unknown, path = "/apps/import", organization = "alpha") =>
              Effect.promise(() =>
                web.handler(
                  new Request(`${origin}/api/organizations/${organization}${path}`, {
                    method: "POST",
                    headers: { origin, "content-type": "application/json" },
                    body: JSON.stringify(path === "/apps/import" ? { source: body } : body),
                  }),
                ),
              );
            const importApp = (body: unknown) =>
              Effect.gen(function* () {
                const response = yield* post(body);
                assert.equal(
                  response.status,
                  200,
                  yield* Effect.promise(() => response.clone().text()),
                );
                return yield* Effect.promise(() => response.json()).pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(App))),
                );
              });
            const mcp = yield* importApp({
              kind: "mcp",
              name: "MCP fixture",
              url: `${base}/mcp`,
              auth: { type: "apiKey", header: "Authorization", prefix: "Bearer " },
              owner: "organization:beta",
            });
            assert.equal(mcp.owner, "organization:alpha");
            assert.equal(
              mcp.requirements.accounts.service?.definition.auth.apiKey?.type,
              "secrets",
            );
            const graphql = yield* importApp({
              kind: "graphql",
              name: "GraphQL fixture",
              url: `${base}/graphql`,
              auth: {
                type: "oauth",
                authorizationUrl: "http://oauth.example.test/authorize",
                tokenUrl: "http://oauth.example.test/token",
                scopes: ["read"],
              },
            });
            assert.equal(
              graphql.requirements.accounts.service?.definition.auth.oauth?.type,
              "oauth2",
            );
            const api = yield* importApp({
              kind: "openapi",
              name: "OpenAPI fixture",
              url: `${base}/openapi.json`,
              baseUrl: `${base}/override`,
            });
            assert.deepEqual(api.requirements.accounts, {});
            const inaccessible = yield* post(
              { tool: "queries.ping", input: {} },
              `/apps/${api.id}/tools/call`,
              "beta",
            );
            assert.equal(inaccessible.status, 404);
            assert.equal(
              (yield* Effect.promise(() => inaccessible.json()).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(AppNotFound)),
              )).app,
              api.id,
            );
            const called = yield* post(
              { tool: "queries.ping", input: {} },
              `/apps/${api.id}/tools/call`,
            );
            assert.equal(called.status, 200);
            assert.deepEqual(yield* Effect.promise(() => called.json()), { ok: true });
            assert.deepEqual(requests, ["/openapi.json", "/override/ping"]);

            // Approval outcomes must survive the native runtime and hosted HTTP error contracts.
            const guardedResponse = yield* post(
              {
                name: "Approval errors",
                files: [
                  {
                    path: "index.ts",
                    content: `import { withApproval, query, mutation, defineApp, object } from "apps";
import { always } from "apps/operations/approval";
const base = mutation({ description: "Guarded", input: object({}) }, async () => { throw new Error("Tool must not run"); });
export default defineApp({ accounts: {} }, async () => ({  mutations: {
        blocked: withApproval(base, () => "denied"),
        pending: withApproval(base, always()),
        failed: withApproval(base, () => { throw new Error("synthetic-private-policy"); }),
    } }));
`,
                  },
                ],
              },
              "/apps/deploy",
            );
            assert.equal(guardedResponse.status, 200);
            const guarded = yield* Effect.promise(() => guardedResponse.json()).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(App))),
            );
            for (const [tool, status, error] of [
              ["mutations.blocked", 403, ToolBlocked],
              ["mutations.pending", 409, ToolApprovalRequired],
              ["mutations.failed", 500, ToolPolicyFailed],
            ] as const) {
              const response = yield* post({ tool, input: {} }, `/apps/${guarded.id}/tools/call`);
              assert.equal(response.status, status);
              const body = yield* Effect.promise(() => response.json());
              const decoded = Schema.decodeUnknownSync(
                Schema.Union([ToolBlocked, ToolApprovalRequired, ToolPolicyFailed]),
              )(body);
              assert.ok(Schema.is(error)(decoded));
              assert.equal(decoded.app, guarded.id);
              assert.equal(decoded.tool, tool);
              assert.equal(JSON.stringify(body).includes("synthetic-private-policy"), false);
            }

            const connectionResponse = yield* post(
              { requirement: "service" },
              `/apps/${mcp.id}/connections`,
            );
            assert.equal(connectionResponse.status, 200);
            const connection = yield* Effect.promise(() => connectionResponse.json()).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(AccountConnection))),
            );
            const savedResponse = yield* post(
              { method: "apiKey", label: "Fixture", fields: { token: "synthetic-token" } },
              `/connections/${connection.id}/submit`,
            );
            assert.equal(savedResponse.status, 200);
            const saved = yield* Effect.promise(() => savedResponse.json()).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(Account))),
            );
            assert.equal(saved.owner, "organization:alpha");
            assert.equal((yield* executor.apps.get({ app: mcp.id })).accounts.service, saved.id);

            // The same errors reach the dashboard with their discriminants and safe details intact.
            const oauthConnectionResponse = yield* post(
              { requirement: "service" },
              `/apps/${graphql.id}/connections`,
            );
            assert.equal(oauthConnectionResponse.status, 200);
            const oauthConnection = yield* Effect.promise(() =>
              oauthConnectionResponse.json(),
            ).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(AccountConnection))),
            );
            const oauthPath = `/connections/${oauthConnection.id}/oauth`;
            const oauthInput = {
              method: "oauth",
              label: "Fixture",
              client: {
                clientId: "fixture",
                clientSecret: "synthetic-client-secret",
                tokenEndpointAuthMethod: "client_secret_post",
              },
            };
            const needsClient = yield* post(oauthInput, `${oauthPath}/start`);
            assert.equal(needsClient.status, 409);
            const needsClientBody = yield* Effect.promise(() => needsClient.text());
            assert.equal(
              Schema.decodeUnknownSync(Schema.fromJsonString(OAuthClientUnavailable))(
                needsClientBody,
              ).method,
              "oauth",
            );
            assert.ok(!needsClientBody.includes("synthetic-client-secret"));
            const callback = yield* post(
              { callbackUrl: `${origin}/api/oauth/callback?code=synthetic-secret` },
              `${oauthPath}/complete`,
            );
            assert.equal(callback.status, 400);
            const callbackBody = yield* Effect.promise(() => callback.text());
            assert.equal(
              Schema.decodeUnknownSync(Schema.fromJsonString(OAuthCompletionFailed))(callbackBody)
                .reason,
              "invalid_callback",
            );
            assert.ok(!callbackBody.includes("synthetic-secret"));

            yield* Ref.set(
              currentExecutor,
              yield* createExecutor({
                blobs: memoryBlobStore(),
                sources: memorySourceStorage(),
                storage,
                credentials,
                runtime: nodeRuntime({ workDirectory: directory }),
                oauth: {
                  clientName: "Fixture",
                  urlPolicy: defaultUrlPolicy,
                  httpClient: HttpClient.make(() =>
                    Effect.die("Insecure OAuth endpoints must fail before network access"),
                  ),
                },
              }),
            );
            const setup = yield* post(oauthInput, `${oauthPath}/start`);
            assert.equal(setup.status, 422);
            const setupBody = yield* Effect.promise(() => setup.text());
            assert.equal(
              Schema.decodeUnknownSync(Schema.fromJsonString(OAuthSetupFailed))(setupBody).reason,
              "discovery",
            );
            assert.ok(!setupBody.includes("synthetic-client-secret"));

            const duplicate = yield* post({
              kind: "mcp",
              name: "MCP fixture",
              url: `${base}/other`,
              auth: { type: "none" },
            });
            assert.equal(duplicate.status, 409);
            assert.equal(
              (yield* Effect.promise(() => duplicate.json()).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(AppNameTaken)),
              )).name,
              "MCP fixture",
            );
            assert.equal(
              (yield* executor.apps.get({ app: mcp.id })).activeDeployment,
              mcp.activeDeployment,
            );
            for (const body of [
              { kind: "mcp-stdio", name: "No process", command: "node", args: [], environment: [] },
              {
                kind: "graphql",
                name: "Bad URL",
                url: `${base}/graphql?token=secret`,
                auth: { type: "none" },
              },
              {
                kind: "mcp",
                name: "Bad header",
                url: `${base}/mcp`,
                auth: { type: "apiKey", header: "Cookie", prefix: "" },
              },
            ])
              assert.equal((yield* post(body)).status, 400);
            yield* Ref.set(role, "member");
            assert.equal(
              (yield* post({ kind: "openapi", name: "Denied", url: `${base}/openapi.json` }))
                .status,
              403,
            );
            assert.deepEqual(requests, ["/openapi.json", "/override/ping"]);
            yield* Ref.set(signedIn, false);
            assert.equal(
              (yield* post({
                kind: "mcp",
                name: "Signed out",
                url: `${base}/mcp`,
                auth: { type: "none" },
              })).status,
              401,
            );
          }),
        ).pipe(Effect.provide(pgliteLayer()), Effect.provide(NodeServices.layer)),
      );
    } finally {
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
