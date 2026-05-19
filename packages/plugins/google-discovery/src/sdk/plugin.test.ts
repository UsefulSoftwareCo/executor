import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  ConnectionId,
  CreateConnectionInput,
  createExecutor,
  Scope,
  ScopeId,
  SecretId,
  SetSecretInput,
  TokenMaterial,
  type InvokeOptions,
} from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";

import { googleDiscoveryPlugin } from "./plugin";

const autoApprove: InvokeOptions = { onElicitation: "accept-all" };

const fixturePath = resolve(__dirname, "../../fixtures/drive.json");
const fixtureText = readFileSync(fixturePath, "utf8");
const DiscoveryFixtureJson = Schema.Record(Schema.String, Schema.Unknown);
const fixtureJson = Schema.decodeUnknownSync(Schema.fromJsonString(DiscoveryFixtureJson))(
  fixtureText,
);

// ---------------------------------------------------------------------------
// Test HTTP server — serves the discovery document and echoes API calls.
// ---------------------------------------------------------------------------

interface ServerHandle {
  readonly baseUrl: string;
  readonly discoveryUrl: string;
  readonly requests: Array<{
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>;
  readonly close: () => Promise<void>;
}

const startServer = (): Promise<ServerHandle> =>
  new Promise((resolvePromise, rejectPromise) => {
    const requests: ServerHandle["requests"] = [];

    const server: Server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const url = request.url ?? "/";

      requests.push({
        method: request.method ?? "GET",
        url,
        headers: request.headers,
        body,
      });

      if (url === "/$discovery/rest?version=v3") {
        const address = server.address();
        if (!address || typeof address === "string") {
          response.statusCode = 500;
          response.end();
          return;
        }
        const dynamicFixture = JSON.stringify({
          ...fixtureJson,
          rootUrl: `http://127.0.0.1:${address.port}/`,
        });
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(dynamicFixture);
        return;
      }

      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: "123", name: "Quarterly Plan" }));
    });

    server.listen(0, "127.0.0.1", (error?: Error) => {
      if (error) {
        // oxlint-disable-next-line executor/no-promise-reject -- boundary: node listen callback reports startup failure through Promise adapter
        rejectPromise(error);
        return;
      }
      const address = server.address();
      if (!address || typeof address === "string") {
        // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: node listen callback reports startup failure through Promise adapter
        rejectPromise(new Error("Failed to resolve test server address"));
        return;
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      resolvePromise({
        baseUrl,
        discoveryUrl: `${baseUrl}/$discovery/rest?version=v3`,
        requests,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            // oxlint-disable-next-line executor/no-promise-reject -- boundary: node close callback reports shutdown failure through Promise adapter
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
          }),
      });
    });
  });

const TestServer = Effect.acquireRelease(
  Effect.promise(() => startServer()),
  (handle) => Effect.promise(() => handle.close()).pipe(Effect.ignore),
);

// ---------------------------------------------------------------------------
// Memory secret provider plugin — lets the test store secrets with
// `executor.secrets.set` / `ctx.secrets.set`. Without this there's no
// writable provider registered against the test executor.
// ---------------------------------------------------------------------------

import { definePlugin, type SecretProvider } from "@executor-js/sdk";

const makeMemorySecretsPlugin = () => {
  const store = new Map<string, string>();
  const provider: SecretProvider = {
    key: "memory",
    writable: true,
    get: (id, scope) => Effect.sync(() => store.get(`${scope}\u0000${id}`) ?? null),
    set: (id, value, scope) =>
      Effect.sync(() => {
        store.set(`${scope}\u0000${id}`, value);
      }),
    delete: (id, scope) => Effect.sync(() => store.delete(`${scope}\u0000${id}`)),
    list: () =>
      Effect.sync(() =>
        Array.from(store.keys()).map((k) => {
          const name = k.split("\u0000", 2)[1] ?? k;
          return { id: name, name };
        }),
      ),
  };
  return definePlugin(() => ({
    id: "memory-secrets" as const,
    storage: () => ({}),
    secretProviders: [provider],
  }));
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Google Discovery plugin", () => {
  it.effect("normalizes legacy googleapis discovery urls", () =>
    Effect.gen(function* () {
      const executor = yield* Effect.acquireRelease(
        createExecutor(
          makeTestConfig({
            plugins: [makeMemorySecretsPlugin()(), googleDiscoveryPlugin()] as const,
          }),
        ),
        (executor) => executor.close().pipe(Effect.ignore),
      );

      const originalFetch = globalThis.fetch;
      const fetchMock = yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(globalThis, "fetch").mockImplementation(((
            input: RequestInfo | URL,
            init?: RequestInit,
          ) => {
            const url =
              typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.toString()
                  : input.url;
            if (url === "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest") {
              return Promise.resolve(
                new Response(fixtureText, {
                  status: 200,
                  headers: { "content-type": "application/json" },
                }),
              );
            }
            return originalFetch(input, init);
          }) as typeof fetch),
        ),
        (mock) => Effect.sync(() => mock.mockRestore()),
      );

      const result = yield* executor.googleDiscovery.probeDiscovery(
        "https://drive.googleapis.com/$discovery/rest?version=v3",
      );
      expect(result.service).toBe("drive");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    }),
  );

  // OAuth start/complete are driven via ctx.oauth now — the UI stitches
  // the strategy config (Google endpoints + extras) and calls the shared
  // /scopes/:scopeId/oauth/{start,complete} surface. The connection id
  // is chosen client-side and stamped onto the source's auth config.

  it.effect("starts oauth using caller-supplied discovery scopes", () =>
    Effect.gen(function* () {
      const handle = yield* TestServer;
      const executor = yield* Effect.acquireRelease(
        createExecutor(
          makeTestConfig({
            plugins: [makeMemorySecretsPlugin()(), googleDiscoveryPlugin()] as const,
          }),
        ),
        (executor) => executor.close().pipe(Effect.ignore),
      );

      yield* executor.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("google-client-id"),
          scope: "test-scope" as SetSecretInput["scope"],
          name: "Google Client ID",
          value: "client-123",
        }),
      );

      const connectionId = "google-discovery-oauth2-test-start";
      const result = yield* executor.oauth.start({
        endpoint: handle.discoveryUrl,
        redirectUrl: "http://localhost/callback",
        connectionId,
        tokenScope: "test-scope",
        strategy: {
          kind: "authorization-code",
          authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenEndpoint: "https://oauth2.googleapis.com/token",
          clientIdSecretId: "google-client-id",
          clientSecretSecretId: null,
          scopes: ["https://www.googleapis.com/auth/drive"],
          extraAuthorizationParams: {
            access_type: "offline",
            include_granted_scopes: "true",
            prompt: "consent",
          },
        },
        pluginId: "google-discovery",
      });

      expect(result.authorizationUrl).not.toBeNull();
      const authorizationUrl = new URL(result.authorizationUrl ?? "about:blank");
      expect(authorizationUrl.searchParams.get("client_id")).toBe("client-123");
      expect(authorizationUrl.searchParams.get("access_type")).toBe("offline");
      expect(authorizationUrl.searchParams.get("prompt")).toBe("consent");
      expect(authorizationUrl.searchParams.get("scope")).toBe(
        "https://www.googleapis.com/auth/drive",
      );
    }),
  );

  it.effect("completes oauth and stores token secrets on a connection", () =>
    Effect.gen(function* () {
      const handle = yield* TestServer;
      const executor = yield* Effect.acquireRelease(
        createExecutor(
          makeTestConfig({
            plugins: [makeMemorySecretsPlugin()(), googleDiscoveryPlugin()] as const,
          }),
        ),
        (executor) => executor.close().pipe(Effect.ignore),
      );

      yield* executor.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("google-client-id"),
          scope: "test-scope" as SetSecretInput["scope"],
          name: "Google Client ID",
          value: "client-123",
        }),
      );
      yield* executor.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("google-client-secret"),
          scope: "test-scope" as SetSecretInput["scope"],
          name: "Google Client Secret",
          value: "client-secret-value",
        }),
      );

      const originalFetch = globalThis.fetch;
      let tokenRequestInit: RequestInit | undefined;
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(globalThis, "fetch").mockImplementation(((
            input: RequestInfo | URL,
            init?: RequestInit,
          ) => {
            const url =
              typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.toString()
                  : input.url;
            if (url === "https://oauth2.googleapis.com/token") {
              tokenRequestInit = init;
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    access_token: "access-token-value",
                    refresh_token: "refresh-token-value",
                    token_type: "Bearer",
                    expires_in: 3600,
                    scope: "https://www.googleapis.com/auth/drive",
                  }),
                  { status: 200, headers: { "content-type": "application/json" } },
                ),
              );
            }
            return originalFetch(input, init);
          }) as typeof fetch),
        ),
        (mock) => Effect.sync(() => mock.mockRestore()),
      );

      const connectionId = "google-discovery-oauth2-test-complete";
      const started = yield* executor.oauth.start({
        endpoint: handle.discoveryUrl,
        redirectUrl: "http://localhost/callback",
        connectionId,
        tokenScope: "test-scope",
        strategy: {
          kind: "authorization-code",
          authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenEndpoint: "https://oauth2.googleapis.com/token",
          clientIdSecretId: "google-client-id",
          clientSecretSecretId: "google-client-secret",
          scopes: ["https://www.googleapis.com/auth/drive"],
          extraAuthorizationParams: {
            access_type: "offline",
            include_granted_scopes: "true",
            prompt: "consent",
          },
        },
        pluginId: "google-discovery",
      });

      const completed = yield* executor.oauth.complete({
        state: started.sessionId,
        code: "code-123",
      });

      expect(completed.connectionId).toBe(connectionId);
      expect(tokenRequestInit?.method).toBe("POST");

      // Tokens live on the SDK connection — resolving via
      // ctx.connections.accessToken returns the minted value.
      const accessToken = yield* executor.connections.accessToken(
        completed.connectionId as Parameters<typeof executor.connections.accessToken>[0],
      );
      expect(accessToken).toBe("access-token-value");

      // Backing access-token secret is owned by the connection, so
      // it's filtered out of the user-facing secret list.
      const secretIds = new Set((yield* executor.secrets.list()).map((s) => String(s.id)));
      expect(secretIds).not.toContain(`${completed.connectionId}.access_token`);
      expect(secretIds).not.toContain(`${completed.connectionId}.refresh_token`);
    }),
  );

  it.effect("registers and invokes google discovery tools with oauth headers", () =>
    Effect.gen(function* () {
      const handle = yield* TestServer;
      const executor = yield* Effect.acquireRelease(
        createExecutor(
          makeTestConfig({
            plugins: [makeMemorySecretsPlugin()(), googleDiscoveryPlugin()] as const,
          }),
        ),
        (executor) => executor.close().pipe(Effect.ignore),
      );

      // A connection wraps the access token (+ optional refresh) and
      // the invoke path resolves via ctx.connections.accessToken.
      const connectionId = ConnectionId.make("google-discovery-oauth2-test");
      yield* executor.connections.create(
        CreateConnectionInput.make({
          id: connectionId,
          scope: ScopeId.make("test-scope"),
          provider: "oauth2",
          identityLabel: "Drive Test",
          accessToken: TokenMaterial.make({
            secretId: SecretId.make(`${connectionId}.access_token`),
            name: "Drive Access Token",
            value: "secret-token",
          }),
          refreshToken: null,
          expiresAt: null,
          oauthScope: null,
          providerState: {
            clientIdSecretId: "drive-client-id",
            clientSecretSecretId: null,
            scopes: ["https://www.googleapis.com/auth/drive.readonly"],
          },
        }),
      );

      const result = yield* executor.googleDiscovery.addSource({
        name: "Google Drive",
        scope: "test-scope",
        discoveryUrl: handle.discoveryUrl,
        namespace: "drive",
        auth: {
          kind: "oauth2",
          connectionId,
          clientIdSecretId: "drive-client-id",
          clientSecretSecretId: null,
          scopes: ["https://www.googleapis.com/auth/drive.readonly"],
        },
      });

      expect(result.toolCount).toBe(2);
      expect((yield* executor.tools.list()).map((tool) => tool.id)).toEqual(
        expect.arrayContaining([
          "executor.googleDiscovery.probeDiscovery",
          "executor.googleDiscovery.addSource",
          "executor.googleDiscovery.getSource",
          "executor.googleDiscovery.configureSource",
        ]),
      );

      const inspected = yield* executor.tools.invoke(
        "executor.googleDiscovery.getSource",
        { namespace: "drive", scope: "test-scope" },
        autoApprove,
      );
      expect(inspected).toMatchObject({
        ok: true,
        data: { source: { namespace: "drive", scope: "test-scope" } },
      });

      const invocation = (yield* executor.tools.invoke(
        "drive.files.get",
        { fileId: "123", fields: "id,name", prettyPrint: true },
        autoApprove,
      )) as { readonly ok: true; readonly data: { status: number; data: unknown } };

      expect(invocation.ok).toBe(true);
      expect(invocation.data.data).toEqual({ id: "123", name: "Quarterly Plan" });

      const apiRequest = handle.requests.find((request) =>
        request.url.startsWith("/drive/v3/files/123"),
      );
      expect(apiRequest).toBeDefined();
      expect(apiRequest!.headers.authorization).toBe("Bearer secret-token");
      expect(apiRequest!.url).toContain("fields=id%2Cname");
      expect(apiRequest!.url).toContain("prettyPrint=true");
    }),
  );

  // -------------------------------------------------------------------------
  // Multi-scope shadowing — regression suite covering the bug class where
  // store reads/writes that don't pin scope_id collapse onto whichever visible
  // row wins first. Each
  // scenario is reproducible against the pre-fix store.
  // -------------------------------------------------------------------------

  const ORG_SCOPE = ScopeId.make("org-scope");
  const USER_SCOPE = ScopeId.make("user-scope");
  const ORG_SCOPE_STRING = String(ORG_SCOPE);
  const USER_SCOPE_STRING = String(USER_SCOPE);

  const stackedScopes = [
    Scope.make({ id: USER_SCOPE, name: "user", createdAt: new Date() }),
    Scope.make({ id: ORG_SCOPE, name: "org", createdAt: new Date() }),
  ] as const;

  it.effect("shadowed addSource does not wipe the outer-scope source", () =>
    Effect.gen(function* () {
      const handle = yield* TestServer;
      const executor = yield* Effect.acquireRelease(
        createExecutor(
          makeTestConfig({
            scopes: stackedScopes,
            plugins: [makeMemorySecretsPlugin()(), googleDiscoveryPlugin()] as const,
          }),
        ),
        (executor) => executor.close().pipe(Effect.ignore),
      );
      // Org-level base source
      yield* executor.googleDiscovery.addSource({
        name: "Org Drive",
        scope: ORG_SCOPE_STRING,
        discoveryUrl: handle.discoveryUrl,
        namespace: "shared",
        auth: { kind: "none" },
      });

      // Per-user shadow with the same namespace
      yield* executor.googleDiscovery.addSource({
        name: "User Drive",
        scope: USER_SCOPE_STRING,
        discoveryUrl: handle.discoveryUrl,
        namespace: "shared",
        auth: { kind: "none" },
      });

      const userView = yield* executor.googleDiscovery.getSource("shared", USER_SCOPE_STRING);
      const orgView = yield* executor.googleDiscovery.getSource("shared", ORG_SCOPE_STRING);

      // Both rows must coexist — innermost-wins reads come from the
      // executor; the store's scope-pinned getters return the exact row.
      expect(userView?.name).toBe("User Drive");
      expect(userView?.scope).toBe(USER_SCOPE_STRING);
      expect(orgView?.name).toBe("Org Drive");
      expect(orgView?.scope).toBe(ORG_SCOPE_STRING);
    }),
  );

  it.effect("removeSource on user shadow leaves the org row intact", () =>
    Effect.gen(function* () {
      const handle = yield* TestServer;
      const executor = yield* Effect.acquireRelease(
        createExecutor(
          makeTestConfig({
            scopes: stackedScopes,
            plugins: [makeMemorySecretsPlugin()(), googleDiscoveryPlugin()] as const,
          }),
        ),
        (executor) => executor.close().pipe(Effect.ignore),
      );
      yield* executor.googleDiscovery.addSource({
        name: "Org Drive",
        scope: ORG_SCOPE_STRING,
        discoveryUrl: handle.discoveryUrl,
        namespace: "shared",
        auth: { kind: "none" },
      });
      yield* executor.googleDiscovery.addSource({
        name: "User Drive",
        scope: USER_SCOPE_STRING,
        discoveryUrl: handle.discoveryUrl,
        namespace: "shared",
        auth: { kind: "none" },
      });

      yield* executor.googleDiscovery.removeSource("shared", USER_SCOPE_STRING);

      const userView = yield* executor.googleDiscovery.getSource("shared", USER_SCOPE_STRING);
      const orgView = yield* executor.googleDiscovery.getSource("shared", ORG_SCOPE_STRING);

      expect(userView).toBeNull();
      expect(orgView?.name).toBe("Org Drive");
    }),
  );

  it.effect("re-adding a user shadow does not wipe the org row's bindings", () =>
    Effect.gen(function* () {
      const handle = yield* TestServer;
      const executor = yield* Effect.acquireRelease(
        createExecutor(
          makeTestConfig({
            scopes: stackedScopes,
            plugins: [makeMemorySecretsPlugin()(), googleDiscoveryPlugin()] as const,
          }),
        ),
        (executor) => executor.close().pipe(Effect.ignore),
      );
      yield* executor.googleDiscovery.addSource({
        name: "Org Drive",
        scope: ORG_SCOPE_STRING,
        discoveryUrl: handle.discoveryUrl,
        namespace: "shared",
        auth: { kind: "none" },
      });
      // Add user shadow, then add it again — the internal
      // registerManifest sequence does a scope-pinned
      // removeBindingsBySource before re-upserting. Without pinning
      // scope, the inner re-add would wipe the org-level bindings
      // via fall-through.
      yield* executor.googleDiscovery.addSource({
        name: "User Drive v1",
        scope: USER_SCOPE_STRING,
        discoveryUrl: handle.discoveryUrl,
        namespace: "shared",
        auth: { kind: "none" },
      });
      yield* executor.googleDiscovery.addSource({
        name: "User Drive v2",
        scope: USER_SCOPE_STRING,
        discoveryUrl: handle.discoveryUrl,
        namespace: "shared",
        auth: { kind: "none" },
      });

      const userView = yield* executor.googleDiscovery.getSource("shared", USER_SCOPE_STRING);
      const orgView = yield* executor.googleDiscovery.getSource("shared", ORG_SCOPE_STRING);

      expect(userView?.name).toBe("User Drive v2");
      expect(userView?.scope).toBe(USER_SCOPE_STRING);
      expect(orgView?.name).toBe("Org Drive");
      expect(orgView?.scope).toBe(ORG_SCOPE_STRING);
    }),
  );

  // -------------------------------------------------------------------------
  // Usage tracking — refs land on auth_* columns and the credential
  // child tables. `usagesForSecret` / `usagesForConnection` should
  // surface them all.
  // -------------------------------------------------------------------------

  it.effect("usagesForSecret returns refs across auth + credential rows", () =>
    Effect.gen(function* () {
      const handle = yield* TestServer;
      const executor = yield* Effect.acquireRelease(
        createExecutor(
          makeTestConfig({
            plugins: [makeMemorySecretsPlugin()(), googleDiscoveryPlugin()] as const,
          }),
        ),
        (executor) => executor.close().pipe(Effect.ignore),
      );
      const connectionId = ConnectionId.make("google-discovery-oauth2-usages");
      yield* executor.connections.create(
        CreateConnectionInput.make({
          id: connectionId,
          scope: ScopeId.make("test-scope"),
          provider: "oauth2",
          identityLabel: "Drive Usages",
          accessToken: TokenMaterial.make({
            secretId: SecretId.make(`${connectionId}.access_token`),
            name: "Drive Access Token",
            value: "secret-token",
          }),
          refreshToken: null,
          expiresAt: null,
          oauthScope: null,
          providerState: null,
        }),
      );

      yield* executor.googleDiscovery.addSource({
        name: "Drive (Usages)",
        scope: "test-scope",
        discoveryUrl: handle.discoveryUrl,
        namespace: "drive_u",
        auth: {
          kind: "oauth2",
          connectionId,
          clientIdSecretId: "shared-secret",
          clientSecretSecretId: null,
          scopes: [],
        },
      });

      // The auth.client_id_secret_id alone holds `shared-secret`.
      const usages = yield* executor.secrets.usages(SecretId.make("shared-secret"));
      expect(usages.length).toBe(1);
      expect(usages[0]).toMatchObject({
        pluginId: "google-discovery",
        ownerKind: "google-discovery-source",
        ownerId: "drive_u",
        slot: "auth.oauth2.client_id",
      });

      const connUsages = yield* executor.connections.usages(connectionId);
      expect(connUsages.length).toBe(1);
      expect(connUsages[0].slot).toBe("auth.oauth2.connection");
    }),
  );
});
