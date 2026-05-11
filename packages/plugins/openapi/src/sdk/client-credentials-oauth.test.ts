// ---------------------------------------------------------------------------
// End-to-end test for the OAuth2 `client_credentials` grant on an OpenAPI
// source. A spec that declares ONLY a `clientCredentials` flow (no
// authorizationCode, no user-interactive popup, no PKCE) mints a completed
// Connection through the shared OAuth service; `ctx.connections.accessToken`
// then resolves the bearer at invoke time.
// ---------------------------------------------------------------------------

import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Ref, Schema } from "effect";
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
  collectSchemas,
  ConnectionId,
  createExecutor,
  definePlugin,
  makeInMemoryBlobStore,
  Scope,
  ScopeId,
  SecretId,
  SetSecretInput,
  type InvokeOptions,
  type SecretProvider,
} from "@executor-js/sdk";
import { serveTestHttpApp } from "@executor-js/sdk/testing";
import { makeMemoryAdapter } from "@executor-js/storage-core/testing/memory";

import { openApiPlugin } from "./plugin";
import { OAuth2SourceConfig, OpenApiSourceBindingInput } from "./types";

const autoApprove: InvokeOptions = { onElicitation: "accept-all" };

class OpenApiClientCredentialsTestSetupError extends Schema.TaggedErrorClass<OpenApiClientCredentialsTestSetupError>()(
  "OpenApiClientCredentialsTestSetupError",
  {
    message: Schema.String,
  },
) {}

// ---------------------------------------------------------------------------
// Test API — single endpoint that echoes the Authorization header.
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

type TokenCall = {
  readonly grantType: string | null;
  readonly clientId: string | null;
  readonly clientSecret: string | null;
  readonly scope: string | null;
};

const serveClientCredentialsTokenEndpoint = (args: {
  readonly accessTokens: readonly string[];
  readonly expiresIn?: number;
}) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<readonly TokenCall[]>([]);
    let callIndex = 0;
    const server = yield* serveTestHttpApp((request) =>
      Effect.gen(function* () {
        const params = new URLSearchParams(yield* request.text);
        yield* Ref.update(calls, (all) => [
          ...all,
          {
            grantType: params.get("grant_type"),
            clientId: params.get("client_id"),
            clientSecret: params.get("client_secret"),
            scope: params.get("scope"),
          },
        ]);
        const token =
          args.accessTokens[Math.min(callIndex, args.accessTokens.length - 1)] ?? "unknown";
        callIndex += 1;
        const body: Record<string, unknown> = {
          access_token: token,
          token_type: "Bearer",
        };
        if (typeof args.expiresIn === "number") body.expires_in = args.expiresIn;
        return HttpServerResponse.jsonUnsafe(body);
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
// Tests
// ---------------------------------------------------------------------------

layer(TestLayer)("OpenAPI client_credentials OAuth", (it) => {
  it.effect("startOAuth exchanges tokens inline and makes them usable at invoke time", () =>
    Effect.gen(function* () {
      const secretStore = new Map<string, string>();
      const key = (scope: string, id: string) => `${scope}:${id}`;
      const memoryProvider: SecretProvider = {
        key: "memory",
        writable: true,
        get: (id, scope) => Effect.sync(() => secretStore.get(key(scope, id)) ?? null),
        set: (id, value, scope) =>
          Effect.sync(() => {
            secretStore.set(key(scope, id), value);
          }),
        delete: (id, scope) => Effect.sync(() => secretStore.delete(key(scope, id))),
      };
      const memorySecretsPlugin = definePlugin(() => ({
        id: "memory-secrets" as const,
        storage: () => ({}),
        secretProviders: [memoryProvider],
      }));
      const clientLayer = FetchHttpClient.layer;
      const server = yield* HttpServer.HttpServer;
      const address = server.address;
      if (!("port" in address)) {
        return yield* new OpenApiClientCredentialsTestSetupError({
          message: "Test server must bind to TCP",
        });
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const plugins = [
        openApiPlugin({ httpClientLayer: clientLayer }),
        memorySecretsPlugin(),
      ] as const;

      const schema = collectSchemas(plugins);
      const adapter = makeMemoryAdapter({ schema });
      const blobs = makeInMemoryBlobStore();

      const now = new Date();
      const orgScope = new Scope({
        id: ScopeId.make("org"),
        name: "acme-org",
        createdAt: now,
      });
      const userScope = new Scope({
        id: ScopeId.make("user-alice"),
        name: "alice",
        createdAt: now,
      });

      const adminExec = yield* createExecutor({
        scopes: [orgScope],
        adapter,
        blobs,
        plugins,
        onElicitation: "accept-all",
      });
      const userExec = yield* createExecutor({
        scopes: [userScope, orgScope],
        adapter,
        blobs,
        plugins,
        onElicitation: "accept-all",
      });

      // Admin seeds the shared client_id + client_secret at the org.
      yield* adminExec.secrets.set(
        new SetSecretInput({
          id: SecretId.make("petstore_client_id"),
          scope: orgScope.id,
          name: "Petstore Client ID",
          value: "client-abc",
        }),
      );
      yield* adminExec.secrets.set(
        new SetSecretInput({
          id: SecretId.make("petstore_client_secret"),
          scope: orgScope.id,
          name: "Petstore Client Secret",
          value: "secret-xyz",
        }),
      );

      const tokenEndpoint = yield* serveClientCredentialsTokenEndpoint({
        accessTokens: ["alice-token-1"],
      });

      // ------------------------------------------------------------
      // Shared OAuth start for clientCredentials: no authorizationUrl,
      // no popup, no complete. The OAuth service exchanges tokens
      // inline and creates the Connection.
      // ------------------------------------------------------------
      const connectionId = "openapi-oauth2-app-petstore";
      const started = yield* userExec.oauth.start({
        endpoint: tokenEndpoint.tokenUrl,
        redirectUrl: tokenEndpoint.tokenUrl,
        connectionId,
        tokenScope: String(userScope.id),
        pluginId: "openapi",
        identityLabel: "Petstore OAuth",
        strategy: {
          kind: "client-credentials",
          tokenEndpoint: tokenEndpoint.tokenUrl,
          clientIdSecretId: "petstore_client_id",
          clientSecretSecretId: "petstore_client_secret",
          scopes: ["data"],
        },
      });

      const completedConnection = started.completedConnection;
      if (!completedConnection) {
        return yield* new OpenApiClientCredentialsTestSetupError({
          message: "Expected completed clientCredentials connection",
        });
      }
      const oauth2 = new OAuth2SourceConfig({
        kind: "oauth2",
        securitySchemeName: "oauth2",
        flow: "clientCredentials",
        tokenUrl: tokenEndpoint.tokenUrl,
        authorizationUrl: null,
        clientIdSlot: "oauth2:oauth2:client-id",
        clientSecretSlot: "oauth2:oauth2:client-secret",
        connectionSlot: "oauth2:oauth2:connection",
        scopes: ["data"],
      });
      expect(completedConnection.connectionId).toBe(connectionId);

      // Token endpoint call is RFC 6749 §4.4 compliant.
      const calls = yield* tokenEndpoint.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0]!.grantType).toBe("client_credentials");
      expect(calls[0]!.clientId).toBe("client-abc");
      expect(calls[0]!.clientSecret).toBe("secret-xyz");
      expect(calls[0]!.scope).toBe("data");

      // Add the source with source-owned OAuth structure, then bind the
      // per-user connection into the configured slot.
      yield* userExec.openapi.addSpec({
        spec: specJson,
        scope: userScope.id,
        namespace: "petstore",
        baseUrl,
        oauth2,
      });
      yield* userExec.openapi.setSourceBinding(
        new OpenApiSourceBindingInput({
          sourceId: "petstore",
          sourceScope: userScope.id,
          scope: userScope.id,
          slot: oauth2.connectionSlot,
          value: {
            kind: "connection",
            connectionId: ConnectionId.make(completedConnection.connectionId),
          },
        }),
      );
      // Invoking the tool injects the freshly-minted bearer via
      // ctx.connections.accessToken.
      const result = (yield* userExec.tools.invoke(
        "petstore.items.echoHeaders",
        {},
        autoApprove,
      )) as {
        data: { authorization?: string } | null;
        error: unknown;
      };
      expect(result.error).toBeNull();
      expect(result.data?.authorization).toBe("Bearer alice-token-1");

      // The connection lives at the innermost (user) scope, which
      // preserves per-user credential resolution: if each user has
      // their own `dealcloud_client_id`/`dealcloud_client_secret`
      // shadowed at their user scope, each user mints their own
      // token. A single shared connection slot still lets every caller
      // reach the right physical row through scoped credential bindings.
      const userConnections = yield* userExec.connections.list();
      const connection = userConnections.find((c) => c.id === completedConnection.connectionId);
      expect(connection).toBeDefined();
      expect(String(connection?.scopeId)).toBe("user-alice");
      expect(connection?.provider).toBe("oauth2");
      // Stable id derived from sourceId — no UUID-per-click churn.
      expect(completedConnection.connectionId).toBe("openapi-oauth2-app-petstore");

      // Access-token secret is owned by the connection and filtered
      // out of the user-facing secret list.
      const userSecretIds = new Set((yield* userExec.secrets.list()).map((s) => String(s.id)));
      expect(userSecretIds).toContain("petstore_client_id");
      expect(userSecretIds).toContain("petstore_client_secret");
      expect(userSecretIds).not.toContain(`${completedConnection.connectionId}.access_token`);

      // Admin scope sees neither alice's connection nor her token.
      const adminSecretIds = new Set((yield* adminExec.secrets.list()).map((s) => String(s.id)));
      expect(adminSecretIds).not.toContain(`${completedConnection.connectionId}.access_token`);
    }),
  );
});
