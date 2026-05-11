import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  ConnectionId,
  CreateConnectionInput,
  TokenMaterial,
  createExecutor,
  makeTestConfig,
  Scope,
  ScopeId,
  SecretId,
  type ConnectionProvider,
  type SecretProvider,
  SetSecretInput,
  definePlugin,
} from "@executor-js/sdk";

import { openApiPlugin } from "./plugin";
import { OpenApiSourceBindingInput } from "./types";

const specJson = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Scoped Usage", version: "1.0.0" },
  paths: {
    "/ping": {
      get: { operationId: "ping", responses: { "200": { description: "ok" } } },
    },
  },
});

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

describe("OpenAPI usage scope isolation", () => {
  it.effect("secrets.usages does not expose binding rows outside the scope stack", () =>
    Effect.gen(function* () {
      const orgA = new Scope({
        id: ScopeId.make("org-a"),
        name: "Org A",
        createdAt: new Date(),
      });
      const orgB = new Scope({
        id: ScopeId.make("org-b"),
        name: "Org B",
        createdAt: new Date(),
      });
      const plugins = [memorySecretsPlugin(), openApiPlugin()] as const;
      const config = makeTestConfig({ scopes: [orgA], plugins });
      const orgAExec = yield* createExecutor({ ...config, scopes: [orgA] });
      const orgBExec = yield* createExecutor({ ...config, scopes: [orgB] });
      const secretId = SecretId.make("org-a-api-key");

      yield* orgAExec.secrets.set(
        new SetSecretInput({
          id: secretId,
          scope: orgA.id,
          name: "Org A API Key",
          value: "secret",
          provider: "memory",
        }),
      );
      yield* orgBExec.secrets.set(
        new SetSecretInput({
          id: secretId,
          scope: orgB.id,
          name: "Org B API Key",
          value: "different-secret",
          provider: "memory",
        }),
      );
      yield* orgAExec.openapi.addSpec({
        spec: specJson,
        scope: String(orgA.id),
        namespace: "private_source",
        baseUrl: "http://example.com",
      });
      yield* orgAExec.openapi.setSourceBinding(
        new OpenApiSourceBindingInput({
          sourceId: "private_source",
          sourceScope: orgA.id,
          scope: orgA.id,
          slot: "header:authorization",
          value: { kind: "secret", secretId },
        }),
      );

      const usages = yield* orgBExec.secrets.usages(secretId);
      expect(usages).toEqual([]);
    }),
  );

  it.effect("connections.usages does not expose binding rows outside the scope stack", () =>
    Effect.gen(function* () {
      const orgA = new Scope({
        id: ScopeId.make("org-a"),
        name: "Org A",
        createdAt: new Date(),
      });
      const orgB = new Scope({
        id: ScopeId.make("org-b"),
        name: "Org B",
        createdAt: new Date(),
      });
      const plugins = [memorySecretsPlugin(), connectionProviderPlugin(), openApiPlugin()] as const;
      const config = makeTestConfig({ scopes: [orgA], plugins });
      const orgAExec = yield* createExecutor({ ...config, scopes: [orgA] });
      const orgBExec = yield* createExecutor({ ...config, scopes: [orgB] });
      const connectionId = ConnectionId.make("org-a-connection");

      yield* orgAExec.connections.create(
        new CreateConnectionInput({
          id: connectionId,
          scope: orgA.id,
          provider: "test-oauth",
          identityLabel: "Org A connection",
          accessToken: new TokenMaterial({
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
        new CreateConnectionInput({
          id: connectionId,
          scope: orgB.id,
          provider: "test-oauth",
          identityLabel: "Org B connection",
          accessToken: new TokenMaterial({
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

      yield* orgAExec.openapi.addSpec({
        spec: specJson,
        scope: String(orgA.id),
        namespace: "private_source",
        baseUrl: "http://example.com",
      });
      yield* orgAExec.openapi.setSourceBinding(
        new OpenApiSourceBindingInput({
          sourceId: "private_source",
          sourceScope: orgA.id,
          scope: orgA.id,
          slot: "oauth:connection",
          value: { kind: "connection", connectionId },
        }),
      );

      const usages = yield* orgBExec.connections.usages(connectionId);
      expect(usages).toEqual([]);
    }),
  );
});
