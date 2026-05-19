// ---------------------------------------------------------------------------
// End-to-end test for the OAuth2 `client_credentials` grant on an OpenAPI
// source. A spec that declares ONLY a `clientCredentials` flow (no
// authorizationCode, no user-interactive popup, no PKCE) mints a completed
// Connection through the shared OAuth service; `ctx.connections.accessToken`
// then resolves the bearer at invoke time.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { FetchHttpClient, HttpServerRequest } from "effect/unstable/http";

import {
  ConnectionId,
  createExecutor,
  definePlugin,
  Scope,
  ScopeId,
  SecretId,
  SetSecretInput,
  SetSourceCredentialBindingInput,
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

class OpenApiClientCredentialsTestSetupError extends Schema.TaggedErrorClass<OpenApiClientCredentialsTestSetupError>()(
  "OpenApiClientCredentialsTestSetupError",
  {
    message: Schema.String,
  },
) {}

// ---------------------------------------------------------------------------
// Test API — single endpoint that echoes the Authorization header.
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

const tokenEndpointRequests = (
  requests: readonly { readonly path: string; readonly body: string }[],
) =>
  requests
    .filter((request) => request.path === "/token")
    .map((request) => new URLSearchParams(request.body));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenAPI client_credentials OAuth", () => {
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
      const openApiServer = yield* serveOpenApiHttpApiTestServer({
        api: TestApi,
        handlersLayer: ItemsGroupLive,
      });
      const plugins = [
        openApiPlugin({ httpClientLayer: clientLayer }),
        memorySecretsPlugin(),
      ] as const;

      const now = new Date();
      const orgScope = Scope.make({
        id: ScopeId.make("org"),
        name: "acme-org",
        createdAt: now,
      });
      const userScope = Scope.make({
        id: ScopeId.make("user-alice"),
        name: "alice",
        createdAt: now,
      });
      const config = makeTestConfig({ plugins, scopes: [userScope, orgScope] });

      const adminExec = yield* createExecutor({
        ...config,
        scopes: [orgScope],
        plugins,
        onElicitation: "accept-all",
      });
      const userExec = yield* createExecutor({
        ...config,
        scopes: [userScope, orgScope],
        plugins,
        onElicitation: "accept-all",
      });

      // Admin seeds the shared client_id + client_secret at the org.
      yield* adminExec.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("petstore_client_id"),
          scope: orgScope.id,
          name: "Petstore Client ID",
          value: "client-abc",
        }),
      );
      yield* adminExec.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("petstore_client_secret"),
          scope: orgScope.id,
          name: "Petstore Client Secret",
          value: "secret-xyz",
        }),
      );

      const oauth = yield* serveOAuthTestServer({
        defaultClientId: "client-abc",
        defaultClientSecret: "secret-xyz",
      });

      // ------------------------------------------------------------
      // Shared OAuth start for clientCredentials: no authorizationUrl,
      // no popup, no complete. The OAuth service exchanges tokens
      // inline and creates the Connection.
      // ------------------------------------------------------------
      const connectionId = "openapi-oauth2-app-petstore";
      const started = yield* userExec.oauth.start({
        endpoint: oauth.tokenEndpoint,
        redirectUrl: oauth.tokenEndpoint,
        connectionId,
        tokenScope: String(userScope.id),
        pluginId: "openapi",
        identityLabel: "Petstore OAuth",
        strategy: {
          kind: "client-credentials",
          tokenEndpoint: oauth.tokenEndpoint,
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
      const oauth2 = OAuth2SourceConfig.make({
        kind: "oauth2",
        securitySchemeName: "oauth2",
        flow: "clientCredentials",
        tokenUrl: oauth.tokenEndpoint,
        authorizationUrl: null,
        clientIdSlot: "oauth2:oauth2:client-id",
        clientSecretSlot: "oauth2:oauth2:client-secret",
        connectionSlot: "oauth2:oauth2:connection",
        scopes: ["data"],
      });
      expect(completedConnection.connectionId).toBe(connectionId);

      // Token endpoint call is RFC 6749 §4.4 compliant.
      const calls = tokenEndpointRequests(yield* oauth.requests);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.get("grant_type")).toBe("client_credentials");
      expect(calls[0]!.get("client_id")).toBe("client-abc");
      expect(calls[0]!.get("client_secret")).toBe("secret-xyz");
      expect(calls[0]!.get("scope")).toBe("data");

      // Add the source with source-owned OAuth structure, then bind the
      // per-user connection into the configured slot.
      yield* addOpenApiTestSource(userExec, openApiServer, {
        scope: userScope.id,
        namespace: "petstore",
        oauth2,
      });
      const storedSourceRow = yield* Effect.promise(() =>
        config.db.findFirst("plugin_storage", {
          where: (b) =>
            b.and(
              b("scope_id", "=", String(userScope.id)),
              b("plugin_id", "=", "openapi"),
              b("collection", "=", "source"),
              b("key", "=", "petstore"),
            ),
        }),
      );
      const storedData = storedSourceRow?.data as
        | {
            readonly config?: Record<string, unknown>;
          }
        | undefined;
      const storedOAuth2 = storedData?.config?.oauth2;
      if (
        !storedSourceRow ||
        !storedData?.config ||
        typeof storedOAuth2 !== "object" ||
        storedOAuth2 === null ||
        Array.isArray(storedOAuth2)
      ) {
        return yield* new OpenApiClientCredentialsTestSetupError({
          message: "Expected stored OpenAPI source OAuth config",
        });
      }
      const { authorizationUrl: _authorizationUrl, ...oauth2WithoutAuthorizationUrl } =
        storedOAuth2 as Record<string, unknown>;
      yield* Effect.promise(() =>
        config.db.updateMany("plugin_storage", {
          where: (b) =>
            b.and(
              b("scope_id", "=", String(userScope.id)),
              b("plugin_id", "=", "openapi"),
              b("collection", "=", "source"),
              b("key", "=", "petstore"),
            ),
          set: {
            data: {
              ...storedData,
              config: {
                ...storedData.config,
                oauth2: oauth2WithoutAuthorizationUrl,
              },
            },
          },
        }),
      );
      const sourceAfterLegacyShape = yield* userExec.openapi.getSource(
        "petstore",
        String(userScope.id),
      );
      expect(sourceAfterLegacyShape?.config.oauth2?.authorizationUrl).toBeNull();

      yield* userExec.sources.setBinding(
        SetSourceCredentialBindingInput.make({
          source: { id: "petstore", scope: userScope.id },
          scope: userScope.id,
          slotKey: oauth2.connectionSlot,
          value: {
            kind: "connection",
            connectionId: ConnectionId.make(completedConnection.connectionId),
          },
        }),
      );
      // Invoking the tool injects the freshly-minted bearer via
      // ctx.connections.accessToken.
      const result = unwrapInvocation(
        yield* userExec.tools.invoke("petstore.items.echoHeaders", {}, autoApprove),
      );
      expect(result.error).toBeNull();
      const data = result.data as EchoHeaders | null;
      const bearer = data?.authorization?.replace(/^Bearer\s+/i, "");
      expect(bearer).toBeDefined();
      expect(yield* oauth.acceptsAccessToken(bearer!)).toBe(true);

      // The connection lives at the innermost (user) scope, which
      // preserves per-user credential resolution: if each user has
      // their own OAuth client credentials shadowed at their user
      // scope, each user mints their own token. A single shared
      // connection slot still lets every caller reach the right
      // physical row through scoped credential bindings.
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
