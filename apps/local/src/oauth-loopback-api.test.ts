// ---------------------------------------------------------------------------
// Local app × loopback OAuth callback — real HTTP, real sockets (v2)
// ---------------------------------------------------------------------------
//
// The whole chain is real:
//
//   test → real loopback socket (127.0.0.1:<callbackPort>)
//        → LocalApi OAuthHandlers (`oauth.start` binds the URI first)
//        → OAuthTestServer (metadata, /authorize → login, /token)
//
// It proves what a provider without dynamic client registration depends on:
// declaring a callback port makes `oauth.start` serve THAT exact URI and send it
// as `redirect_uri` on both the authorize request and the token exchange, the
// provider's redirect reaches the daemon's completion route, and a port someone
// else holds fails the request with the reason instead of stranding the user at
// the provider.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it } from "@effect/vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

import { HttpApi, HttpApiBuilder, HttpApiClient } from "effect/unstable/httpapi";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import { Effect, Layer } from "effect";

import { addGroup, observabilityMiddleware } from "@executor-js/api";
import {
  CoreHandlers,
  ExecutionEngineService,
  ExecutorService,
  OAuthLoopbackListener,
  collectTables,
} from "@executor-js/api/server";
import { createExecutionEngine } from "@executor-js/execution";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  Subject,
  Tenant,
  createExecutor,
} from "@executor-js/sdk";
import { serveOAuthTestServer } from "@executor-js/sdk/testing";
import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets";
import { mcpPlugin } from "@executor-js/plugin-mcp";
import { McpExtensionService, McpGroup, McpHandlers } from "@executor-js/plugin-mcp/api";

import { ErrorCaptureLive } from "./observability";
import { createSqliteFumaDb } from "./db/sqlite-fumadb";
import { makeOAuthLoopbackListener, type LocalOAuthLoopbackListener } from "./oauth-loopback";

const TestApi = addGroup(McpGroup);
type TestApiShape =
  typeof TestApi extends HttpApi.HttpApi<infer _Id, infer Groups>
    ? HttpApiClient.Client<Groups, never>
    : never;

const TEST_BASE_URL = "http://local.test";
/** The origin this harness's executor derives its OWN callback from — the local
 *  daemon's default. The loopback listener forwards here. */
const DAEMON_ORIGIN = "http://localhost:4788";

const freePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("probe socket has no port"));
        return;
      }
      const port = address.port;
      probe.close(() => resolve(port));
    });
  });

interface Harness {
  /** The in-process web handler, reached through this origin. */
  readonly fetch: typeof globalThis.fetch;
  readonly registerRemoteServer: (input: {
    readonly slug: string;
    readonly endpoint: string;
  }) => Effect.Effect<void, unknown>;
  readonly listener: LocalOAuthLoopbackListener;
  readonly dispose: () => Promise<void>;
}

const startHarness = async (tmpDir: string): Promise<Harness> => {
  const plugins = [
    mcpPlugin({ dangerouslyAllowStdioMCP: false }),
    fileSecretsPlugin({ directory: tmpDir }),
  ] as const;
  const sqlite = await createSqliteFumaDb({
    tables: collectTables(),
    namespace: "executor_local_loopback_test",
    path: join(tmpDir, "data.db"),
  });

  const executor = await Effect.runPromise(
    createExecutor({
      tenant: Tenant.make(`test-${randomBytes(4).toString("hex")}`),
      subject: Subject.make("local"),
      db: sqlite.db,
      plugins,
      onElicitation: "accept-all",
      oauthEndpointUrlPolicy: { allowHttp: true },
      redirectUri: `${DAEMON_ORIGIN}/api/oauth/callback`,
    }),
  );

  const engine = createExecutionEngine({
    executor,
    codeExecutor: makeQuickJsExecutor(),
  });

  const listener = makeOAuthLoopbackListener(DAEMON_ORIGIN);
  const TestObservability = observabilityMiddleware(TestApi);

  const TestApiBase = HttpApiBuilder.layer(TestApi).pipe(
    Layer.provide(CoreHandlers),
    Layer.provide(McpHandlers),
    Layer.provide(TestObservability),
    Layer.provide(ErrorCaptureLive),
  );

  const pluginExtensions = Layer.succeed(McpExtensionService)(executor.mcp);

  const { handler: webHandler, dispose: disposeHandler } = HttpRouter.toWebHandler(
    TestApiBase.pipe(
      Layer.provideMerge(pluginExtensions),
      Layer.provideMerge(Layer.succeed(ExecutorService)(executor)),
      Layer.provideMerge(Layer.succeed(ExecutionEngineService)(engine)),
      // The host capability the real local daemon provides in `app.ts`.
      Layer.provideMerge(Layer.succeed(OAuthLoopbackListener)(listener)),
      Layer.provideMerge(HttpServer.layerServices),
      Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
    ),
  );

  return {
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      webHandler(
        input instanceof Request ? input : new Request(input, init),
      )) as typeof globalThis.fetch,
    listener,
    registerRemoteServer: ({ slug, endpoint }) =>
      executor.mcp
        .addServer({
          transport: "remote",
          name: slug,
          slug,
          endpoint,
          authenticationTemplate: [{ kind: "oauth2", slug: "oauth" }],
        })
        .pipe(Effect.asVoid),
    dispose: async () => {
      listener.closeAll();
      await Effect.runPromise(Effect.ignore(Effect.tryPromise(() => disposeHandler())));
      await Effect.runPromise(
        Effect.ignore(Effect.tryPromise(() => Effect.runPromise(executor.close()))),
      );
      await sqlite.close();
    },
  };
};

const tmpDirs: string[] = [];
const harnesses: Harness[] = [];

const openHarness = async (): Promise<Harness> => {
  const tmpDir = mkdtempSync(join(tmpdir(), "executor-local-loopback-"));
  tmpDirs.push(tmpDir);
  const harness = await startHarness(tmpDir);
  harnesses.push(harness);
  return harness;
};

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.dispose();
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("local oauth loopback callback (real API, real sockets)", () => {
  it.effect(
    "serves the declared port and completes the flow the provider redirects there",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* Effect.promise(() => openHarness());
          const oauth = yield* serveOAuthTestServer({ scopes: ["read"] });
          const callbackPort = yield* Effect.promise(() => freePort());
          const clientLayer = FetchHttpClient.layer.pipe(
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(harness.fetch)),
          );

          const run = <A, E>(body: (client: TestApiShape) => Effect.Effect<A, E>) =>
            Effect.gen(function* () {
              const client = yield* HttpApiClient.make(TestApi, { baseUrl: TEST_BASE_URL });
              return yield* body(client);
            }).pipe(Effect.provide(clientLayer)) as Effect.Effect<A, E>;

          yield* harness.registerRemoteServer({
            slug: "mcp_remote",
            endpoint: oauth.mcpResourceUrl,
          });

          const slug = `slack-${randomBytes(4).toString("hex")}`;
          yield* run((client) =>
            client.oauth.createClient({
              payload: {
                owner: "org",
                slug: OAuthClientSlug.make(slug),
                authorizationUrl: oauth.authorizationEndpoint,
                tokenUrl: oauth.tokenEndpoint,
                grant: "authorization_code",
                clientId: "test-client",
                clientSecret: "test-secret",
                // Public PKCE client whose provider app pins this exact URI:
                // the shape the fixed-callback provider forces.
                callbackPort,
              },
            }),
          );

          const started = yield* run((client) =>
            client.oauth.start({
              payload: {
                client: OAuthClientSlug.make(slug),
                clientOwner: "org",
                owner: "org",
                name: ConnectionName.make("slack"),
                integration: IntegrationSlug.make("mcp_remote"),
                template: AuthTemplateSlug.make("oauth"),
                // The UI's own origin is NOT what an app with a pinned callback
                // may use; the declaration outranks it.
                redirectUri: `${DAEMON_ORIGIN}/api/oauth/callback`,
              },
            }),
          );
          expect(started.status).toBe("redirect");
          if (started.status !== "redirect") return;
          expect(new URL(started.authorizationUrl).searchParams.get("redirect_uri")).toBe(
            `http://127.0.0.1:${callbackPort}/callback`,
          );

          // Drive the authorization at the provider: it redirects the browser to
          // the URI it has registered, which is the port the listener bound.
          const callback = yield* oauth.completeAuthorizationCodeFlow({
            authorizationUrl: started.authorizationUrl,
          });
          expect(
            callback.callbackUrl.startsWith(`http://127.0.0.1:${callbackPort}/callback?`),
          ).toBe(true);

          // The provider's redirect, over a real socket, to the bound port.
          const providerRedirect = yield* Effect.promise(() =>
            fetch(callback.callbackUrl, { redirect: "manual" }),
          );
          expect(providerRedirect.status).toBe(302);
          const forwarded = providerRedirect.headers.get("location") ?? "";
          expect(forwarded.startsWith(`${DAEMON_ORIGIN}/api/oauth/callback?`)).toBe(true);

          // …and the daemon's completion route mints the connection.
          const forwardedPath = new URL(forwarded);
          yield* Effect.promise(() =>
            harness.fetch(`${TEST_BASE_URL}/oauth/callback${forwardedPath.search}`),
          );

          const connections = yield* run((client) => client.connections.list({ query: {} }));
          expect(connections.some((connection) => String(connection.name) === "slack")).toBe(true);

          // The token exchange sent the SAME redirect_uri the authorize request
          // did — the server rejects the code otherwise, and the request is
          // checked here so the guarantee is asserted, not inferred.
          const tokenRequest = (yield* oauth.requests).find((request) => request.path === "/token");
          expect(new URLSearchParams(tokenRequest?.body ?? "").get("redirect_uri")).toBe(
            `http://127.0.0.1:${callbackPort}/callback`,
          );
        }),
      ),
    30_000,
  );

  it.effect(
    "fails the start with the reason when the declared port is already held",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* Effect.promise(() => openHarness());
          const oauth = yield* serveOAuthTestServer({ scopes: ["read"] });
          const callbackPort = yield* Effect.promise(() => freePort());
          const holder = Bun.serve({
            hostname: "127.0.0.1",
            port: callbackPort,
            fetch: () => new Response("held"),
          });
          const clientLayer = FetchHttpClient.layer.pipe(
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(harness.fetch)),
          );

          const run = <A, E>(body: (client: TestApiShape) => Effect.Effect<A, E>) =>
            Effect.gen(function* () {
              const client = yield* HttpApiClient.make(TestApi, { baseUrl: TEST_BASE_URL });
              return yield* body(client);
            }).pipe(Effect.provide(clientLayer)) as Effect.Effect<A, E>;

          try {
            yield* harness.registerRemoteServer({
              slug: "mcp_remote",
              endpoint: oauth.mcpResourceUrl,
            });

            const slug = `slack-${randomBytes(4).toString("hex")}`;
            yield* run((client) =>
              client.oauth.createClient({
                payload: {
                  owner: "org",
                  slug: OAuthClientSlug.make(slug),
                  authorizationUrl: oauth.authorizationEndpoint,
                  tokenUrl: oauth.tokenEndpoint,
                  grant: "authorization_code",
                  clientId: "test-client",
                  clientSecret: "test-secret",
                  callbackPort,
                },
              }),
            );

            const failure = yield* Effect.flip(
              run((client) =>
                client.oauth.start({
                  payload: {
                    client: OAuthClientSlug.make(slug),
                    clientOwner: "org",
                    owner: "org",
                    name: ConnectionName.make("slack"),
                    integration: IntegrationSlug.make("mcp_remote"),
                    template: AuthTemplateSlug.make("oauth"),
                  },
                }),
              ),
            );
            expect(String((failure as { readonly message?: string }).message)).toContain(
              `Port ${callbackPort} is already in use`,
            );
          } finally {
            holder.stop(true);
          }
        }),
      ),
    30_000,
  );
});
