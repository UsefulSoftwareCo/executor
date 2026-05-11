import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";

import {
  ConnectionId,
  CreateConnectionInput,
  Scope,
  ScopeId,
  SecretId,
  SetSecretInput,
  TokenMaterial,
  createExecutor,
  definePlugin,
  makeTestConfig,
  type Executor,
} from "@executor-js/sdk";
import { memorySecretsPlugin } from "@executor-js/sdk/testing";

import { ExecutorApi } from "./api";
import { observabilityMiddleware } from "./observability";
import { CoreHandlers, ExecutionEngineService, ExecutorService } from "./server";

const webHandlerFor = (executor: Executor) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(ExecutorApi).pipe(
          Layer.provide(CoreHandlers),
          Layer.provide(observabilityMiddleware(ExecutorApi)),
          Layer.provide(Layer.succeed(ExecutorService)(executor)),
          Layer.provide(
            Layer.succeed(ExecutionEngineService)({} as ExecutionEngineService["Service"]),
          ),
          Layer.provideMerge(HttpServer.layerServices),
          Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
        ),
        { disableLogger: true },
      ),
    ),
    (web) => Effect.promise(() => web.dispose()),
  );

const handlerContextFor = (executor: Executor) =>
  Context.make(ExecutorService, executor).pipe(
    Context.add(ExecutionEngineService, {} as ExecutionEngineService["Service"]),
  );

const scope = (id: ScopeId, name: string) => new Scope({ id, name, createdAt: new Date() });

const connectionProviderPlugin = definePlugin(() => ({
  id: "test-connection-provider" as const,
  storage: () => ({}),
  connectionProviders: [{ key: "memory-connection" }],
}));

describe("core API explicit target scopes", () => {
  it.effect("policy update uses the row target scope instead of the route read scope", () =>
    Effect.gen(function* () {
      const userScope = ScopeId.make("api-user");
      const orgScope = ScopeId.make("api-org");
      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: [scope(userScope, "user"), scope(orgScope, "org")],
        }),
      );
      const web = yield* webHandlerFor(executor);
      const context = handlerContextFor(executor);

      const createResponse = yield* Effect.promise(() =>
        web.handler(
          new Request(`http://localhost/scopes/${userScope}/policies`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              targetScope: orgScope,
              pattern: "vercel.*",
              action: "require_approval",
            }),
          }),
          context,
        ),
      );
      expect(createResponse.status).toBe(200);
      const created = (yield* Effect.promise(() => createResponse.json())) as { id: string };

      const updateResponse = yield* Effect.promise(() =>
        web.handler(
          new Request(
            `http://localhost/scopes/${userScope}/policies/${encodeURIComponent(created.id)}`,
            {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                targetScope: orgScope,
                action: "block",
              }),
            },
          ),
          context,
        ),
      );

      expect(updateResponse.status).toBe(200);
      const policies = yield* executor.policies.list();
      expect(policies[0]).toMatchObject({
        id: created.id,
        scopeId: orgScope,
        action: "block",
      });
    }),
  );

  it.effect("connection remove deletes the route target scope row, not the innermost row", () =>
    Effect.gen(function* () {
      const userScope = ScopeId.make("api-user");
      const orgScope = ScopeId.make("api-org");
      const config = makeTestConfig({
        scopes: [scope(userScope, "user"), scope(orgScope, "org")],
        plugins: [memorySecretsPlugin(), connectionProviderPlugin()] as const,
      });
      const executor = yield* createExecutor(config);
      const web = yield* webHandlerFor(executor);
      const context = handlerContextFor(executor);
      const connectionId = ConnectionId.make("shared-connection");

      yield* executor.connections.create(
        new CreateConnectionInput({
          id: connectionId,
          scope: orgScope,
          provider: "memory-connection",
          identityLabel: "Org connection",
          accessToken: new TokenMaterial({
            secretId: SecretId.make("org-shared-connection.access_token"),
            name: "Org access token",
            value: "org-token",
          }),
          refreshToken: null,
          expiresAt: null,
          oauthScope: null,
          providerState: null,
        }),
      );
      yield* executor.connections.create(
        new CreateConnectionInput({
          id: connectionId,
          scope: userScope,
          provider: "memory-connection",
          identityLabel: "User connection",
          accessToken: new TokenMaterial({
            secretId: SecretId.make("user-shared-connection.access_token"),
            name: "User access token",
            value: "user-token",
          }),
          refreshToken: null,
          expiresAt: null,
          oauthScope: null,
          providerState: null,
        }),
      );

      const response = yield* Effect.promise(() =>
        web.handler(
          new Request(`http://localhost/scopes/${orgScope}/connections/${connectionId}`, {
            method: "DELETE",
          }),
          context,
        ),
      );

      expect(response.status).toBe(200);
      const rows = (yield* config.adapter.findMany({
        model: "connection",
        where: [{ field: "id", value: connectionId }],
      })) as ReadonlyArray<{ readonly scope_id: string }>;
      expect(rows.map((row) => row.scope_id).sort()).toEqual([String(userScope)]);
    }),
  );

  it.effect("OAuth start requires the route scope to match the requested token scope", () =>
    Effect.gen(function* () {
      const userScope = ScopeId.make("api-user");
      const orgScope = ScopeId.make("api-org");
      const config = makeTestConfig({
        scopes: [scope(userScope, "user"), scope(orgScope, "org")],
        plugins: [memorySecretsPlugin(), connectionProviderPlugin()] as const,
      });
      const executor = yield* createExecutor(config);
      const web = yield* webHandlerFor(executor);
      const context = handlerContextFor(executor);

      const response = yield* Effect.promise(() =>
        web.handler(
          new Request(`http://localhost/scopes/${userScope}/oauth/start`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              endpoint: "https://api.example.com",
              redirectUrl: "https://app.example.com/oauth/callback",
              connectionId: "example-oauth",
              tokenScope: orgScope,
              pluginId: "test-connection-provider",
              strategy: {
                kind: "authorization-code",
                authorizationEndpoint: "https://auth.example.com/oauth/authorize",
                tokenEndpoint: "https://auth.example.com/oauth/token",
                clientIdSecretId: "client-id",
                clientSecretSecretId: null,
                scopes: [],
              },
            }),
          }),
          context,
        ),
      );

      expect(response.status).toBe(400);
      const sessions = yield* config.adapter.findMany({ model: "oauth2_session" });
      expect(sessions).toEqual([]);
    }),
  );

  it.effect("OAuth complete requires the route scope to match the pending session scope", () =>
    Effect.gen(function* () {
      const userScope = ScopeId.make("api-user");
      const orgScope = ScopeId.make("api-org");
      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: [scope(userScope, "user"), scope(orgScope, "org")],
          plugins: [memorySecretsPlugin(), connectionProviderPlugin()] as const,
        }),
      );
      const web = yield* webHandlerFor(executor);
      const context = handlerContextFor(executor);

      yield* executor.secrets.set(
        new SetSecretInput({
          id: SecretId.make("client-id"),
          scope: userScope,
          name: "Client ID",
          value: "client-id-value",
        }),
      );
      const started = yield* executor.oauth.start({
        endpoint: "https://api.example.com",
        redirectUrl: "https://app.example.com/oauth/callback",
        connectionId: "example-oauth",
        tokenScope: String(userScope),
        pluginId: "test-connection-provider",
        strategy: {
          kind: "authorization-code",
          authorizationEndpoint: "https://auth.example.com/oauth/authorize",
          tokenEndpoint: "https://auth.example.com/oauth/token",
          clientIdSecretId: "client-id",
          clientSecretSecretId: null,
          scopes: [],
        },
      });

      const response = yield* Effect.promise(() =>
        web.handler(
          new Request(`http://localhost/scopes/${orgScope}/oauth/complete`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ state: started.sessionId, code: "code" }),
          }),
          context,
        ),
      );

      expect(response.status).toBe(404);
      const row = yield* executor.oauth
        .complete({
          state: started.sessionId,
          tokenScope: String(orgScope),
          error: "cancelled",
        })
        .pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: () => null,
          }),
        );
      expect(row).toMatchObject({ _tag: "OAuthSessionNotFoundError" });
    }),
  );
});
