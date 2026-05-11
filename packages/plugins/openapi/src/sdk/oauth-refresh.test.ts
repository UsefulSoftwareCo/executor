// ---------------------------------------------------------------------------
// End-to-end refresh behaviour for the OpenAPI plugin's oauth2 connection
// provider.
//
// The existing `multi-scope-oauth.test.ts` covers sign-in isolation; this
// file focuses on RFC 6749 §6 refresh behaviour at the plugin boundary:
//
//   1. An expired access_token is refreshed transparently before invoke.
//   2. Concurrent invokes collapse to a single `grant_type=refresh_token`
//      POST — the SDK's dedup applies to the plugin's provider.
//   3. `invalid_grant` from the token endpoint surfaces as
//      `ConnectionReauthRequiredError` so the UI can prompt sign-in.
// ---------------------------------------------------------------------------

import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Predicate, Ref, Schema } from "effect";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "effect/unstable/httpapi";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";

import {
  ConnectionId,
  CreateConnectionInput,
  ScopeId,
  SecretId,
  Scope,
  SetSecretInput,
  TokenMaterial,
  OAUTH2_PROVIDER_KEY,
  collectSchemas,
  createExecutor,
  definePlugin,
  makeInMemoryBlobStore,
  type InvokeOptions,
  type SecretProvider,
} from "@executor-js/sdk";
import { serveTestHttpApp } from "@executor-js/sdk/testing";
import { makeMemoryAdapter } from "@executor-js/storage-core/testing/memory";

import { openApiPlugin } from "./plugin";
import { OAuth2SourceConfig, OpenApiSourceBindingInput } from "./types";

const autoApprove: InvokeOptions = { onElicitation: "accept-all" };

// ---------------------------------------------------------------------------
// Test API — one endpoint that echoes the Authorization header so we can
// prove which access token was in flight at invoke time.
// ---------------------------------------------------------------------------

class EchoHeaders extends Schema.Class<EchoHeaders>("EchoHeaders")({
  authorization: Schema.optional(Schema.String),
}) {}

const ItemsGroup = HttpApiGroup.make("items").add(
  HttpApiEndpoint.get("echoHeaders", "/echo-headers", { success: EchoHeaders }),
);

const TestApi = HttpApi.make("testApi").add(ItemsGroup);
const specJson = JSON.stringify(OpenApi.fromApi(TestApi));

const ItemsGroupLive = HttpApiBuilder.group(TestApi, "items", (handlers) =>
  handlers.handle("echoHeaders", () =>
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      return new EchoHeaders({
        authorization: req.headers["authorization"],
      });
    }),
  ),
);

const ApiLive = HttpApiBuilder.layer(TestApi).pipe(Layer.provide(ItemsGroupLive));

const TestLayer = HttpRouter.serve(ApiLive, { disableListenLog: true, disableLogger: true }).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
);

// ---------------------------------------------------------------------------
// Token-endpoint mock. Callers supply a handler that sees the parsed body
// (grant_type, refresh_token, ...) and returns either an RFC 6749 success
// response or an error envelope. `calls` records every hit for assertions.
// ---------------------------------------------------------------------------

type TokenCall = {
  readonly body: URLSearchParams;
};

const serveTokenEndpoint = (
  handler: (body: URLSearchParams) => HttpServerResponse.HttpServerResponse,
) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<readonly TokenCall[]>([]);
    const server = yield* serveTestHttpApp((request) =>
      Effect.gen(function* () {
        const body = new URLSearchParams(yield* request.text);
        yield* Ref.update(calls, (all) => [...all, { body }]);
        return handler(body);
      }).pipe(
        Effect.catch(() =>
          Effect.succeed(HttpServerResponse.text("token fixture request failed", { status: 500 })),
        ),
      ),
    );
    return {
      tokenUrl: server.url("/token"),
      calls: Ref.get(calls),
    } as const;
  });

// ---------------------------------------------------------------------------
// Fixture builder. Wires up a single-scope executor with an in-memory
// secrets provider, the openApi plugin pointed at a live HttpClient, and
// seeds an expired oauth2 Connection + source pointing at that server.
// ---------------------------------------------------------------------------

const makeExecutor = () =>
  Effect.gen(function* () {
    const secretStore = new Map<string, string>();
    const keyOf = (scope: string, id: string) => `${scope} ${id}`;
    const memoryProvider: SecretProvider = {
      key: "memory",
      writable: true,
      get: (id, scope) => Effect.sync(() => secretStore.get(keyOf(scope, id)) ?? null),
      set: (id, value, scope) =>
        Effect.sync(() => {
          secretStore.set(keyOf(scope, id), value);
        }),
      delete: (id, scope) => Effect.sync(() => secretStore.delete(keyOf(scope, id))),
    };
    const memorySecretsPlugin = definePlugin(() => ({
      id: "memory-secrets" as const,
      storage: () => ({}),
      secretProviders: [memoryProvider],
    }));
    const clientLayer = FetchHttpClient.layer;
    const server = yield* HttpServer.HttpServer;
    const address = server.address;
    if (!Predicate.isTagged("TcpAddress")(address)) {
      // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: test harness cannot continue without a TCP test server address
      return yield* Effect.die("test server must bind to TCP");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const plugins = [
      openApiPlugin({ httpClientLayer: clientLayer }),
      memorySecretsPlugin(),
    ] as const;

    const schema = collectSchemas(plugins);
    const adapter = makeMemoryAdapter({ schema });
    const blobs = makeInMemoryBlobStore();

    const scopeId = ScopeId.make("test-scope");
    const scope = new Scope({
      id: scopeId,
      name: "test",
      createdAt: new Date(),
    });
    const executor = yield* createExecutor({
      scopes: [scope],
      adapter,
      blobs,
      plugins,
      onElicitation: "accept-all",
    });

    // Seed client id + secret in the executor scope so the openapi
    // provider's refresh can resolve them.
    yield* executor.secrets.set(
      new SetSecretInput({
        id: SecretId.make("client_id"),
        scope: scopeId,
        name: "Client ID",
        value: "abc",
      }),
    );
    yield* executor.secrets.set(
      new SetSecretInput({
        id: SecretId.make("client_secret"),
        scope: scopeId,
        name: "Client Secret",
        value: "shhh",
      }),
    );

    return { executor, scopeId, baseUrl };
  });

type EffectSuccess<T> = T extends Effect.Effect<infer A, unknown, unknown> ? A : never;

type ExecutorValue = EffectSuccess<ReturnType<typeof makeExecutor>>["executor"];

// Seed an authorizationCode Connection with an already-expired access
// token and a stored refresh token. The test's mock token endpoint
// decides what comes back on `grant_type=refresh_token`.
const seedExpiredConnection = (
  executor: ExecutorValue,
  scopeId: ScopeId,
  connectionId: string,
  tokenUrl: string,
) =>
  Effect.gen(function* () {
    yield* executor.connections.create(
      new CreateConnectionInput({
        id: ConnectionId.make(connectionId),
        scope: scopeId,
        provider: OAUTH2_PROVIDER_KEY,
        identityLabel: "Alice",
        accessToken: new TokenMaterial({
          secretId: SecretId.make(`${connectionId}.access_token`),
          name: "Access",
          value: "expired-access-v1",
        }),
        refreshToken: new TokenMaterial({
          secretId: SecretId.make(`${connectionId}.refresh_token`),
          name: "Refresh",
          value: "refresh-v1",
        }),
        expiresAt: Date.now() - 10_000,
        oauthScope: "read",
        providerState: {
          kind: "authorization-code",
          tokenEndpoint: tokenUrl,
          issuerUrl: null,
          clientIdSecretId: "client_id",
          clientSecretSecretId: "client_secret",
          clientAuth: "body",
          scopes: ["read"],
          scope: "read",
        },
      }),
    );
    return new OAuth2SourceConfig({
      kind: "oauth2",
      securitySchemeName: "oauth2",
      flow: "authorizationCode",
      tokenUrl,
      authorizationUrl: "https://auth.example.com/authorize",
      clientIdSlot: "oauth2:oauth2:client-id",
      clientSecretSlot: "oauth2:oauth2:client-secret",
      connectionSlot: "oauth2:oauth2:connection",
      scopes: ["read"],
    });
  });

const bindOAuthConnection = (
  executor: ExecutorValue,
  scopeId: ScopeId,
  connectionId: string,
  oauth2: OAuth2SourceConfig,
) =>
  executor.openapi.setSourceBinding(
    new OpenApiSourceBindingInput({
      sourceId: "petstore",
      sourceScope: scopeId,
      scope: scopeId,
      slot: oauth2.connectionSlot,
      value: { kind: "connection", connectionId: ConnectionId.make(connectionId) },
    }),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

layer(TestLayer)("OpenAPI oauth refresh", (it) => {
  it.effect("expired access_token is refreshed via grant_type=refresh_token before invoke", () =>
    Effect.gen(function* () {
      const { executor, scopeId, baseUrl } = yield* makeExecutor();
      const tokenEndpoint = yield* serveTokenEndpoint(() =>
        HttpServerResponse.jsonUnsafe({
          access_token: "fresh-access-v2",
          token_type: "Bearer",
          refresh_token: "refresh-v2",
          expires_in: 3600,
        }),
      );

      const auth = yield* seedExpiredConnection(
        executor,
        scopeId,
        "conn-refresh-ok",
        tokenEndpoint.tokenUrl,
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: String(scopeId),
        namespace: "petstore",
        baseUrl,
        oauth2: auth,
      });
      yield* bindOAuthConnection(executor, scopeId, "conn-refresh-ok", auth);

      const result = (yield* executor.tools.invoke(
        "petstore.items.echoHeaders",
        {},
        autoApprove,
      )) as { data: { authorization?: string } | null; error: unknown };

      expect(result.error).toBeNull();
      // Proves the refresh landed: invoke carried the fresh token,
      // not the expired one we seeded.
      expect(result.data?.authorization).toBe("Bearer fresh-access-v2");
      const calls = yield* tokenEndpoint.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0]!.body.get("grant_type")).toBe("refresh_token");
      expect(calls[0]!.body.get("refresh_token")).toBe("refresh-v1");

      // Connection row is patched with the new expiry so the next
      // invoke in-window doesn't trip a second refresh.
      const conn = yield* executor.connections.get("conn-refresh-ok");
      expect(conn).not.toBeNull();
      expect(conn!.expiresAt).not.toBeNull();
      expect(conn!.expiresAt!).toBeGreaterThan(Date.now() + 3_000_000);
    }),
  );

  it.effect("concurrent invokes with an expired token issue exactly one refresh", () =>
    Effect.gen(function* () {
      const { executor, scopeId, baseUrl } = yield* makeExecutor();
      const tokenEndpoint = yield* serveTokenEndpoint(() =>
        HttpServerResponse.jsonUnsafe({
          access_token: "fresh-access-v2",
          token_type: "Bearer",
          refresh_token: "refresh-v2",
          expires_in: 3600,
        }),
      );

      const auth = yield* seedExpiredConnection(
        executor,
        scopeId,
        "conn-refresh-concurrent",
        tokenEndpoint.tokenUrl,
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: String(scopeId),
        namespace: "petstore",
        baseUrl,
        oauth2: auth,
      });
      yield* bindOAuthConnection(executor, scopeId, "conn-refresh-concurrent", auth);

      const invokes = yield* Effect.all(
        [1, 2, 3, 4, 5].map(() =>
          executor.tools.invoke("petstore.items.echoHeaders", {}, autoApprove),
        ),
        { concurrency: "unbounded" },
      );

      for (const r of invokes) {
        const res = r as {
          data: { authorization?: string } | null;
          error: unknown;
        };
        expect(res.error).toBeNull();
        expect(res.data?.authorization).toBe("Bearer fresh-access-v2");
      }
      // Critical assertion: the SDK's dedup collapses every parallel
      // invoke into one call to the token endpoint. Anything more
      // means we're hammering the AS under load.
      const calls = yield* tokenEndpoint.calls;
      expect(calls).toHaveLength(1);
    }),
  );

  it.effect("invalid_grant from refresh surfaces as ConnectionReauthRequiredError", () =>
    Effect.gen(function* () {
      const { executor, scopeId, baseUrl } = yield* makeExecutor();
      const tokenEndpoint = yield* serveTokenEndpoint(() =>
        HttpServerResponse.jsonUnsafe(
          {
            error: "invalid_grant",
            error_description: "Refresh token revoked",
          },
          { status: 400 },
        ),
      );

      const auth = yield* seedExpiredConnection(
        executor,
        scopeId,
        "conn-refresh-dead",
        tokenEndpoint.tokenUrl,
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: String(scopeId),
        namespace: "petstore",
        baseUrl,
        oauth2: auth,
      });
      yield* bindOAuthConnection(executor, scopeId, "conn-refresh-dead", auth);

      // Tool invocation currently wraps connection errors in a
      // generic Error (see openapi invokeTool), so we assert against
      // the `accessToken` call directly too — that's the surface
      // the UI bridges use to trigger re-auth.
      const flipped = yield* executor.connections.accessToken("conn-refresh-dead").pipe(
        Effect.flip,
        Effect.flatMap((error) =>
          Predicate.isTagged("ConnectionReauthRequiredError")(error)
            ? Effect.succeed(error)
            : Effect.fail(error),
        ),
      );
      expect(flipped.provider).toBe(OAUTH2_PROVIDER_KEY);
      expect(flipped.message).toMatch(/OAuth refresh failed: .*revoked/i);
    }),
  );
});
