import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import {
  ConnectionId,
  CreateConnectionInput,
  TokenMaterial,
  createExecutor,
  Scope,
  ScopeId,
  SecretId,
  type ConnectionProvider,
  type SecretProvider,
  SetSecretInput,
  definePlugin,
} from "@executor-js/sdk";
import { makeTestWorkspaceLayer, TestWorkspace } from "@executor-js/sdk/testing";
import {
  addOpenApiTestSource,
  serveOpenApiHttpApiTestServer,
} from "@executor-js/plugin-openapi/testing";

import { openApiPlugin } from "./plugin";
import { OpenApiSourceBindingInput } from "./types";

const PingGroup = HttpApiGroup.make("default", { topLevel: true }).add(
  HttpApiEndpoint.get("ping", "/ping"),
);
const UsageApi = HttpApi.make("usageScopeIsolation").add(PingGroup);
const UsageGroupLive = HttpApiBuilder.group(UsageApi, "default", (handlers) =>
  handlers.handle("ping", () => Effect.void),
);

const memorySecretsPlugin = definePlugin(() => {
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
  };

  return {
    id: "test-memory-secrets" as const,
    storage: () => ({}),
    secretProviders: [provider],
  };
});

const connectionProviderPlugin = definePlugin(() => {
  const provider: ConnectionProvider = {
    key: "test-oauth",
  };

  return {
    id: "test-connection-provider" as const,
    storage: () => ({}),
    connectionProviders: [provider],
  };
});

const orgA = Scope.make({
  id: ScopeId.make("org-a"),
  name: "Org A",
  createdAt: new Date(),
});
const orgB = Scope.make({
  id: ScopeId.make("org-b"),
  name: "Org B",
  createdAt: new Date(),
});
const plugins = [memorySecretsPlugin(), connectionProviderPlugin(), openApiPlugin()] as const;

layer(makeTestWorkspaceLayer({ scopes: [orgA], plugins }), { timeout: "15 seconds" })(
  "OpenAPI usage scope isolation",
  (it) => {
    it.effect("secrets.usages does not expose binding rows outside the scope stack", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* serveOpenApiHttpApiTestServer({
            api: UsageApi,
            handlersLayer: UsageGroupLive,
          });
          const { config } = yield* TestWorkspace;
          const orgAExec = yield* createExecutor({ ...config, scopes: [orgA], plugins });
          const orgBExec = yield* createExecutor({ ...config, scopes: [orgB], plugins });
          const secretId = SecretId.make("org-a-api-key");

          yield* orgAExec.secrets.set(
            SetSecretInput.make({
              id: secretId,
              scope: orgA.id,
              name: "Org A API Key",
              value: "secret",
              provider: "memory",
            }),
          );
          yield* orgBExec.secrets.set(
            SetSecretInput.make({
              id: secretId,
              scope: orgB.id,
              name: "Org B API Key",
              value: "different-secret",
              provider: "memory",
            }),
          );
          yield* addOpenApiTestSource(orgAExec, server, {
            scope: String(orgA.id),
            namespace: "secret_private_source",
          });
          yield* orgAExec.openapi.setSourceBinding(
            OpenApiSourceBindingInput.make({
              sourceId: "secret_private_source",
              sourceScope: orgA.id,
              scope: orgA.id,
              slot: "header:authorization",
              value: { kind: "secret", secretId },
            }),
          );

          const usages = yield* orgBExec.secrets.usages(secretId);
          expect(usages).toEqual([]);
        }),
      ),
    );

    it.effect("connections.usages does not expose binding rows outside the scope stack", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* serveOpenApiHttpApiTestServer({
            api: UsageApi,
            handlersLayer: UsageGroupLive,
          });
          const { config } = yield* TestWorkspace;
          const orgAExec = yield* createExecutor({ ...config, scopes: [orgA], plugins });
          const orgBExec = yield* createExecutor({ ...config, scopes: [orgB], plugins });
          const connectionId = ConnectionId.make("org-a-connection");

          yield* orgAExec.connections.create(
            CreateConnectionInput.make({
              id: connectionId,
              scope: orgA.id,
              provider: "test-oauth",
              identityLabel: "Org A connection",
              accessToken: TokenMaterial.make({
                secretId: SecretId.make("org-a-connection-access"),
                name: "Org A access",
                value: "access",
              }),
              refreshToken: null,
              expiresAt: null,
              oauthScope: null,
              providerState: null,
            }),
          );
          yield* orgBExec.connections.create(
            CreateConnectionInput.make({
              id: connectionId,
              scope: orgB.id,
              provider: "test-oauth",
              identityLabel: "Org B connection",
              accessToken: TokenMaterial.make({
                secretId: SecretId.make("org-b-connection-access"),
                name: "Org B access",
                value: "access",
              }),
              refreshToken: null,
              expiresAt: null,
              oauthScope: null,
              providerState: null,
            }),
          );

          yield* addOpenApiTestSource(orgAExec, server, {
            scope: String(orgA.id),
            namespace: "connection_private_source",
          });
          yield* orgAExec.openapi.setSourceBinding(
            OpenApiSourceBindingInput.make({
              sourceId: "connection_private_source",
              sourceScope: orgA.id,
              scope: orgA.id,
              slot: "oauth:connection",
              value: { kind: "connection", connectionId },
            }),
          );

          const usages = yield* orgBExec.connections.usages(connectionId);
          expect(usages).toEqual([]);
        }),
      ),
    );
  },
);
