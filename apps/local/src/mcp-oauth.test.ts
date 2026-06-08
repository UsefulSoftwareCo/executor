// ---------------------------------------------------------------------------
// Local app × OAuth — real HTTP end-to-end (v2)
// ---------------------------------------------------------------------------
//
// Drives the real LocalApi (core + mcp groups) against a real in-process OAuth
// test server. Every layer between the test and the SDK is real:
//
//   test → HttpApiClient → in-process webHandler → LocalApi
//        → OAuthHandlers → executor.oauth.{probe,createClient,start}
//        → OAuthTestServer (AS metadata, protected-resource metadata, DCR,
//          /authorize → login, /token)
//
// v2: OAuth is a credential mechanism on the core surface (`executor.oauth`),
// not a plugin-specific MCP handoff. `probe` (RFC 8414 / OIDC discovery),
// `createClient`, and `start`/`complete` (milestone 2) are all implemented. This
// test asserts the live discovery path AND that `start` returns an authorization
// redirect (PKCE + correlation state) over the real HTTP boundary.
//
// Single workspace: local binds one tenant per project (`${folder}-${hash}`)
// plus a fixed subject, so owner: "org" connections file at the tenant.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HttpApi, HttpApiBuilder, HttpApiClient } from "effect/unstable/httpapi";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import { Effect, Layer } from "effect";

import { addGroup, observabilityMiddleware } from "@executor-js/api";
import {
  CoreHandlers,
  ExecutionEngineService,
  ExecutorService,
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

// Shape of the test API: core (incl. the oauth group) + mcp group, with
// InternalError surfaced at the top level so `observabilityMiddleware` can land
// its typed-error bridge on every endpoint.
const TestApi = addGroup(McpGroup);
type TestApiShape =
  typeof TestApi extends HttpApi.HttpApi<infer _Id, infer Groups>
    ? HttpApiClient.Client<Groups, never>
    : never;

// ---------------------------------------------------------------------------
// In-process local API harness — tmpdir SQLite + minimal plugin set.
// ---------------------------------------------------------------------------

const TEST_BASE_URL = "http://local.test";

interface Harness {
  readonly fetch: typeof globalThis.fetch;
  readonly dispose: () => Promise<void>;
}

const startHarness = async (tmpDir: string): Promise<Harness> => {
  const plugins = [
    mcpPlugin({ dangerouslyAllowStdioMCP: false }),
    fileSecretsPlugin({ directory: tmpDir }),
  ] as const;
  const sqlite = await createSqliteFumaDb({
    tables: collectTables(),
    namespace: "executor_local_test",
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
      // EXPLICIT OAuth callback — required now that the localhost default is
      // gone; the local daemon serves `/api/oauth/callback` on the web origin.
      redirectUri: "http://localhost:4788/api/oauth/callback",
    }),
  );

  const engine = createExecutionEngine({
    executor,
    codeExecutor: makeQuickJsExecutor(),
  });

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
      Layer.provideMerge(HttpServer.layerServices),
      Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
    ),
  );

  return {
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      webHandler(
        input instanceof Request ? input : new Request(input, init),
      )) as typeof globalThis.fetch,
    dispose: async () => {
      await Effect.runPromise(Effect.ignore(Effect.tryPromise(() => disposeHandler())));
      await Effect.runPromise(
        Effect.ignore(Effect.tryPromise(() => Effect.runPromise(executor.close()))),
      );
      await sqlite.close();
    },
  };
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;
let harness: Harness;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "executor-local-mcp-"));
  harness = await startHarness(tmpDir);
});

afterAll(async () => {
  await harness.dispose();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("local oauth (real OAuth discovery + stubbed start)", () => {
  it.effect(
    "probe discovers the authorization server; start returns an authorization redirect",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const oauth = yield* serveOAuthTestServer();
          const clientLayer = FetchHttpClient.layer.pipe(
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(harness.fetch)),
          );

          const run = <A, E>(
            body: (client: TestApiShape) => Effect.Effect<A, E>,
          ): Effect.Effect<A, E> =>
            Effect.gen(function* () {
              const client = yield* HttpApiClient.make(TestApi, {
                baseUrl: TEST_BASE_URL,
              });
              return yield* body(client);
            }).pipe(Effect.provide(clientLayer)) as Effect.Effect<A, E>;

          // probe — real RFC 8414 / OIDC discovery against the test server.
          const probed = yield* run((client) =>
            client.oauth.probe({ payload: { url: oauth.mcpResourceUrl } }),
          );
          expect(probed.authorizationUrl).toBe(oauth.authorizationEndpoint);
          expect(probed.tokenUrl).toBe(oauth.tokenEndpoint);

          // createClient — register an owner-scoped OAuth app for the start flow.
          const slug = `mcp-oauth2-${randomBytes(4).toString("hex")}`;
          const created = yield* run((client) =>
            client.oauth.createClient({
              payload: {
                owner: "org",
                slug: OAuthClientSlug.make(slug),
                authorizationUrl: oauth.authorizationEndpoint,
                tokenUrl: oauth.tokenEndpoint,
                grant: "authorization_code",
                clientId: "test-client",
                clientSecret: "test-secret",
              },
            }),
          );
          expect(String(created.client)).toBe(slug);

          // start — milestone 2 wired: authorization_code returns a redirect to
          // the authorization server (with PKCE + a correlation state).
          const started = yield* run((client) =>
            client.oauth.start({
              payload: {
                client: OAuthClientSlug.make(slug),
                clientOwner: "org",
                owner: "org",
                name: ConnectionName.make("main"),
                integration: IntegrationSlug.make("mcp_remote"),
                template: AuthTemplateSlug.make("oauth"),
              },
            }),
          );
          expect(started.status).toBe("redirect");
          const redirect = started as Extract<typeof started, { status: "redirect" }>;
          expect(redirect.authorizationUrl).toContain(oauth.authorizationEndpoint);
          expect(redirect.authorizationUrl).toContain(
            encodeURIComponent("http://localhost:4788/api/oauth/callback"),
          );
          expect(redirect.state).toBeTruthy();
        }),
      ),
    30_000,
  );
});
