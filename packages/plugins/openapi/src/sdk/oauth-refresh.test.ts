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

import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate, Schema } from "effect";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { FetchHttpClient, HttpServerRequest } from "effect/unstable/http";

import {
  ConnectionId,
  CreateConnectionInput,
  ScopeId,
  SecretId,
  Scope,
  SetSecretInput,
  SetSourceCredentialBindingInput,
  TokenMaterial,
  OAUTH2_PROVIDER_KEY,
  createExecutor,
  definePlugin,
  type InvokeOptions,
  type SecretProvider,
} from "@executor-js/sdk";
import { makeTestConfig, serveOAuthTestServer } from "@executor-js/sdk/testing";
import {
  addOpenApiTestSource,
  serveOpenApiHttpApiTestServer,
  unwrapInvocation,
} from "@executor-js/plugin-openapi/testing";

import { openApiPlugin } from "./plugin";
import { OAuth2SourceConfig } from "./types";

const autoApprove: InvokeOptions = { onElicitation: "accept-all" };

// ---------------------------------------------------------------------------
// Test API — one endpoint that echoes the Authorization header so we can
// prove which access token was in flight at invoke time.
// ---------------------------------------------------------------------------

const EchoHeaders = Schema.Struct({
  authorization: Schema.optional(Schema.String),
});
type EchoHeaders = typeof EchoHeaders.Type;

const ItemsGroup = HttpApiGroup.make("items").add(
  HttpApiEndpoint.get("echoHeaders", "/echo-headers", { success: EchoHeaders }),
);

const TestApi = HttpApi.make("testApi").add(ItemsGroup);

const ItemsGroupLive = HttpApiBuilder.group(TestApi, "items", (handlers) =>
  handlers.handle("echoHeaders", () =>
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      return EchoHeaders.make({
        authorization: req.headers["authorization"],
      });
    }),
  ),
);

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
    const openApiServer = yield* serveOpenApiHttpApiTestServer({
      api: TestApi,
      handlersLayer: ItemsGroupLive,
    });
    const plugins = [
      openApiPlugin({ httpClientLayer: clientLayer }),
      memorySecretsPlugin(),
    ] as const;
    const config = makeTestConfig({ plugins });

    const scopeId = ScopeId.make("test-scope");
    const scope = Scope.make({
      id: scopeId,
      name: "test",
      createdAt: new Date(),
    });
    const executor = yield* createExecutor({
      ...config,
      scopes: [scope],
      plugins,
      onElicitation: "accept-all",
    });

    // Seed client id + secret in the executor scope so the openapi
    // provider's refresh can resolve them.
    yield* executor.secrets.set(
      SetSecretInput.make({
        id: SecretId.make("client_id"),
        scope: scopeId,
        name: "Client ID",
        value: "abc",
      }),
    );
    yield* executor.secrets.set(
      SetSecretInput.make({
        id: SecretId.make("client_secret"),
        scope: scopeId,
        name: "Client Secret",
        value: "shhh",
      }),
    );

    return { executor, scopeId, openApiServer };
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
  refreshToken: string,
) =>
  Effect.gen(function* () {
    yield* executor.connections.create(
      CreateConnectionInput.make({
        id: ConnectionId.make(connectionId),
        scope: scopeId,
        provider: OAUTH2_PROVIDER_KEY,
        identityLabel: "Alice",
        accessToken: TokenMaterial.make({
          secretId: SecretId.make(`${connectionId}.access_token`),
          name: "Access",
          value: "expired-access-v1",
        }),
        refreshToken: TokenMaterial.make({
          secretId: SecretId.make(`${connectionId}.refresh_token`),
          name: "Refresh",
          value: refreshToken,
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
    return OAuth2SourceConfig.make({
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
  executor.sources.setBinding(
    SetSourceCredentialBindingInput.make({
      source: { id: "petstore", scope: scopeId },
      scope: scopeId,
      slotKey: oauth2.connectionSlot,
      value: { kind: "connection", connectionId: ConnectionId.make(connectionId) },
    }),
  );

const refreshTokenRequests = (
  requests: readonly { readonly path: string; readonly body: string }[],
) =>
  requests
    .filter((request) => request.path === "/token")
    .map((request) => new URLSearchParams(request.body))
    .filter((body) => body.get("grant_type") === "refresh_token");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenAPI oauth refresh", () => {
  it.effect("expired access_token is refreshed via grant_type=refresh_token before invoke", () =>
    Effect.gen(function* () {
      const { executor, scopeId, openApiServer } = yield* makeExecutor();
      const oauth = yield* serveOAuthTestServer({
        defaultClientId: "abc",
        defaultClientSecret: "shhh",
      });
      const initialTokens = yield* oauth.completeAuthorizationCodeTokenFlow();
      expect(initialTokens.refreshToken).toBeDefined();
      yield* oauth.clearRequests;

      const auth = yield* seedExpiredConnection(
        executor,
        scopeId,
        "conn-refresh-ok",
        oauth.tokenEndpoint,
        initialTokens.refreshToken!,
      );

      yield* addOpenApiTestSource(executor, openApiServer, {
        scope: String(scopeId),
        namespace: "petstore",
        oauth2: auth,
      });
      yield* bindOAuthConnection(executor, scopeId, "conn-refresh-ok", auth);

      const result = unwrapInvocation(
        yield* executor.tools.invoke("petstore.items.echoHeaders", {}, autoApprove),
      );

      expect(result.error).toBeNull();
      const data = result.data as EchoHeaders | null;
      // Proves the refresh landed: invoke carried the fresh token,
      // not the expired one we seeded.
      expect(data?.authorization).not.toBe("Bearer expired-access-v1");
      const bearer = data?.authorization?.replace(/^Bearer\s+/i, "");
      expect(bearer).toBeDefined();
      expect(yield* oauth.acceptsAccessToken(bearer!)).toBe(true);
      const calls = refreshTokenRequests(yield* oauth.requests);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.get("refresh_token")).toBe(initialTokens.refreshToken);

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
      const { executor, scopeId, openApiServer } = yield* makeExecutor();
      const oauth = yield* serveOAuthTestServer({
        defaultClientId: "abc",
        defaultClientSecret: "shhh",
      });
      const initialTokens = yield* oauth.completeAuthorizationCodeTokenFlow();
      expect(initialTokens.refreshToken).toBeDefined();
      yield* oauth.clearRequests;

      const auth = yield* seedExpiredConnection(
        executor,
        scopeId,
        "conn-refresh-concurrent",
        oauth.tokenEndpoint,
        initialTokens.refreshToken!,
      );

      yield* addOpenApiTestSource(executor, openApiServer, {
        scope: String(scopeId),
        namespace: "petstore",
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
        const res = unwrapInvocation(r);
        expect(res.error).toBeNull();
        const bearer = (res.data as EchoHeaders | null)?.authorization?.replace(/^Bearer\s+/i, "");
        expect(bearer).toBeDefined();
        expect(yield* oauth.acceptsAccessToken(bearer!)).toBe(true);
      }
      // Critical assertion: the SDK's dedup collapses every parallel
      // invoke into one call to the token endpoint. Anything more
      // means we're hammering the AS under load.
      const calls = refreshTokenRequests(yield* oauth.requests);
      expect(calls).toHaveLength(1);
    }),
  );

  it.effect("invalid_grant from refresh surfaces as ConnectionReauthRequiredError", () =>
    Effect.gen(function* () {
      const { executor, scopeId, openApiServer } = yield* makeExecutor();
      const oauth = yield* serveOAuthTestServer({
        defaultClientId: "abc",
        defaultClientSecret: "shhh",
        supportRefresh: false,
      });

      const auth = yield* seedExpiredConnection(
        executor,
        scopeId,
        "conn-refresh-dead",
        oauth.tokenEndpoint,
        "refresh-v1",
      );

      yield* addOpenApiTestSource(executor, openApiServer, {
        scope: String(scopeId),
        namespace: "petstore",
        oauth2: auth,
      });
      yield* bindOAuthConnection(executor, scopeId, "conn-refresh-dead", auth);

      const invocation = yield* executor.tools.invoke(
        "petstore.items.echoHeaders",
        {},
        autoApprove,
      );
      expect(invocation).toMatchObject({
        ok: false,
        error: {
          code: "oauth_reauth_required",
          message: expect.stringContaining("needs re-authentication"),
          details: {
            category: "authentication",
            recovery: {
              startOAuthTool: "executor.coreTools.oauth.start",
            },
          },
        },
      });

      const flipped = yield* executor.connections.accessToken("conn-refresh-dead").pipe(
        Effect.flip,
        Effect.flatMap((error) =>
          Predicate.isTagged("ConnectionReauthRequiredError")(error)
            ? Effect.succeed(error)
            : Effect.fail(error),
        ),
      );
      expect(flipped.provider).toBe(OAUTH2_PROVIDER_KEY);
      expect(flipped.message).toMatch(/OAuth refresh failed: .*Unknown refresh token/i);
    }),
  );
});
