import { AppManagementHost } from "@executor-js/app-management";
import { readExecutorSkills } from "@executor-js/app-templates/executor";
import { hostedResourceLifecycle } from "../../server/src/implementation/resource-lifecycle.ts";
import { CurrentUserId } from "../../server/src/contracts/auth.ts";
import { CurrentOrganization } from "../../server/src/contracts/organization.ts";
import * as Accounts from "../../server/src/implementation/accounts.ts";
import { GroupDatabase } from "@executor-js/hosted-server/groups";
import { executorSelfHostApiDocument } from "../src/contracts/api.ts";
import type { GrantPolicy } from "@executor-js/mcp-auth/grants";
import { BrowserExecutionResult } from "@executor-js/mcp";
import { gitSourceStorage } from "@executor-js/app-source";
import { nativeRepositories } from "@executor-js/app-source/node";
import { remoteRegistry } from "@executor-js/app-registry";
/** Real Better Auth grants, PGlite, Effect HTTP transport, and the official MCP client. */
import { memoryBlobStore } from "@executor-js/sdk/blobs";
import { defaultUrlPolicy } from "@executor-js/utils/url-policy";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { OrganizationReference } from "@executor-js/hosted-server/organization";
import { betterAuth } from "better-auth";
import { makeSignature } from "better-auth/crypto";
import { ConfigProvider, Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import {
  authOptions,
  authSettings,
  HostedExecutor,
  HostedCatalog,
  OrganizationDefaults,
  OrganizationId,
  organizationDefaults,
  apiProtectedResource,
  apiChallenge,
  requireOrganizationLive,
  requireUserLive,
  mcpProtectedResource,
  mcpAuthorizationServer,
  hostedOAuthCallback,
  OrganizationIcons,
  makeOrganizationIcons,
} from "@executor-js/hosted-server";
import {
  HttpUrl,
  OwnerId,
  ToolName,
  aesGcmCredentials,
  createExecutor,
  makeExecutorStorage,
  type App,
} from "@executor-js/sdk/core";
import { nodeRuntime } from "@executor-js/sdk/node";
import { ExecuteResult, McpExecutionResult } from "@executor-js/mcp";
import { selfHostDatabase } from "../src/database.ts";
import { AuthDatabase } from "../src/contracts/database.ts";
import { selfHostAuth } from "../src/auth.ts";
import { hostedHandlers } from "@executor-js/hosted-server";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HostedApi } from "@executor-js/hosted-server/contracts";

// This legacy fixture exercises shared handlers; full product composition is verified in e2e.
const selfHostApi = HttpApiBuilder.layer(HostedApi).pipe(Layer.provide(hostedHandlers));
import { selfHostMcp } from "../src/mcp.ts";

const origin = "http://127.0.0.1:55439";
const secret = "synthetic-mcp-oauth-signing-secret-only";
const encryptionKey = "ab".repeat(32);
const Registered = Schema.Struct({ client_id: Schema.NonEmptyString });
const Redirect = Schema.Struct({ url: Schema.NonEmptyString });
const Tokens = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
});

test(
  "browser OAuth binds an organization and rechecks grants and membership on every MCP request",
  { timeout: 60_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-mcp-oauth-" });
          const configuration = ConfigProvider.fromUnknown({
            EXECUTOR_DATA_DIR: directory,
            BETTER_AUTH_URL: origin,
            BETTER_AUTH_SECRET: secret,
            EXECUTOR_ENCRYPTION_KEY: encryptionKey,
            GOOGLE_CLIENT_ID: "synthetic-google",
            GOOGLE_CLIENT_SECRET: "synthetic-google-secret",
            GITHUB_CLIENT_ID: "synthetic-github",
            GITHUB_CLIENT_SECRET: "synthetic-github-secret",
          });
          yield* Effect.gen(function* () {
            const database = yield* AuthDatabase;
            const settings = yield* authSettings;
            const auth = betterAuth({
              ...authOptions(settings, []),
              database,
              secret,
              rateLimit: { enabled: false },
            });
            const context = yield* Effect.promise(() => auth.$context);
            const user = yield* Effect.promise(() =>
              context.internalAdapter.createUser(
                { name: "Example", email: "example@example.test", emailVerified: true },
                { method: "admin" },
              ),
            );
            const session = yield* Effect.promise(() =>
              context.internalAdapter.createSession(user.id),
            );
            const signature = yield* Effect.promise(() => makeSignature(session.token, secret));
            const cookie = `executor-hosted.session_token=${encodeURIComponent(`${session.token}.${signature}`)}`;
            const a = yield* Effect.promise(() =>
              auth.api.createOrganization({
                body: { name: "Alpha", slug: "alpha", userId: user.id },
              }),
            );
            const b = yield* Effect.promise(() =>
              auth.api.createOrganization({
                body: { name: "Beta", slug: "beta", userId: user.id },
              }),
            );
            assert.ok(a && b);
            const credentials = yield* aesGcmCredentials(Redacted.make(encryptionKey), crypto);
            const storage = yield* makeExecutorStorage({ provider: "postgresql" });
            const source = `import { query, mutation, defineApp, object } from "apps";
export default defineApp({ accounts: {} }, async (appContext) => ({  mutations: { hello: mutation({ description: "Say hello",
            input: object({}) }, async (operationContext, _input) => {
            return "hello";
        }) } }));
`;
            const repositories = nativeRepositories(`${directory}/repositories`);
            const sources = gitSourceStorage(repositories);
            const blobs = memoryBlobStore();
            const executor = yield* createExecutor({
              blobs,
              sources,
              lifecycle: yield* hostedResourceLifecycle,
              storage,
              credentials,
              runtime: nodeRuntime({ workDirectory: `${directory}/builds` }),
              oauth: {
                httpClient: yield* HttpClient.HttpClient,
                clientName: "Executor app test",
                urlPolicy: defaultUrlPolicy,
              },
            });
            const fixtureSql = yield* SqlClient.SqlClient;
            const fixtureDeploy = (input: Parameters<typeof executor.apps.deploy>[0]) =>
              executor.apps.deploy(input).pipe(
                Effect.provideService(CurrentUserId, user.id),
                Effect.tap(
                  ({ app }) =>
                    fixtureSql`update hosted_app_access set audience = 'everyone' where id = ${app.id}`,
                ),
              );
            const skills = yield* readExecutorSkills;
            const initialize = yield* organizationDefaults(
              executor,
              origin,
              storage,
              skills,
              executorSelfHostApiDocument(origin),
            );
            yield* Effect.all(
              [initialize(OrganizationId.make(a.id)), initialize(OrganizationId.make(a.id))],
              { concurrency: "unbounded" },
            );
            yield* initialize(OrganizationId.make(b.id));
            const executorA = (yield* executor.apps.list({
              owner: OwnerId.make(`organization:${a.id}`),
            })).find((app) => app.name === "Executor");
            const executorB = (yield* executor.apps.list({
              owner: OwnerId.make(`organization:${b.id}`),
            })).find((app) => app.name === "Executor");
            assert.ok(executorA && executorB);
            assert.notEqual(executorA.id, "app_executor");
            assert.notEqual(executorA.id, executorB.id);
            assert.equal(
              (yield* executor.apps.list({ owner: executorA.owner })).length,
              1,
              "concurrent initialization creates one normal app",
            );
            const originalDeployment = executorA.activeDeployment;
            yield* initialize(OrganizationId.make(a.id));
            assert.equal(
              (yield* executor.apps.get({ app: executorA.id })).activeDeployment,
              originalDeployment,
            );
            assert.deepEqual(
              (yield* executor.apps.source({ app: executorA.id })).files
                .map((file) => file.path)
                .sort(),
              [
                "index.ts",
                "openapi.json",
                "provider.ts",
                ...skills.map((file) => file.path),
              ].sort(),
            );
            const alpha = yield* fixtureDeploy({
              owner: OwnerId.make(`organization:${a.id}`),
              name: "Alpha app",
              files: [{ path: "index.ts", content: source }],
            });
            yield* fixtureDeploy({
              owner: OwnerId.make(`organization:${b.id}`),
              name: "Beta app",
              files: [{ path: "index.ts", content: source }],
            });
            const hosted = yield* selfHostAuth;
            const mcp = yield* selfHostMcp.pipe(Effect.provide(HttpServer.layerServices));
            const sdk = Layer.mergeAll(
              Layer.succeed(GroupDatabase, Effect.succeed(yield* SqlClient.SqlClient)),
              Layer.succeed(HostedExecutor, Effect.succeed(executor)),
              Layer.succeed(OrganizationDefaults, initialize),
            );
            const catalog = Layer.succeed(HostedCatalog, {
              list: Effect.succeed([]),
              prepare: () => Effect.die("Unexpected catalog import"),
              custom: () => Effect.die("This fixture does not import custom apps"),
            });
            const routes = Layer.mergeAll(
              selfHostApi.pipe(
                HttpRouter.provideRequest(
                  Layer.succeed(
                    AppManagementHost,
                    Effect.succeed({
                      executor,
                      sources,
                      repositories,
                      blobs,
                      registry: remoteRegistry(origin),
                      publisher: undefined,
                    }),
                  ),
                ),
                HttpRouter.provideRequest(
                  Layer.succeed(GroupDatabase, Effect.succeed(yield* SqlClient.SqlClient)),
                ),
                Layer.provide(requireOrganizationLive),
                Layer.provide(requireUserLive),
                Layer.provide(hosted.identity),
                Layer.provide(hosted.apiIdentity),
                HttpRouter.provideRequest(sdk),
                HttpRouter.provideRequest(catalog),
              ),
              HttpRouter.add("GET", "/api", apiChallenge),
              HttpRouter.add(
                "GET",
                "/.well-known/oauth-protected-resource/api",
                apiProtectedResource,
              ),
              HttpRouter.add("*", "/api/auth/*", hosted.handler),
              HttpRouter.add("GET", "/api/oauth/callback", hostedOAuthCallback),
              HttpRouter.add("*", "/mcp", mcp.http).pipe(HttpRouter.provideRequest(sdk)),
              HttpRouter.add("*", "/org/:organization/mcp", mcp.http).pipe(
                HttpRouter.provideRequest(sdk),
              ),
              HttpRouter.add("GET", "/api/mcp/approvals/:requestId", mcp.approvals).pipe(
                HttpRouter.provideRequest(sdk),
              ),
              HttpRouter.add("POST", "/api/mcp/approvals/:requestId", mcp.approvals).pipe(
                HttpRouter.provideRequest(sdk),
              ),
              HttpRouter.add("GET", "/.well-known/oauth-protected-resource", mcpProtectedResource),
              HttpRouter.add(
                "GET",
                "/.well-known/oauth-protected-resource/mcp",
                mcpProtectedResource,
              ),
              HttpRouter.add(
                "GET",
                "/.well-known/oauth-authorization-server",
                mcpAuthorizationServer,
              ),
              HttpRouter.add(
                "GET",
                "/.well-known/oauth-authorization-server/api/auth",
                mcpAuthorizationServer,
              ),
            ).pipe(
              HttpRouter.provideRequest(hosted.mcpIdentity),
              HttpRouter.provideRequest(hosted.apiIdentity),
              HttpRouter.provideRequest(hosted.identity),
              HttpRouter.provideRequest(catalog),
              HttpRouter.provideRequest(
                Layer.succeed(OrganizationIcons, makeOrganizationIcons(memoryBlobStore())),
              ),
              Layer.provide(HttpServer.layerServices),
              Layer.provide(NodeServices.layer),
            );
            // App code uses ordinary network fetch; no management-specific in-process transport.
            yield* Layer.build(
              HttpRouter.serve(routes, { disableLogger: true }).pipe(
                Layer.provide(
                  NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 55439 }),
                ),
              ),
            );
            const browserHttp = yield* HttpClient.HttpClient.pipe(
              Effect.provide(NodeHttpClient.layerNodeHttp),
            );
            const request = (path: string, init?: RequestInit) =>
              Effect.gen(function* () {
                const request = new Request(`${origin}${path}`, init);
                if (path.startsWith("/api/auth/oauth2/authorize?")) {
                  request.headers.set("accept", "text/html");
                  request.headers.set("sec-fetch-mode", "navigate");
                }
                let outgoing = HttpClientRequest.fromWeb(request);
                if (request.body !== null)
                  outgoing = HttpClientRequest.bodyUint8Array(
                    outgoing,
                    new Uint8Array(yield* Effect.promise(() => request.arrayBuffer())),
                    request.headers.get("content-type") ?? undefined,
                  );
                const response = yield* browserHttp.execute(outgoing);
                const body = yield* response.arrayBuffer;
                return new Response(body, { status: response.status, headers: response.headers });
              });
            const json = <A>(response: Response, schema: Schema.Decoder<A>) =>
              Effect.promise(() => response.json()).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(schema)),
              );
            const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
              request(path, {
                method: "POST",
                headers: { "content-type": "application/json", ...headers },
                body: JSON.stringify(body),
              });
            const challenge = yield* post("/mcp", {});
            assert.equal(challenge.status, 401);
            assert.equal(challenge.headers.get("cache-control"), "no-store");
            assert.match(
              challenge.headers.get("www-authenticate") ?? "",
              /oauth-protected-resource\/mcp/,
            );
            const callback = yield* request(
              "/api/oauth/callback?code=synthetic-code&state=synthetic-state",
            );
            assert.equal(callback.status, 302);
            assert.equal(
              callback.headers.get("location"),
              `${origin}/oauth/callback?code=synthetic-code&state=synthetic-state`,
            );
            assert.equal(callback.headers.get("cache-control"), "no-store");
            assert.equal(callback.headers.get("referrer-policy"), "no-referrer");
            assert.equal((yield* request("/.well-known/oauth-protected-resource")).status, 200);
            assert.equal((yield* request("/.well-known/oauth-protected-resource/mcp")).status, 200);
            assert.equal((yield* request("/.well-known/oauth-authorization-server")).status, 200);
            // Start with the real SDK's unauthenticated MCP request. Its challenge discovery
            // must carry the URL mode through registration, consent and token exchange.
            for (const mode of ["native", "browser"] as const) {
              const state: {
                client?: OAuthClientInformationMixed;
                tokens?: OAuthTokens;
                authorization?: URL;
                verifier?: string;
              } = {};
              const provider: OAuthClientProvider = {
                redirectUrl: "http://127.0.0.1:9999/callback",
                clientMetadata: {
                  client_name: `SDK ${mode} fixture`,
                  redirect_uris: ["http://127.0.0.1:9999/callback"],
                  token_endpoint_auth_method: "none",
                  grant_types: ["authorization_code", "refresh_token"],
                  response_types: ["code"],
                },
                clientInformation: () => state.client,
                saveClientInformation: (value) => {
                  state.client = value;
                },
                tokens: () => state.tokens,
                saveTokens: (value) => {
                  state.tokens = value;
                },
                redirectToAuthorization: (value) => {
                  state.authorization = value;
                },
                saveCodeVerifier: (value) => {
                  state.verifier = value;
                },
                codeVerifier: () => {
                  assert.ok(state.verifier);
                  return state.verifier;
                },
              };
              const discoveryTransport = new StreamableHTTPClientTransport(
                new URL(`${origin}/mcp?elicitation_mode=${mode}`),
                { authProvider: provider },
              );
              const discoveryClient = new Client({ name: "discovery-fixture", version: "1" });
              yield* Effect.addFinalizer(() => Effect.promise(() => discoveryClient.close()));
              const compatible: Omit<StreamableHTTPClientTransport, "sessionId"> =
                discoveryTransport;
              yield* Effect.promise(() =>
                assert.rejects(discoveryClient.connect(compatible), UnauthorizedError),
              );
              assert.ok(state.authorization);
              assert.equal(
                state.authorization.searchParams.get("resource"),
                `${origin}/mcp?elicitation_mode=${mode}`,
              );
              const authorization = yield* request(
                state.authorization.pathname + state.authorization.search,
                { headers: { cookie } },
              );
              assert.equal(authorization.status, 302);
              const consentUrl = new URL(authorization.headers.get("location") ?? "", origin);
              const approved = yield* json(
                yield* post(
                  "/api/auth/oauth2/consent",
                  {
                    accept: true,
                    oauth_query: consentUrl.search.slice(1),
                  },
                  { cookie, origin, "x-executor-organization": a.id },
                ),
                Redirect,
              );
              const code = new URL(approved.url).searchParams.get("code");
              assert.ok(code);
              yield* Effect.promise(() => discoveryTransport.finishAuth(code));
              assert.ok(state.tokens);
              const access = yield* Effect.promise(() =>
                auth.api.getMcpAccess({
                  headers: new Headers({ authorization: `Bearer ${state.tokens?.access_token}` }),
                }),
              );
              assert.deepEqual(access.grant.target, { kind: "mcp", mode });
              assert.deepEqual(access.grant.policy, { kind: "all" });
              // An organization-pathed URL must match the grant's organization.
              for (const [reference, status] of [
                [a.slug, 200],
                [b.slug, 403],
              ] as const) {
                const pathed = yield* Effect.promise(() =>
                  auth.api
                    .getMcpAccess({
                      headers: new Headers({
                        authorization: `Bearer ${state.tokens?.access_token}`,
                      }),
                      query: {
                        mode,
                        organization: Schema.decodeUnknownSync(OrganizationReference)(reference),
                      },
                      asResponse: true,
                    })
                    .then((response) => response.status),
                );
                assert.equal(pathed, status, `OAuth grant on /org/${reference}/mcp`);
              }
              assert.equal(
                (yield* request(`/org/${b.slug}/mcp?elicitation_mode=${mode}`, {
                  headers: { authorization: `Bearer ${state.tokens.access_token}` },
                })).status,
                403,
                "an organization-pathed URL for another organization",
              );
              const wrongMode = yield* request("/mcp", {
                headers: { authorization: `Bearer ${state.tokens.access_token}` },
              });
              assert.equal(wrongMode.status, 403, "a mode-bound token cannot switch to model mode");
            }
            const metadata = yield* json(
              yield* request("/.well-known/oauth-authorization-server/api/auth"),
              Schema.Struct({ issuer: Schema.String, registration_endpoint: Schema.String }),
            );
            assert.equal(metadata.issuer, `${origin}/api/auth`);
            const registered = yield* post("/api/auth/oauth2/register", {
              client_name: "Test client",
              redirect_uris: ["http://127.0.0.1:9999/callback"],
              token_endpoint_auth_method: "none",
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
            });
            assert.ok(registered.ok, yield* Effect.promise(() => registered.clone().text()));
            const { client_id } = yield* json(registered, Registered);
            const verifier = "synthetic-code-verifier-".repeat(3);
            const digest = yield* Effect.promise(() =>
              crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
            );
            const code_challenge = Buffer.from(digest).toString("base64url");
            const authorize = () =>
              request(
                `/api/auth/oauth2/authorize?${new URLSearchParams({
                  response_type: "code",
                  client_id,
                  redirect_uri: "http://127.0.0.1:9999/callback",
                  code_challenge,
                  code_challenge_method: "S256",
                  scope: "mcp offline_access",
                  resource: `${origin}/mcp`,
                  state: "synthetic-state",
                })}`,
                { headers: { cookie } },
              );
            const authorization = yield* authorize();
            assert.equal(authorization.status, 302);
            const consentUrl = new URL(authorization.headers.get("location") ?? "", origin);
            assert.equal(consentUrl.pathname, "/mcp/authorize");
            const query = consentUrl.search.slice(1);
            const choose = (organization: string, accept = true) =>
              post(
                "/api/auth/oauth2/consent",
                { accept, oauth_query: query },
                {
                  cookie,
                  origin,
                  "x-executor-organization": organization,
                  "x-executor-grant": JSON.stringify({ kind: "all" }),
                },
              );
            assert.equal((yield* choose("not-a-member")).status, 403);
            const denied = yield* json(yield* choose(a.id, false), Redirect);
            assert.equal(new URL(denied.url).searchParams.get("error"), "access_denied");
            const approved = yield* choose(a.id);
            assert.equal(
              approved.status,
              200,
              yield* Effect.promise(() => approved.clone().text()),
            );
            const approvedRedirect = yield* json(approved, Redirect);
            const code = new URL(approvedRedirect.url).searchParams.get("code");
            assert.ok(code);
            assert.equal(
              new URL(approvedRedirect.url).searchParams.get("state"),
              "synthetic-state",
            );
            const exchange = (fields: Record<string, string>) =>
              request("/api/auth/oauth2/token", {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams(fields),
              });
            const connectExecutor = (
              app: App,
              userCookie: string,
              organization: string,
              actor = user.id,
            ) =>
              Effect.gen(function* () {
                const profile = yield* executor.apps.profiles.create({
                  app: app.id,
                  owner: app.owner,
                  subject: actor,
                  idempotencyKey: "oauth-test",
                  accounts: {},
                });
                const connection = yield* Accounts.connectAccount(app.owner, {
                  profile: profile.id,
                  app: app.id,
                  requirement: "service",
                  destination: { kind: "shared", audience: { kind: "everyone" } },
                });
                const signIn = yield* executor.accountConnections
                  .startOAuth({
                    connection: connection.id,
                    method: "oauth",
                    label: "Default",
                    redirectUri: HttpUrl.make(`${origin}/api/oauth/callback`),
                  })
                  .pipe(
                    Effect.tapError((error) =>
                      Effect.logError("Executor OAuth setup", {
                        reason: "reason" in error ? error.reason : error.name,
                      }),
                    ),
                  );
                assert.ok(signIn.status === "redirect");
                const authorization = yield* request(
                  new URL(signIn.authorizationUrl).pathname +
                    new URL(signIn.authorizationUrl).search,
                  { headers: { cookie: userCookie } },
                );
                assert.equal(authorization.status, 302);
                const location = new URL(authorization.headers.get("location") ?? "", origin);
                const consent = yield* json(
                  yield* post(
                    "/api/auth/oauth2/consent",
                    { accept: true, oauth_query: location.search.slice(1) },
                    {
                      cookie: userCookie,
                      origin,
                      "x-executor-organization": organization,
                      "x-executor-grant": JSON.stringify({ kind: "all" }),
                    },
                  ),
                  Redirect,
                );
                const account = yield* Accounts.completeOAuth(app.owner, {
                  connection: connection.id,
                  callbackUrl: Redacted.make(HttpUrl.make(consent.url)),
                }).pipe(
                  Effect.tapError((error) =>
                    Effect.logError("Executor OAuth completion", {
                      reason: "reason" in error ? error.reason : error.name,
                    }),
                  ),
                );
                assert.equal(
                  (yield* executor.apps.profiles.get({ app: app.id, profile: profile.id })).accounts
                    .service,
                  account.id,
                );
                return account;
              }).pipe(
                Effect.provideService(CurrentUserId, actor),
                Effect.provideService(CurrentOrganization, {
                  organization: OrganizationId.make(organization),
                  owner: app.owner,
                  role: "owner",
                }),
                Effect.provideService(HostedExecutor, Effect.succeed(executor)),
                Effect.provideService(GroupDatabase, Effect.succeed(fixtureSql)),
              );
            const grantFor = (
              userCookie: string,
              organization: string,
              resource: string,
              scope: string,
              policy?: GrantPolicy,
            ) =>
              Effect.gen(function* () {
                const authorize = yield* request(
                  `/api/auth/oauth2/authorize?${new URLSearchParams({
                    response_type: "code",
                    client_id,
                    redirect_uri: "http://127.0.0.1:9999/callback",
                    code_challenge,
                    code_challenge_method: "S256",
                    scope,
                    resource,
                    state: "another-client",
                  })}`,
                  { headers: { cookie: userCookie } },
                );
                const location = new URL(authorize.headers.get("location") ?? "", origin);
                const consent = yield* json(
                  yield* post(
                    "/api/auth/oauth2/consent",
                    { accept: true, oauth_query: location.search.slice(1) },
                    {
                      cookie: userCookie,
                      origin,
                      "x-executor-organization": organization,
                      ...(policy === undefined
                        ? {}
                        : { "x-executor-grant": JSON.stringify(policy) }),
                    },
                  ),
                  Redirect,
                );
                const code = new URL(consent.url).searchParams.get("code");
                assert.ok(code);
                const response = yield* exchange({
                  grant_type: "authorization_code",
                  client_id,
                  code,
                  code_verifier: verifier,
                  redirect_uri: "http://127.0.0.1:9999/callback",
                  resource,
                });
                assert.equal(response.status, 200);
                return yield* json(
                  response,
                  Schema.Struct({
                    access_token: Schema.NonEmptyString,
                    refresh_token: Schema.optionalKey(Schema.NonEmptyString),
                  }),
                );
              });
            // Wrong PKCE must not redeem the authorization code.
            const badPkce = yield* exchange({
              grant_type: "authorization_code",
              client_id,
              code,
              code_verifier: "wrong",
              redirect_uri: "http://127.0.0.1:9999/callback",
              resource: `${origin}/mcp`,
            });
            // Better Auth reports a rejected PKCE verifier as 401 invalid_request.
            assert.equal(badPkce.status, 401);
            assert.deepEqual(yield* Effect.promise(() => badPkce.json()), {
              error: "invalid_request",
              error_description: "code verification failed",
            });
            // Use a fresh authorization after the rejected exchange; codes are one-use.
            const again = new URL((yield* authorize()).headers.get("location") ?? "", origin);
            const retry = yield* json(
              yield* post(
                "/api/auth/oauth2/consent",
                { accept: true, oauth_query: again.search.slice(1) },
                {
                  cookie,
                  origin,
                  "x-executor-organization": a.id,
                  "x-executor-grant": JSON.stringify({ kind: "all" }),
                },
              ),
              Redirect,
            );
            const retryCode = new URL(retry.url).searchParams.get("code");
            assert.ok(retryCode);
            const tokenResponse = yield* exchange({
              grant_type: "authorization_code",
              client_id,
              code: retryCode,
              code_verifier: verifier,
              redirect_uri: "http://127.0.0.1:9999/callback",
              resource: `${origin}/mcp`,
            });
            assert.equal(
              tokenResponse.status,
              200,
              yield* Effect.promise(() => tokenResponse.clone().text()),
            );
            const tokens = yield* json(tokenResponse, Tokens);
            const executorAccount = yield* connectExecutor(executorA, cookie, a.id);
            yield* Effect.promise(() =>
              auth.api.setActiveOrganization({
                headers: new Headers({ cookie, origin }),
                body: { organizationId: b.id },
              }),
            );
            const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
              requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
            });
            const client = new Client({ name: "executor-hosted-test", version: "1" });
            yield* Effect.addFinalizer(() => Effect.promise(() => client.close()));
            const compatible: Omit<StreamableHTTPClientTransport, "sessionId"> = transport;
            yield* Effect.promise(() => client.connect(compatible));
            assert.deepEqual(
              (yield* Effect.promise(() => client.listTools())).tools
                .map((tool) => tool.name)
                .sort(),
              ["execute", "resume", "skills"],
            );
            const execute = (code: string) =>
              Effect.promise(() => client.callTool({ name: "execute", arguments: { code } })).pipe(
                Effect.flatMap((result) =>
                  Schema.decodeUnknownEffect(ExecuteResult)(result.structuredContent),
                ),
              );
            const found = yield* execute("return await tools.search({limit: 100})");
            assert.equal(found.execution.ok, true, JSON.stringify(found));
            assert.ok(JSON.stringify(found).includes(alpha.app.slug));
            assert.ok(!JSON.stringify(found).includes("Beta app"));
            assert.equal(
              (yield* execute(
                `return await tools[${JSON.stringify(alpha.app.slug)}].mutations.hello({})`,
              )).execution.ok,
              true,
            );
            // Executor is a persisted ordinary app, using its separately connected OAuth account.
            const management = yield* execute(
              `return await tools.search({query: "Executor", namespace: ${JSON.stringify(executorA.slug)}, limit: 100})`,
            );
            assert.equal(management.execution.ok, true, JSON.stringify(management));
            assert.ok(
              JSON.stringify(management).includes("apps_deploy"),
              JSON.stringify(management),
            );
            // The complete published API includes credential submission (34470f10).
            assert.ok(
              JSON.stringify(management).includes("accounts_submit"),
              JSON.stringify(management),
            );
            const connectedContext = yield* execute(
              `return await tools[${JSON.stringify(executorA.slug)}].queries.context_get({})`,
            );
            assert.equal(connectedContext.execution.ok, true, JSON.stringify(connectedContext));
            if (!connectedContext.execution.ok)
              throw new Error("Connected context was unavailable");
            assert.equal(
              Schema.decodeUnknownSync(Schema.Struct({ organization: Schema.String }))(
                connectedContext.execution.value,
              ).organization,
              a.id,
            );
            const inventory = yield* execute(
              `return await tools[${JSON.stringify(executorA.slug)}].queries.organization_inventory({path: {organization: ${JSON.stringify(a.id)}}})`,
            );
            assert.equal(inventory.execution.ok, true, JSON.stringify(inventory));
            assert.ok(JSON.stringify(inventory).includes("Alpha app"));
            assert.ok(!JSON.stringify(inventory).includes("Beta app"));
            assert.equal(
              (yield* execute(
                `return await tools[${JSON.stringify(executorA.slug)}].queries.organization_inventory({path: {organization: ${JSON.stringify(b.id)}}})`,
              )).execution.ok,
              false,
            );
            const deployed = yield* execute(
              `return await tools[${JSON.stringify(executorA.slug)}].mutations.apps_deploy({path: {organization: ${JSON.stringify(a.id)}}, body: {name: "From MCP", files: [{path: "index.ts", content: ${JSON.stringify(source)}}]}})`,
            );
            assert.equal(deployed.execution.ok, true, JSON.stringify(deployed));
            assert.ok(
              (yield* executor.apps.list({ owner: OwnerId.make(`organization:${a.id}`) })).some(
                (app) => app.name === "From MCP",
              ),
            );
            assert.ok(
              !(yield* executor.apps.list({ owner: OwnerId.make(`organization:${b.id}`) })).some(
                (app) => app.name === "From MCP",
              ),
            );
            // A real MCP client reads source, deploys an edit and activates a retained version.
            if (!deployed.execution.ok) throw new Error("MCP deployment failed");
            const configured = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ id: Schema.String, activeDeployment: Schema.String }),
            )(deployed.execution.value);
            const appPath = JSON.stringify({ organization: a.id, app: configured.id });
            const updatedSource = source + "\n// Updated through MCP\n";
            const edited = yield* execute(
              `const path = ${appPath}; const api = tools[${JSON.stringify(executorA.slug)}]; const before = await api.queries.appManagement_source({path}); const saved = await api.mutations.appManagement_commit({path, body: {expected: before.revision.commit, message: "MCP edit", files: [{path: "index.ts", content: ${JSON.stringify(updatedSource)}}]}}); return (await api.mutations.appManagement_deploy({path, body: {commit: saved.revision.commit}})).app`,
            );
            assert.equal(edited.execution.ok, true, JSON.stringify(edited));
            if (!edited.execution.ok) throw new Error("MCP update failed");
            const next = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ id: Schema.String, activeDeployment: Schema.String }),
            )(edited.execution.value);
            assert.equal(next.id, configured.id);
            assert.notEqual(next.activeDeployment, configured.activeDeployment);
            const versions = yield* execute(
              `return await tools[${JSON.stringify(executorA.slug)}].queries.apps_deployments({path: ${appPath}})`,
            );
            assert.equal(versions.execution.ok, true, JSON.stringify(versions));
            if (!versions.execution.ok) throw new Error("MCP history failed");
            assert.equal(
              (yield* Schema.decodeUnknownEffect(
                Schema.Array(Schema.Struct({ id: Schema.String })),
              )(versions.execution.value)).length,
              2,
            );
            const activated = yield* execute(
              `return await tools[${JSON.stringify(executorA.slug)}].mutations.apps_activate({path: ${appPath}, body: {deployment: ${JSON.stringify(configured.activeDeployment)}, expectedDeployment: ${JSON.stringify(next.activeDeployment)}}})`,
            );
            assert.equal(activated.execution.ok, true, JSON.stringify(activated));
            if (!activated.execution.ok) throw new Error("MCP activation failed");
            assert.equal(
              (yield* Schema.decodeUnknownEffect(
                Schema.Struct({ activeDeployment: Schema.String }),
              )(activated.execution.value)).activeDeployment,
              configured.activeDeployment,
            );

            assert.equal(
              (yield* request(`/api/organizations/${a.id}/inventory`, {
                headers: { authorization: `Bearer ${tokens.access_token}` },
              })).status,
              401,
            );
            assert.equal(
              (yield* request(`/api/organizations/${b.id}/inventory`, {
                headers: { authorization: `Bearer ${tokens.access_token}`, cookie },
              })).status,
              401,
            );
            assert.equal(
              (yield* request(`/api/organizations/${a.id}/inventory`, {
                headers: { authorization: "Bearer invalid", cookie },
              })).status,
              401,
            );
            assert.equal(
              (yield* request("/api/viewer", {
                headers: { authorization: `Bearer ${tokens.access_token}` },
              })).status,
              401,
            );
            const apiMetadata = yield* json(
              yield* request("/.well-known/oauth-protected-resource/api"),
              Schema.Struct({ resource: Schema.String }),
            );
            assert.equal(apiMetadata.resource, `${origin}/api`);
            assert.match(
              (yield* request("/api")).headers.get("www-authenticate") ?? "",
              /oauth-protected-resource\/api/,
            );
            const apiGrant = yield* grantFor(
              cookie,
              a.id,
              `${origin}/api`,
              "executor offline_access",
            );
            assert.equal(
              (yield* request(`/api/organizations/${a.id}/inventory`, {
                headers: { authorization: `Bearer ${apiGrant.access_token}` },
              })).status,
              200,
            );
            assert.equal(
              (yield* request("/mcp", {
                headers: { authorization: `Bearer ${apiGrant.access_token}` },
              })).status,
              401,
            );
            const noScope = yield* grantFor(cookie, a.id, `${origin}/api`, "offline_access");
            assert.equal(
              (yield* request(`/api/organizations/${a.id}/inventory`, {
                headers: { authorization: `Bearer ${noScope.access_token}` },
              })).status,
              401,
            );
            // A second caller cannot inherit the first caller's grant, even with the same client ID.
            const other = yield* Effect.promise(() =>
              context.internalAdapter.createUser(
                { name: "Other", email: "other@example.test", emailVerified: true },
                { method: "admin" },
              ),
            );
            yield* Effect.promise(() =>
              auth.api.addMember({
                body: { organizationId: b.id, userId: other.id, role: "owner" },
              }),
            );
            const otherSession = yield* Effect.promise(() =>
              context.internalAdapter.createSession(other.id),
            );
            const otherSignature = yield* Effect.promise(() =>
              makeSignature(otherSession.token, secret),
            );
            const otherCookie = `executor-hosted.session_token=${encodeURIComponent(`${otherSession.token}.${otherSignature}`)}`;
            const otherExecutorAccount = yield* connectExecutor(
              executorB,
              otherCookie,
              b.id,
              other.id,
            );
            const otherGrant = yield* grantFor(
              otherCookie,
              b.id,
              `${origin}/mcp`,
              "mcp offline_access",
            );
            const otherClient = new Client({ name: "second-caller", version: "1" });
            yield* Effect.addFinalizer(() => Effect.promise(() => otherClient.close()));
            const otherTransport: Omit<StreamableHTTPClientTransport, "sessionId"> =
              new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
                requestInit: { headers: { authorization: `Bearer ${otherGrant.access_token}` } },
              });
            yield* Effect.promise(() => otherClient.connect(otherTransport));
            const otherInventory = yield* Effect.promise(() =>
              otherClient.callTool({
                name: "execute",
                arguments: {
                  code: `return await tools[${JSON.stringify(executorB.slug)}].queries.organization_inventory({path:{organization:${JSON.stringify(b.id)}}})`,
                },
              }),
            ).pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(ExecuteResult)(result.structuredContent),
              ),
            );
            assert.equal(otherInventory.execution.ok, true, JSON.stringify(otherInventory));
            assert.ok(JSON.stringify(otherInventory).includes("Beta app"));
            assert.ok(!JSON.stringify(otherInventory).includes("Alpha app"));
            assert.equal(
              (yield* execute(
                `return await tools[${JSON.stringify(executorA.slug)}].queries.organization_inventory({path:{organization:${JSON.stringify(a.id)}}})`,
              )).execution.ok,
              true,
            );
            // Each ordinary app selects its own persisted account, independently of the MCP login.
            assert.deepEqual(
              (yield* executor.accounts.list({ owner: OwnerId.make(`organization:${a.id}`) })).map(
                (account) => account.id,
              ),
              [executorAccount.id],
            );
            assert.deepEqual(
              (yield* executor.accounts.list({ owner: OwnerId.make(`organization:${b.id}`) })).map(
                (account) => account.id,
              ),
              [otherExecutorAccount.id],
            );
            const secured = yield* fixtureDeploy({
              owner: OwnerId.make(`organization:${a.id}`),
              name: "Needs an account",
              files: [
                {
                  path: "index.ts",
                  content: `import { query, mutation, defineApp, defineProvider, secrets, object, string } from "apps";
const service = defineProvider({ name: "Fixture service", auth: { key: secrets({ label: "Token", fields: object({ token: string() }) }) } });
export default defineApp({ accounts: { service } }, async (appContext) => ({  }));
`,
                },
              ],
            });
            const connection = yield* execute(
              `return await tools[${JSON.stringify(executorA.slug)}].mutations.accounts_connect({path:{organization:${JSON.stringify(a.id)},app:${JSON.stringify(secured.app.id)}},body:{requirement:"service"}})`,
            );
            assert.equal(connection.execution.ok, true, JSON.stringify(connection));
            if (!connection.execution.ok) throw new Error("Account connection failed");
            const linked = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ id: Schema.String, url: Schema.String }),
            )(connection.execution.value);
            assert.equal(linked.url, `${origin}/org/alpha/connections/${linked.id}`);
            assert.ok(!JSON.stringify(connection.execution.value).includes(tokens.access_token));
            assert.equal(
              (yield* execute(
                `return await tools[${JSON.stringify(executorA.slug)}].queries.accounts_connection({path:{organization:${JSON.stringify(a.id)},connection:${JSON.stringify(linked.id)}}})`,
              )).execution.ok,
              true,
            );
            assert.equal(
              (yield* request("/api/viewer", {
                headers: { authorization: `Bearer ${tokens.access_token}`, cookie },
              })).status,
              401,
            );
            assert.equal(
              (yield* request(`/api/organizations/${a.id}/inventory`, {
                headers: {
                  authorization: `Bearer ${tokens.access_token}`,
                  origin: "https://untrusted.example",
                },
              })).status,
              403,
            );
            const approvalApp = yield* fixtureDeploy({
              owner: OwnerId.make(`organization:${a.id}`),
              name: "Approval role check",
              files: [
                {
                  path: "index.ts",
                  content: `import { query, mutation, defineApp, object } from "apps";
import { always } from "apps/operations/approval";
let writes = 0;
export default defineApp({ accounts: {} }, async (appContext) => ({  mutations: { write: mutation({ description: "Write",
            input: object({}),
            approval: always() }, async (operationContext, _input) => {
            return ++writes;
        }),
        ask: mutation({ description: "Ask then write",
            input: object({}) }, async (operationContext, _input) => {
            const { elicit } = { ...appContext, ...operationContext };
            await elicit({ mode: "form", message: "Tool question", requestedSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } });
            return ++writes;
        }),
        count: mutation({ description: "Count",
            input: object({}) }, async (operationContext, _input) => {
            return writes;
        }) } }));
`,
                },
              ],
            });

            // Restricted grants share the OAuth client but never each other's authority or continuation.
            const selection: GrantPolicy = {
              kind: "tools",
              approval: "client",
              apps: [
                {
                  app: approvalApp.app.id,
                  tools: { kind: "selected", names: [ToolName.make("mutations.count")] },
                },
              ],
            };
            const limitedTokens = yield* grantFor(
              cookie,
              a.id,
              `${origin}/mcp`,
              "mcp offline_access",
              selection,
            );
            const limitedHeaders = { authorization: `Bearer ${limitedTokens.access_token}` };
            const limitedAccess = yield* Effect.promise(() =>
              auth.api.getMcpAccess({ headers: new Headers(limitedHeaders) }),
            );
            const limitedClient = new Client({ name: "limited", version: "1" });
            yield* Effect.addFinalizer(() => Effect.promise(() => limitedClient.close()));
            const limitedTransport: Omit<StreamableHTTPClientTransport, "sessionId"> =
              new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
                requestInit: { headers: limitedHeaders },
              });
            yield* Effect.promise(() => limitedClient.connect(limitedTransport));
            const scopedExecute = (mcp: Client, code: string) =>
              Effect.promise(() => mcp.callTool({ name: "execute", arguments: { code } })).pipe(
                Effect.flatMap((wire) =>
                  Schema.decodeUnknownEffect(McpExecutionResult)(wire.structuredContent),
                ),
              );
            const visible = yield* scopedExecute(
              limitedClient,
              "return await tools.search({limit:100})",
            );
            assert.ok(JSON.stringify(visible).includes("count"));
            assert.ok(!JSON.stringify(visible).includes(executorA.id));
            assert.ok(!JSON.stringify(visible).includes('"write"'));
            assert.equal(
              (yield* request(`/api/organizations/${a.id}/inventory`, { headers: limitedHeaders }))
                .status,
              401,
            );
            const forbidden = yield* scopedExecute(
              limitedClient,
              `return await tools[${JSON.stringify(approvalApp.app.slug)}].mutations.write({});`,
            );
            assert.ok(forbidden.status === "completed" && !forbidden.execution.ok);
            const allowed = yield* scopedExecute(
              limitedClient,
              `return await tools[${JSON.stringify(approvalApp.app.slug)}].mutations.count({});`,
            );
            assert.ok(
              allowed.status === "completed" &&
                allowed.execution.ok &&
                allowed.execution.value === 0,
            );
            // Executor is selected by its ordinary configured-app ID, like any other app.
            const executorTokens = yield* grantFor(
              cookie,
              a.id,
              `${origin}/mcp`,
              "mcp offline_access",
              {
                kind: "tools",
                approval: "client",
                apps: [
                  {
                    app: executorA.id,
                    tools: { kind: "selected", names: [ToolName.make("queries.context_get")] },
                  },
                ],
              },
            );
            const executorClient = new Client({ name: "ordinary-executor-app", version: "1" });
            yield* Effect.addFinalizer(() => Effect.promise(() => executorClient.close()));
            const executorTransport: Omit<StreamableHTTPClientTransport, "sessionId"> =
              new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
                requestInit: {
                  headers: { authorization: `Bearer ${executorTokens.access_token}` },
                },
              });
            yield* Effect.promise(() => executorClient.connect(executorTransport));
            const executorResult = yield* scopedExecute(
              executorClient,
              `return await tools[${JSON.stringify(executorA.slug)}].queries.context_get({});`,
            );
            assert.ok(executorResult.status === "completed" && executorResult.execution.ok);
            const writerPolicy: GrantPolicy = {
              kind: "tools",
              approval: "client",
              apps: [{ app: approvalApp.app.id, tools: { kind: "all" } }],
            };
            const writerTokens = yield* grantFor(
              cookie,
              a.id,
              `${origin}/mcp`,
              "mcp offline_access",
              writerPolicy,
            );
            const writerHeaders = { authorization: `Bearer ${writerTokens.access_token}` };
            const writerAccess = yield* Effect.promise(() =>
              auth.api.getMcpAccess({ headers: new Headers(writerHeaders) }),
            );
            assert.notEqual(writerAccess.grant.id, limitedAccess.grant.id);
            const writerClient = new Client({ name: "writer", version: "1" });
            yield* Effect.addFinalizer(() => Effect.promise(() => writerClient.close()));
            const writerTransport: Omit<StreamableHTTPClientTransport, "sessionId"> =
              new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
                requestInit: { headers: writerHeaders },
              });
            yield* Effect.promise(() => writerClient.connect(writerTransport));
            const waiting = yield* scopedExecute(
              writerClient,
              `return await tools[${JSON.stringify(approvalApp.app.slug)}].mutations.write({});`,
            );
            if (waiting.status !== "approval-required")
              throw new Error("Expected restricted writer approval");
            const crossed = yield* Effect.promise(() =>
              limitedClient.callTool({
                name: "resume",
                arguments: { requestId: waiting.requestId, response: { action: "accept" } },
              }),
            );
            assert.equal(
              Schema.decodeUnknownSync(Schema.Struct({ status: Schema.String }))(
                crossed.structuredContent,
              ).status,
              "unavailable",
            );
            assert.equal(
              (yield* post(
                "/api/auth/mcp/grants/narrow",
                { id: writerAccess.grant.id, policy: selection },
                { cookie, origin },
              )).status,
              200,
            );
            const narrowed = yield* Effect.promise(() =>
              writerClient.callTool({
                name: "resume",
                arguments: { requestId: waiting.requestId, response: { action: "accept" } },
              }),
            );
            const narrowedResult = Schema.decodeUnknownSync(McpExecutionResult)(
              narrowed.structuredContent,
            );
            assert.ok(narrowedResult.status === "completed" && !narrowedResult.execution.ok);
            assert.equal(
              (yield* post(
                "/api/auth/mcp/grants/narrow",
                { id: writerAccess.grant.id, policy: writerPolicy },
                { cookie, origin },
              )).status,
              403,
            );
            assert.ok(limitedTokens.refresh_token);
            const refreshedLimited = yield* json(
              yield* exchange({
                grant_type: "refresh_token",
                client_id,
                refresh_token: limitedTokens.refresh_token,
                resource: `${origin}/mcp`,
              }),
              Tokens,
            );
            const afterRefresh = yield* Effect.promise(() =>
              auth.api.getMcpAccess({
                headers: new Headers({ authorization: `Bearer ${refreshedLimited.access_token}` }),
              }),
            );
            assert.equal(afterRefresh.grant.id, limitedAccess.grant.id);
            assert.deepEqual(afterRefresh.grant.policy, selection);
            assert.equal(
              (yield* post(
                "/api/auth/mcp/grants/revoke",
                { id: limitedAccess.grant.id },
                limitedHeaders,
              )).status,
              403,
            );
            assert.equal(
              (yield* post(
                "/api/auth/mcp/grants/revoke",
                { id: limitedAccess.grant.id },
                { cookie, origin },
              )).status,
              200,
            );
            assert.equal(
              (yield* request("/mcp", {
                headers: { authorization: `Bearer ${refreshedLimited.access_token}` },
              })).status,
              401,
            );
            const browserOnly = yield* grantFor(
              cookie,
              a.id,
              `${origin}/mcp?elicitation_mode=browser`,
              "mcp offline_access",
              { ...writerPolicy, approval: "browser" },
            );
            for (const mode of ["", "?elicitation_mode=model", "?elicitation_mode=native"])
              assert.equal(
                (yield* request(`/mcp${mode}`, {
                  headers: { authorization: `Bearer ${browserOnly.access_token}` },
                })).status,
                403,
              );
            const browserClient = new Client({ name: "browser-review", version: "1" });
            yield* Effect.addFinalizer(() => Effect.promise(() => browserClient.close()));
            const browserTransport: Omit<StreamableHTTPClientTransport, "sessionId"> =
              new StreamableHTTPClientTransport(new URL(`${origin}/mcp?elicitation_mode=browser`), {
                requestInit: { headers: { authorization: `Bearer ${browserOnly.access_token}` } },
              });
            yield* Effect.promise(() => browserClient.connect(browserTransport));
            const browserPending = yield* Effect.promise(() =>
              browserClient.callTool({
                name: "execute",
                arguments: {
                  code: `return await tools[${JSON.stringify(approvalApp.app.slug)}].mutations.write({});`,
                },
              }),
            ).pipe(
              Effect.flatMap((wire) =>
                Schema.decodeUnknownEffect(BrowserExecutionResult)(wire.structuredContent),
              ),
            );
            if (browserPending.status !== "approval-required")
              throw new Error("Expected browser approval");
            const approvalUrl = new URL(browserPending.approvalUrl);
            assert.equal(approvalUrl.origin, origin);
            const approvalPath = `/api/mcp/approvals/${browserPending.requestId}${approvalUrl.search}`;
            assert.equal((yield* request(approvalPath)).status, 401);
            assert.equal(
              (yield* request(approvalPath, {
                headers: { authorization: `Bearer ${tokens.access_token}`, cookie },
              })).status,
              403,
            );
            assert.equal(
              (yield* request(approvalPath, {
                headers: { cookie, origin: "https://wrong.example" },
              })).status,
              403,
            );
            const preview = yield* request(approvalPath, { headers: { cookie } });
            assert.equal(preview.status, 200);
            assert.equal(preview.headers.get("cache-control"), "no-store");
            assert.equal(
              Schema.decodeUnknownSync(Schema.Struct({ status: Schema.String }))(
                yield* Effect.promise(() => preview.json()),
              ).status,
              "pending",
            );
            yield* Effect.promise(() =>
              auth.api.addMember({
                body: { organizationId: a.id, userId: other.id, role: "owner" },
              }),
            );
            const wrongUser = yield* request(approvalPath, { headers: { cookie: otherCookie } });
            assert.equal(wrongUser.status, 403);
            const approvalSql = yield* SqlClient.SqlClient;
            yield* approvalSql`delete from "member" where "organizationId" = ${a.id} and "userId" = ${other.id}`;
            yield* approvalSql`update hosted_app_access set audience = 'groups' where organization_id = ${a.id}`;
            assert.equal(
              (yield* request(approvalPath, {
                method: "POST",
                headers: { cookie, origin, "content-type": "application/json" },
                body: JSON.stringify({ response: { action: "accept" } }),
              })).status,
              403,
            );
            yield* approvalSql`update hosted_app_access set audience = 'everyone' where organization_id = ${a.id}`;
            assert.equal(
              (yield* request(approvalPath, {
                method: "POST",
                headers: { cookie, origin, "content-type": "application/json" },
                body: JSON.stringify({ response: { action: "decline" } }),
              })).status,
              200,
            );
            const browserDenied = yield* Effect.promise(() =>
              browserClient.callTool({
                name: "resume",
                arguments: { requestId: browserPending.requestId },
              }),
            ).pipe(
              Effect.flatMap((wire) =>
                Schema.decodeUnknownEffect(BrowserExecutionResult)(wire.structuredContent),
              ),
            );
            assert.ok(browserDenied.status === "completed" && !browserDenied.execution.ok);
            assert.equal(browserDenied.execution.error.message, "ApprovalDenied");
            assert.deepEqual(
              yield* executor.tools.call({
                app: approvalApp.app.id,
                tool: ToolName.make("mutations.count"),
              }),
              { status: "completed", value: 0 },
            );

            const pausedWire = yield* Effect.promise(() =>
              client.callTool({
                name: "execute",
                arguments: {
                  code: `const value = await tools[${JSON.stringify(approvalApp.app.slug)}].mutations.write({}); return value + 10;`,
                },
              }),
            );
            const paused = yield* Schema.decodeUnknownEffect(McpExecutionResult)(
              pausedWire.structuredContent,
            );
            assert.equal(paused.status, "approval-required");
            if (paused.status !== "approval-required") throw new Error("Expected pending approval");
            const sql = yield* SqlClient.SqlClient;
            // Native approval waits inside one HTTP request. Its initial authority must
            // not survive a role change while the actual MCP prompt is open.
            const nativeTokens = yield* grantFor(
              cookie,
              a.id,
              `${origin}/mcp?elicitation_mode=native`,
              "mcp offline_access",
            );
            const nativeAccess = yield* Effect.promise(() =>
              auth.api.getMcpAccess({
                headers: new Headers({ authorization: `Bearer ${nativeTokens.access_token}` }),
              }),
            );
            assert.deepEqual(nativeAccess.grant.policy, { kind: "all" });
            assert.deepEqual(nativeAccess.grant.target, { kind: "mcp", mode: "native" });
            assert.ok(nativeTokens.refresh_token);
            assert.equal(
              (yield* exchange({
                grant_type: "refresh_token",
                client_id,
                refresh_token: nativeTokens.refresh_token,
                resource: `${origin}/mcp`,
              })).status,
              400,
              "refresh cannot replace the approved native resource with model mode",
            );
            const nativeClient = new Client(
              { name: "native-role-check", version: "1" },
              { capabilities: { elicitation: { form: {} } } },
            );
            yield* Effect.addFinalizer(() => Effect.promise(() => nativeClient.close()));
            const nativeTransport = new StreamableHTTPClientTransport(
              new URL(`${origin}/mcp?elicitation_mode=native`),
              {
                requestInit: { headers: { authorization: `Bearer ${nativeTokens.access_token}` } },
              },
            );
            const nativeCompatible: Omit<StreamableHTTPClientTransport, "sessionId"> =
              nativeTransport;
            yield* Effect.promise(() => nativeClient.connect(nativeCompatible));
            assert.deepEqual(
              (yield* Effect.promise(() => nativeClient.listTools())).tools
                .map((tool) => tool.name)
                .sort(),
              ["execute", "skills"],
            );
            nativeClient.setRequestHandler(ElicitRequestSchema, async () => {
              await Effect.runPromise(
                sql`update hosted_app_access set audience = 'groups' where organization_id = ${a.id}`,
              );
              return { action: "accept", content: {} };
            });
            const nativeDenied = yield* Effect.promise(() =>
              nativeClient.callTool({
                name: "execute",
                arguments: {
                  code: `return await tools[${JSON.stringify(approvalApp.app.slug)}].mutations.write({});`,
                },
              }),
            ).pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(McpExecutionResult)(result.structuredContent),
              ),
            );
            assert.equal(nativeDenied.status, "completed");
            if (nativeDenied.status !== "completed" || nativeDenied.execution.ok)
              throw new Error("Native approval bypassed demotion");
            assert.equal(nativeDenied.execution.error.message, "OrganizationForbidden");
            assert.deepEqual(
              yield* executor.tools.call({
                app: approvalApp.app.id,
                tool: ToolName.make("mutations.count"),
              }),
              { status: "completed", value: 0 },
            );
            yield* sql`update hosted_app_access set audience = 'everyone' where organization_id = ${a.id}`;
            nativeClient.setRequestHandler(ElicitRequestSchema, async () => ({
              action: "accept",
              content: {},
            }));
            const nativeAccepted = yield* Effect.promise(() =>
              nativeClient.callTool({
                name: "execute",
                arguments: {
                  code: `const value = await tools[${JSON.stringify(approvalApp.app.slug)}].mutations.write({}); return value + 10;`,
                },
              }),
            ).pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(McpExecutionResult)(result.structuredContent),
              ),
            );
            assert.equal(nativeAccepted.status, "completed");
            if (nativeAccepted.status !== "completed" || !nativeAccepted.execution.ok)
              throw new Error("Native approval did not complete");
            assert.equal(nativeAccepted.execution.value, 11);

            let toolQuestioned = false;
            nativeClient.setRequestHandler(ElicitRequestSchema, async ({ params }) => {
              assert.equal(params.message, "Tool question");
              toolQuestioned = true;
              await Effect.runPromise(
                sql`update hosted_app_access set audience = 'groups' where organization_id = ${a.id}`,
              );
              return { action: "accept", content: { answer: "must not reach the tool" } };
            });
            const toolDenied = yield* Effect.promise(() =>
              nativeClient.callTool({
                name: "execute",
                arguments: {
                  code: `return await tools[${JSON.stringify(approvalApp.app.slug)}].mutations.ask({});`,
                },
              }),
            ).pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(McpExecutionResult)(result.structuredContent),
              ),
            );
            assert.equal(toolQuestioned, true);
            assert.ok(toolDenied.status === "completed" && !toolDenied.execution.ok);
            assert.equal(toolDenied.execution.error.message, "ToolElicitationFailed");
            assert.deepEqual(
              yield* executor.tools.call({
                app: approvalApp.app.id,
                tool: ToolName.make("mutations.count"),
              }),
              { status: "completed", value: 1 },
            );
            yield* sql`update hosted_app_access set audience = 'everyone' where organization_id = ${a.id}`;

            // Model-mode questions cross HTTP requests and must use the answering request's role.
            const modelQuestion = yield* Effect.promise(() =>
              client.callTool({
                name: "execute",
                arguments: {
                  code: `return await tools[${JSON.stringify(approvalApp.app.slug)}].mutations.ask({});`,
                },
              }),
            ).pipe(
              Effect.flatMap((wire) =>
                Schema.decodeUnknownEffect(McpExecutionResult)(wire.structuredContent),
              ),
            );
            if (modelQuestion.status !== "input-required")
              throw new Error("Expected model-mode tool input");
            yield* sql`update hosted_app_access set audience = 'groups' where organization_id = ${a.id}`;
            const modelDenied = yield* Effect.promise(() =>
              client.callTool({
                name: "resume",
                arguments: {
                  requestId: modelQuestion.requestId,
                  response: { action: "accept", content: { answer: "must not reach the tool" } },
                },
              }),
            ).pipe(
              Effect.flatMap((wire) =>
                Schema.decodeUnknownEffect(McpExecutionResult)(wire.structuredContent),
              ),
            );
            assert.ok(
              modelDenied.status === "completed" && !modelDenied.execution.ok,
              JSON.stringify(modelDenied),
            );
            assert.equal(modelDenied.execution.error.message, "ToolElicitationFailed");
            assert.deepEqual(
              yield* executor.tools.call({
                app: approvalApp.app.id,
                tool: ToolName.make("mutations.count"),
              }),
              { status: "completed", value: 1 },
            );
            yield* sql`update hosted_app_access set audience = 'everyone' where organization_id = ${a.id}`;

            // Revoking a separate grant during a native prompt must also stop dispatch.
            const nativeGrant = yield* grantFor(
              cookie,
              a.id,
              `${origin}/mcp?elicitation_mode=native`,
              "mcp",
            );
            const revokedClient = new Client(
              { name: "native-revocation-check", version: "1" },
              { capabilities: { elicitation: { form: {} } } },
            );
            yield* Effect.addFinalizer(() => Effect.promise(() => revokedClient.close()));
            const revokedTransport = new StreamableHTTPClientTransport(
              new URL(`${origin}/mcp?elicitation_mode=native`),
              {
                requestInit: { headers: { authorization: `Bearer ${nativeGrant.access_token}` } },
              },
            );
            const revokedCompatible: Omit<StreamableHTTPClientTransport, "sessionId"> =
              revokedTransport;
            yield* Effect.promise(() => revokedClient.connect(revokedCompatible));
            let revocationPrompted = false;
            revokedClient.setRequestHandler(ElicitRequestSchema, async () => {
              revocationPrompted = true;
              const revoked = await Effect.runPromise(
                request("/api/auth/oauth2/revoke", {
                  method: "POST",
                  headers: { "content-type": "application/x-www-form-urlencoded" },
                  body: new URLSearchParams({ client_id, token: nativeGrant.access_token }),
                }),
              );
              assert.equal(revoked.status, 200);
              return { action: "accept", content: {} };
            });
            // The answer's HTTP POST must authenticate too: a revoked grant may be
            // refused at transport admission before the active execute sees its answer.
            const revokedCall = yield* Effect.promise(() =>
              revokedClient
                .callTool(
                  {
                    name: "execute",
                    arguments: {
                      code: `return await tools[${JSON.stringify(approvalApp.app.slug)}].mutations.write({});`,
                    },
                  },
                  undefined,
                  { timeout: 1000 },
                )
                .then(
                  (result) => ({ kind: "result" as const, result }),
                  (error: unknown) => ({ kind: "transport-rejected" as const, error }),
                ),
            );
            assert.equal(revocationPrompted, true);
            if (revokedCall.kind === "transport-rejected") {
              const error = Schema.decodeUnknownSync(Schema.Struct({ code: Schema.Number }))(
                revokedCall.error,
              );
              assert.ok(
                error.code === 401 || error.code === -32001,
                "Only revoked-token rejection or the unanswered request timeout is expected",
              );
            } else {
              const result = yield* Schema.decodeUnknownEffect(McpExecutionResult)(
                revokedCall.result.structuredContent,
              );
              assert.equal(result.status, "completed");
              if (result.status !== "completed" || result.execution.ok)
                throw new Error("Native approval bypassed revocation");
              assert.equal(result.execution.error.message, "McpUnauthorized");
            }
            assert.equal(
              (yield* request("/mcp", {
                headers: { authorization: `Bearer ${nativeGrant.access_token}` },
              })).status,
              401,
            );
            assert.deepEqual(
              yield* executor.tools.call({
                app: approvalApp.app.id,
                tool: ToolName.make("mutations.count"),
              }),
              { status: "completed", value: 1 },
            );
            yield* sql`update hosted_app_access set audience = 'groups' where organization_id = ${a.id}`;
            const resumedWire = yield* Effect.promise(() =>
              client.callTool({
                name: "resume",
                arguments: { requestId: paused.requestId, response: { action: "accept" } },
              }),
            );
            const resumed = yield* Schema.decodeUnknownEffect(McpExecutionResult)(
              resumedWire.structuredContent,
            );
            assert.equal(resumed.status, "completed");
            if (resumed.status === "completed") {
              assert.equal(resumed.execution.ok, false);
              if (!resumed.execution.ok)
                assert.equal(resumed.execution.error.message, "OrganizationForbidden");
            }
            assert.deepEqual(
              yield* executor.tools.call({
                app: approvalApp.app.id,
                tool: ToolName.make("mutations.count"),
              }),
              { status: "completed", value: 1 },
            );
            assert.equal(
              (yield* execute(
                `return await tools[${JSON.stringify(alpha.app.slug)}].mutations.hello({})`,
              )).execution.ok,
              false,
            );
            assert.equal(
              (yield* execute(
                `return await tools[${JSON.stringify(executorA.slug)}].mutations.apps_deploy({path: {organization: ${JSON.stringify(a.id)}}, body: {name: "Denied", files: [{path: "index.ts", content: ${JSON.stringify(source)}}]}})`,
              )).execution.ok,
              false,
            );
            assert.equal(
              (yield* execute(
                `return await tools[${JSON.stringify(executorA.slug)}].queries.organization_inventory({path: {organization: ${JSON.stringify(a.id)}}})`,
              )).execution.ok,
              false,
            );
            yield* sql`delete from "member" where "userId" = ${user.id} and "organizationId" = ${a.id}`;
            const authenticated = { authorization: `Bearer ${tokens.access_token}` };
            assert.equal((yield* request("/mcp", { headers: authenticated })).status, 403);
            yield* Effect.promise(() =>
              auth.api.addMember({
                body: { organizationId: a.id, userId: user.id, role: "owner" },
              }),
            );
            const refreshed = yield* exchange({
              grant_type: "refresh_token",
              client_id,
              refresh_token: tokens.refresh_token,
              resource: `${origin}/mcp`,
            });
            assert.equal(
              refreshed.status,
              200,
              yield* Effect.promise(() => refreshed.clone().text()),
            );
            const rotated = yield* json(refreshed, Tokens);
            const access = yield* Effect.promise(() =>
              auth.api.getMcpAccess({
                headers: new Headers({ authorization: `Bearer ${rotated.access_token}` }),
              }),
            );
            assert.equal(access.access.organization, a.id);
            const consents = yield* Effect.promise(() =>
              auth.api.getOAuthConsents({ headers: new Headers({ cookie, origin }) }),
            );
            const grant = consents.find(
              (consent) =>
                consent.referenceId === access.grant.id && consent.clientId === client_id,
            );
            assert.ok(grant);
            const revoke = yield* post(
              "/api/auth/oauth2/delete-consent",
              { id: grant.id },
              { cookie, origin },
            );
            assert.equal(revoke.status, 200);
            assert.equal(
              (yield* request("/mcp", {
                headers: { authorization: `Bearer ${rotated.access_token}` },
              })).status,
              401,
            );
            assert.equal(
              (yield* request(`/api/organizations/${a.id}/inventory`, {
                headers: { authorization: `Bearer ${rotated.access_token}` },
              })).status,
              401,
            );
            assert.equal(
              (yield* exchange({
                grant_type: "refresh_token",
                client_id,
                refresh_token: rotated.refresh_token,
              })).status,
              400,
            );
            assert.equal(
              (yield* executor.accounts.get({ account: executorAccount.id })).method,
              "oauth",
              "the connected account is independent of the MCP grant",
            );
            yield* executor.apps.rename({ app: executorA.id, name: "My Executor" });
            yield* initialize(OrganizationId.make(a.id));
            assert.ok(
              !(yield* executor.apps.list({ owner: executorA.owner })).some(
                (app) => app.name === "Executor",
              ),
              "renaming does not create another default",
            );
            yield* executor.apps.remove({ app: executorA.id });
            yield* initialize(OrganizationId.make(a.id));
            assert.ok(
              !(yield* executor.apps.list({ owner: executorA.owner })).some(
                (app) => app.id === executorA.id || app.name === "Executor",
              ),
              "deleting does not resurrect the default app",
            );
          }).pipe(
            Effect.provide(selfHostDatabase),
            Effect.provideService(ConfigProvider.ConfigProvider, configuration),
          );
        }).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
      ),
    ),
);
