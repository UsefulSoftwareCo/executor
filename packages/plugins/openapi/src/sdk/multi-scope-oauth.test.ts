// ---------------------------------------------------------------------------
// End-to-end shape test for multi-scope OAuth on the OpenAPI plugin.
//
// Models the production scenario: an org-level admin uploads the shared
// client credentials, each member of the org runs their own OAuth flow,
// and each member's access token lives on a per-user Connection. The
// Connections primitive owns every secret — they're filtered out of the
// user-facing `secrets.list()` automatically.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Predicate, Schema } from "effect";
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
  type InvokeOptions,
  type SecretProvider,
} from "@executor-js/sdk";
import { makeTestConfig, serveOAuthTestServer } from "@executor-js/sdk/testing";
import {
  addOpenApiTestSource,
  serveOpenApiHttpApiTestServer,
} from "@executor-js/plugin-openapi/testing";

import { openApiPlugin } from "./plugin";
import { OAuth2SourceConfig, OpenApiSourceBindingInput } from "./types";

const autoApprove: InvokeOptions = { onElicitation: "accept-all" };

class TestInvariantError extends Data.TaggedError("TestInvariantError")<{
  readonly message: string;
}> {}

const makeOauth2SourceConfig = (params: {
  readonly flow: "authorizationCode" | "clientCredentials";
  readonly tokenUrl: string;
  readonly authorizationUrl: string | null;
  readonly scopes: readonly string[];
}): OAuth2SourceConfig =>
  OAuth2SourceConfig.make({
    kind: "oauth2",
    securitySchemeName: "oauth2",
    flow: params.flow,
    tokenUrl: params.tokenUrl,
    authorizationUrl: params.authorizationUrl,
    clientIdSlot: "oauth2:oauth2:client-id",
    clientSecretSlot: "oauth2:oauth2:client-secret",
    connectionSlot: "oauth2:oauth2:connection",
    scopes: [...params.scopes],
  });

// ---------------------------------------------------------------------------
// Test API — a single endpoint that echoes the Authorization header so the
// test can assert which user's token got injected.
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

describe("OpenAPI multi-scope OAuth", () => {
  it.effect("per-user Connections coexist with a shared org-level client credential", () =>
    Effect.gen(function* () {
      const secretStore = new Map<string, string>();
      const key = (scope: string, id: string) => `${scope} ${id}`;
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
      const config = makeTestConfig({ plugins });

      const now = new Date();
      const orgScope = Scope.make({
        id: ScopeId.make("org"),
        name: "acme-org",
        createdAt: now,
      });
      const aliceScope = Scope.make({
        id: ScopeId.make("user-alice"),
        name: "alice",
        createdAt: now,
      });
      const bobScope = Scope.make({
        id: ScopeId.make("user-bob"),
        name: "bob",
        createdAt: now,
      });

      const adminExec = yield* createExecutor({
        ...config,
        scopes: [orgScope],
        plugins,
        onElicitation: "accept-all",
      });
      const aliceExec = yield* createExecutor({
        ...config,
        scopes: [aliceScope, orgScope],
        plugins,
        onElicitation: "accept-all",
      });
      const bobExec = yield* createExecutor({
        ...config,
        scopes: [bobScope, orgScope],
        plugins,
        onElicitation: "accept-all",
      });

      // -------------------------------------------------------------
      // 1. Admin seeds the org-level client credentials.
      // -------------------------------------------------------------
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

      // -------------------------------------------------------------
      // 2. Each user runs startOAuth + centralized OAuth completion to mint a
      //    per-user Connection.
      // -------------------------------------------------------------
      const oauth = yield* serveOAuthTestServer({
        defaultClientId: "client-abc",
        defaultClientSecret: "secret-xyz",
      });

      const startInputFor = (user: string, scope: ScopeId) => ({
        sourceId: "petstore",
        displayName: `Petstore (${user})`,
        securitySchemeName: "oauth2",
        authorizationUrl: oauth.authorizationEndpoint,
        tokenUrl: oauth.tokenEndpoint,
        redirectUrl: "https://app.example.com/oauth/callback",
        clientIdSecretId: "petstore_client_id",
        clientSecretSecretId: "petstore_client_secret",
        scopes: ["read"],
        tokenScope: String(scope),
      });

      const startAuthorizationCode = (
        exec: typeof aliceExec,
        input: ReturnType<typeof startInputFor>,
      ) =>
        exec.oauth.start({
          endpoint: input.authorizationUrl,
          redirectUrl: input.redirectUrl,
          connectionId: `openapi-oauth2-user-${input.sourceId}`,
          tokenScope: input.tokenScope,
          pluginId: "openapi",
          identityLabel: `${input.displayName} OAuth`,
          strategy: {
            kind: "authorization-code",
            authorizationEndpoint: input.authorizationUrl,
            tokenEndpoint: input.tokenUrl,
            issuerUrl: null,
            clientIdSecretId: input.clientIdSecretId,
            clientSecretSecretId: input.clientSecretSecretId,
            scopes: input.scopes,
          },
        });

      const aliceStart = yield* startAuthorizationCode(
        aliceExec,
        startInputFor("alice", aliceScope.id),
      );
      const bobStart = yield* startAuthorizationCode(bobExec, startInputFor("bob", bobScope.id));
      if (aliceStart.authorizationUrl === null) {
        return yield* new TestInvariantError({
          message: "expected authorizationCode flow for alice",
        });
      }
      if (bobStart.authorizationUrl === null) {
        return yield* new TestInvariantError({
          message: "expected authorizationCode flow for bob",
        });
      }

      const aliceCallback = yield* oauth.completeAuthorizationCodeFlow({
        authorizationUrl: aliceStart.authorizationUrl,
      });
      const bobCallback = yield* oauth.completeAuthorizationCodeFlow({
        authorizationUrl: bobStart.authorizationUrl,
      });
      const aliceAuth = yield* aliceExec.oauth.complete({
        state: aliceStart.sessionId,
        code: aliceCallback.code,
      });
      const bobAuth = yield* bobExec.oauth.complete({
        state: bobStart.sessionId,
        code: bobCallback.code,
      });

      // With the stable-id fix both users derive the same row id
      // string from `sourceId`, but the rows live at different user
      // scopes (ids are only unique within a scope). The assertion
      // below that `adminConnectionIds` doesn't include either one
      // proves admin's stack can't reach either user's row.
      expect(aliceAuth.connectionId).toBe(bobAuth.connectionId);
      const oauth2 = makeOauth2SourceConfig({
        flow: "authorizationCode",
        tokenUrl: oauth.tokenEndpoint,
        authorizationUrl: oauth.authorizationEndpoint,
        scopes: ["read"],
      });

      // -------------------------------------------------------------
      // 3. Each user adds the spec with source-owned OAuth structure,
      //    then binds their own connection into the configured slot.
      // -------------------------------------------------------------
      yield* addOpenApiTestSource(aliceExec, openApiServer, {
        scope: String(aliceScope.id),
        namespace: "petstore",
        oauth2,
      });
      yield* aliceExec.openapi.setSourceBinding(
        OpenApiSourceBindingInput.make({
          sourceId: "petstore",
          sourceScope: aliceScope.id,
          scope: aliceScope.id,
          slot: oauth2.connectionSlot,
          value: { kind: "connection", connectionId: ConnectionId.make(aliceAuth.connectionId) },
        }),
      );
      yield* addOpenApiTestSource(bobExec, openApiServer, {
        scope: String(bobScope.id),
        namespace: "petstore",
        oauth2,
      });
      yield* bobExec.openapi.setSourceBinding(
        OpenApiSourceBindingInput.make({
          sourceId: "petstore",
          sourceScope: bobScope.id,
          scope: bobScope.id,
          slot: oauth2.connectionSlot,
          value: { kind: "connection", connectionId: ConnectionId.make(bobAuth.connectionId) },
        }),
      );

      // -------------------------------------------------------------
      // 4. Invoke through each exec — Authorization must carry that
      //    user's token.
      // -------------------------------------------------------------
      const aliceResult = (yield* aliceExec.tools.invoke(
        "petstore.items.echoHeaders",
        {},
        autoApprove,
      )) as { data: { authorization?: string } | null; error: unknown };
      expect(aliceResult.error).toBeNull();
      const aliceBearer = aliceResult.data?.authorization?.replace(/^Bearer\s+/i, "");
      expect(aliceBearer).toBeDefined();
      expect(yield* oauth.acceptsAccessToken(aliceBearer!)).toBe(true);

      const bobResult = (yield* bobExec.tools.invoke(
        "petstore.items.echoHeaders",
        {},
        autoApprove,
      )) as { data: { authorization?: string } | null; error: unknown };
      expect(bobResult.error).toBeNull();
      const bobBearer = bobResult.data?.authorization?.replace(/^Bearer\s+/i, "");
      expect(bobBearer).toBeDefined();
      expect(yield* oauth.acceptsAccessToken(bobBearer!)).toBe(true);
      expect(bobBearer).not.toBe(aliceBearer);

      // -------------------------------------------------------------
      // 5. Each user's Connection is scoped to them; admin sees none.
      // -------------------------------------------------------------
      const aliceConnections = yield* aliceExec.connections.list();
      const aliceConn = aliceConnections.find((c) => c.id === aliceAuth.connectionId);
      expect(String(aliceConn?.scopeId)).toBe("user-alice");

      const bobConnections = yield* bobExec.connections.list();
      const bobConn = bobConnections.find((c) => c.id === bobAuth.connectionId);
      expect(String(bobConn?.scopeId)).toBe("user-bob");

      const adminConnectionIds = new Set(
        (yield* adminExec.connections.list()).map((c) => String(c.id)),
      );
      expect(adminConnectionIds).not.toContain(String(aliceAuth.connectionId));
      expect(adminConnectionIds).not.toContain(String(bobAuth.connectionId));

      // -------------------------------------------------------------
      // 6. Connection-owned secrets are filtered from secrets.list().
      //    Alice only sees the org client creds; her access / refresh
      //    tokens are hidden behind the Connection primitive.
      // -------------------------------------------------------------
      const aliceSecretIds = new Set((yield* aliceExec.secrets.list()).map((s) => String(s.id)));
      expect(aliceSecretIds).toContain("petstore_client_id");
      expect(aliceSecretIds).toContain("petstore_client_secret");
      expect(aliceSecretIds).not.toContain(`${aliceAuth.connectionId}.access_token`);
      expect(aliceSecretIds).not.toContain(`${aliceAuth.connectionId}.refresh_token`);
    }),
  );

  // -------------------------------------------------------------------------
  // Regression: repeated `clientCredentials` sign-ins used to mint a fresh
  // random UUID per call AND rewrite `source.oauth2.connectionId` to that
  // new id, which meant whichever user signed in last owned the pointer
  // and everyone else's invocations broke (their scope stack couldn't
  // find the previous signer's row). Fix: the Connection id is now a
  // stable `openapi-oauth2-app-${sourceId}` *name* — the same string
  // across callers — written at the innermost (per-user) scope. Each
  // user's stack resolves that one name to their own physical row via
  // `findInnermostConnectionRow`, so shared source + per-user credentials
  // (secrets shadowed at user scope) keeps producing per-user tokens
  // without clobbering each other.
  // -------------------------------------------------------------------------
  it.effect("clientCredentials sign-in is per-user with a stable shared connection name", () =>
    Effect.gen(function* () {
      const secretStore = new Map<string, string>();
      const key = (scope: string, id: string) => `${scope} ${id}`;
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
      const config = makeTestConfig({ plugins });

      const now = new Date();
      const orgScope = Scope.make({
        id: ScopeId.make("org"),
        name: "acme-org",
        createdAt: now,
      });
      const aliceScope = Scope.make({
        id: ScopeId.make("user-alice"),
        name: "alice",
        createdAt: now,
      });
      const bobScope = Scope.make({
        id: ScopeId.make("user-bob"),
        name: "bob",
        createdAt: now,
      });

      const adminExec = yield* createExecutor({
        ...config,
        scopes: [orgScope],
        plugins,
        onElicitation: "accept-all",
      });
      const aliceExec = yield* createExecutor({
        ...config,
        scopes: [aliceScope, orgScope],
        plugins,
        onElicitation: "accept-all",
      });
      const bobExec = yield* createExecutor({
        ...config,
        scopes: [bobScope, orgScope],
        plugins,
        onElicitation: "accept-all",
      });

      // Org-wide default client_id at org scope. Alice then shadows
      // with her own value at user-alice — the common "per-user API
      // key that uses client_credentials as the wire protocol"
      // pattern. Bob doesn't shadow → he falls through to the org
      // default. This exercises scope-stacked secret resolution.
      yield* adminExec.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("client_id"),
          scope: orgScope.id,
          name: "Client ID",
          value: "org-client",
        }),
      );
      yield* adminExec.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("client_secret"),
          scope: orgScope.id,
          name: "Client Secret",
          value: "org-secret",
        }),
      );
      yield* aliceExec.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("client_id"),
          scope: aliceScope.id,
          name: "Alice Client ID",
          value: "alice-client",
        }),
      );
      yield* aliceExec.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("client_secret"),
          scope: aliceScope.id,
          name: "Alice Client Secret",
          value: "alice-secret",
        }),
      );

      const oauth = yield* serveOAuthTestServer({
        defaultClientId: "org-client",
        defaultClientSecret: "org-secret",
        clients: {
          "alice-client": "alice-secret",
        },
      });

      const startInput = {
        connectionId: "shared-petstore-oauth",
        displayName: "Petstore",
        securitySchemeName: "oauth2",
        tokenUrl: oauth.tokenEndpoint,
        clientIdSecretId: "client_id",
        clientSecretSecretId: "client_secret",
        scopes: ["read"],
      };
      const startClientCredentials = (
        exec: typeof adminExec,
        tokenScope: ScopeId,
        input: typeof startInput,
      ) =>
        Effect.gen(function* () {
          const started = yield* exec.oauth.start({
            endpoint: input.tokenUrl,
            redirectUrl: input.tokenUrl,
            connectionId: input.connectionId,
            tokenScope: String(tokenScope),
            pluginId: "openapi",
            identityLabel: `${input.displayName} OAuth`,
            strategy: {
              kind: "client-credentials",
              tokenEndpoint: input.tokenUrl,
              clientIdSecretId: input.clientIdSecretId,
              clientSecretSecretId: input.clientSecretSecretId,
              scopes: input.scopes,
            },
          });
          if (!started.completedConnection) {
            return yield* new TestInvariantError({ message: "expected clientCredentials flow" });
          }
          return started.completedConnection.connectionId;
        });

      const oauth2 = makeOauth2SourceConfig({
        flow: "clientCredentials",
        tokenUrl: oauth.tokenEndpoint,
        authorizationUrl: null,
        scopes: startInput.scopes,
      });

      // Admin adds the org-scoped source with source-owned OAuth structure.
      // Admin's scope stack is [org] so their sign-in resolves the org-level
      // creds and writes the connection at org, then the connection binding
      // is explicitly attached to the source slot.
      const adminAuth = yield* startClientCredentials(adminExec, orgScope.id, startInput);
      yield* addOpenApiTestSource(adminExec, openApiServer, {
        scope: String(orgScope.id),
        namespace: "petstore",
        oauth2,
      });
      yield* adminExec.openapi.setSourceBinding(
        OpenApiSourceBindingInput.make({
          sourceId: "petstore",
          sourceScope: orgScope.id,
          scope: orgScope.id,
          slot: oauth2.connectionSlot,
          value: { kind: "connection", connectionId: ConnectionId.make(adminAuth) },
        }),
      );

      // Alice signs in → resolves her shadowed user-scope creds
      // (`alice-client`), mints her own token, writes at user-alice.
      const aliceAuth = yield* startClientCredentials(aliceExec, aliceScope.id, startInput);
      // Bob signs in → no user-scope shadow, falls through to the
      // org defaults (`org-client`), writes at user-bob.
      const bobAuth = yield* startClientCredentials(bobExec, bobScope.id, startInput);
      yield* aliceExec.openapi.setSourceBinding(
        OpenApiSourceBindingInput.make({
          sourceId: "petstore",
          sourceScope: orgScope.id,
          scope: aliceScope.id,
          slot: oauth2.connectionSlot,
          value: { kind: "connection", connectionId: ConnectionId.make(aliceAuth) },
        }),
      );
      yield* bobExec.openapi.setSourceBinding(
        OpenApiSourceBindingInput.make({
          sourceId: "petstore",
          sourceScope: orgScope.id,
          scope: bobScope.id,
          slot: oauth2.connectionSlot,
          value: { kind: "connection", connectionId: ConnectionId.make(bobAuth) },
        }),
      );

      // ---- Regression assertions ----

      // (1) All three startOAuth calls return the SAME connection
      // id — it's a stable *name* carried by the source config. No
      // UUID-per-click churn, and the id does not have to be tied to
      // the source namespace.
      const stableId = startInput.connectionId;
      expect(adminAuth).toBe(stableId);
      expect(aliceAuth).toBe(stableId);
      expect(bobAuth).toBe(stableId);

      // (2) Each user's physical row lives at their own scope. The
      // id *string* collides across scopes intentionally — the source
      // carries a shared connection slot, and each caller resolves their
      // own scoped binding for that slot.
      const aliceConn = (yield* aliceExec.connections.list()).find(
        (c) => c.id === stableId && String(c.scopeId) === "user-alice",
      );
      const bobConn = (yield* bobExec.connections.list()).find(
        (c) => c.id === stableId && String(c.scopeId) === "user-bob",
      );
      const orgConn = (yield* adminExec.connections.list()).find((c) => c.id === stableId);
      expect(aliceConn).toBeDefined();
      expect(bobConn).toBeDefined();
      expect(orgConn).toBeDefined();
      expect(String(orgConn?.scopeId)).toBe("org");

      // (3) Scope-stacked secret resolution produced per-user tokens.
      // The exchange call Alice made used her shadowed value; Bob's
      // fell through to the org default.
      const tokenCalls = tokenEndpointRequests(yield* oauth.requests)
        .map((request) => request.get("client_id"))
        .filter(Predicate.isNotNull);
      expect(tokenCalls).toContain("alice-client");
      expect(tokenCalls.filter((v) => v === "org-client").length).toBeGreaterThan(0);

      // (4) Each user's invocation resolves their OWN row and gets
      // their OWN token — not whatever the last signer happened to
      // mint. This is the core multi-user regression.
      const aliceResult = (yield* aliceExec.tools.invoke(
        "petstore.items.echoHeaders",
        {},
        autoApprove,
      )) as { data: { authorization?: string } | null; error: unknown };
      expect(aliceResult.error).toBeNull();
      const aliceBearer = aliceResult.data?.authorization?.replace(/^Bearer\s+/i, "");
      expect(aliceBearer).toBeDefined();
      expect(yield* oauth.acceptsAccessToken(aliceBearer!)).toBe(true);

      const bobResult = (yield* bobExec.tools.invoke(
        "petstore.items.echoHeaders",
        {},
        autoApprove,
      )) as { data: { authorization?: string } | null; error: unknown };
      expect(bobResult.error).toBeNull();
      const bobBearer = bobResult.data?.authorization?.replace(/^Bearer\s+/i, "");
      expect(bobBearer).toBeDefined();
      expect(yield* oauth.acceptsAccessToken(bobBearer!)).toBe(true);
      expect(bobBearer).not.toBe(aliceBearer);

      // (5) Alice's sign-in is idempotent per-user — a repeat click
      // refreshes her one row instead of piling on orphans.
      const countBefore = (yield* aliceExec.connections.list()).filter(
        (c) => c.id === stableId,
      ).length;
      yield* startClientCredentials(aliceExec, aliceScope.id, startInput);
      const countAfter = (yield* aliceExec.connections.list()).filter(
        (c) => c.id === stableId,
      ).length;
      expect(countAfter).toBe(countBefore);
    }),
  );
});
