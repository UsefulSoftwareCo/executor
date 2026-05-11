import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate, Result } from "effect";

import { makeMemoryAdapter } from "@executor-js/storage-core/testing/memory";

import { makeInMemoryBlobStore } from "./blob";
import { CreateConnectionInput, TokenMaterial } from "./connections";
import { collectSchemas, createExecutor, type Executor } from "./executor";
import type { CredentialBindingRow } from "./core-schema";
import { ConnectionId, ScopeId, SecretId } from "./ids";
import { definePlugin, type AnyPlugin } from "./plugin";
import { Scope } from "./scope";
import { RemoveSecretInput, SetSecretInput, type SecretProvider } from "./secrets";

const TEST_PLUGIN_ID = "credentialTest";
const TEST_SOURCE_ID = "shared-api";
const TEST_SLOT = "request.header.Authorization";

const scope = (id: string, name = id) =>
  new Scope({
    id: ScopeId.make(id),
    name,
    createdAt: new Date(),
  });

const makeMemorySecretProvider = (): SecretProvider => {
  const store = new Map<string, string>();
  const key = (scopeId: string, id: string) => `${scopeId}\u0000${id}`;
  return {
    key: "memory",
    writable: true,
    get: (id, scopeId) => Effect.sync(() => store.get(key(scopeId, id)) ?? null),
    has: (id, scopeId) => Effect.sync(() => store.has(key(scopeId, id))),
    set: (id, value, scopeId) =>
      Effect.sync(() => {
        store.set(key(scopeId, id), value);
      }),
    delete: (id, scopeId) => Effect.sync(() => store.delete(key(scopeId, id))),
    list: () =>
      Effect.sync(() =>
        Array.from(store.keys()).map((raw) => {
          const id = raw.split("\u0000", 2)[1] ?? raw;
          return { id, name: id };
        }),
      ),
  };
};

const memorySecretsPlugin = (provider: SecretProvider) =>
  definePlugin(() => ({
    id: "memorySecrets" as const,
    storage: () => ({}),
    secretProviders: [provider],
  }))();

const memoryConnectionPlugin = definePlugin(() => ({
  id: "memoryConnection" as const,
  storage: () => ({}),
  connectionProviders: [{ key: "memory-connection" }],
}));

const credentialTestPlugin = definePlugin(() => ({
  id: TEST_PLUGIN_ID,
  storage: () => ({}),
  extension: (ctx) => ({
    registerSource: (targetScope: ScopeId) =>
      ctx.core.sources.register({
        id: TEST_SOURCE_ID,
        scope: targetScope,
        kind: "test-api",
        name: "Shared API",
        canRemove: true,
        tools: [{ name: "read", description: "read from the shared API" }],
      }),
  }),
}));

const makeHarness = () => {
  const scopes = {
    org: scope("org", "Org"),
    workspace: scope("workspace", "Workspace"),
    userWorkspaceA: scope("user-workspace-a", "User A Workspace"),
    userWorkspaceB: scope("user-workspace-b", "User B Workspace"),
  };
  const plugins = [
    memorySecretsPlugin(makeMemorySecretProvider()),
    memoryConnectionPlugin(),
    credentialTestPlugin(),
  ] as const;
  const adapter = makeMemoryAdapter({ schema: collectSchemas(plugins) });
  const blobs = makeInMemoryBlobStore();
  const create = <const TPlugins extends readonly AnyPlugin[]>(
    visibleScopes: readonly Scope[],
    configuredPlugins: TPlugins,
  ) =>
    createExecutor({
      scopes: visibleScopes,
      adapter,
      blobs,
      plugins: configuredPlugins,
      onElicitation: "accept-all",
    });

  return {
    adapter,
    scopes,
    create: (visibleScopes: readonly Scope[]) => create(visibleScopes, plugins),
  };
};

const setSecret = (executor: Executor, scopeId: ScopeId, id: string, value: string) =>
  executor.secrets.set(
    new SetSecretInput({
      id: SecretId.make(id),
      scope: scopeId,
      name: id,
      value,
    }),
  );

const createConnection = (executor: Executor, scopeId: ScopeId, id: string) =>
  executor.connections.create(
    new CreateConnectionInput({
      id: ConnectionId.make(id),
      scope: scopeId,
      provider: "memory-connection",
      identityLabel: "Test User",
      accessToken: new TokenMaterial({
        secretId: SecretId.make(`${id}.access_token`),
        name: "Access",
        value: "access-token",
      }),
      refreshToken: null,
      expiresAt: null,
      oauthScope: null,
      providerState: null,
    }),
  );

describe("credential bindings", () => {
  it.effect("resolves a user-workspace credential for an inherited org source", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const orgExecutor = yield* harness.create([harness.scopes.org]);
      yield* orgExecutor.credentialTest.registerSource(harness.scopes.org.id);

      const userExecutor = yield* harness.create([
        harness.scopes.userWorkspaceA,
        harness.scopes.workspace,
        harness.scopes.org,
      ]);
      yield* setSecret(userExecutor, harness.scopes.userWorkspaceA.id, "api-token", "sk-user-a");
      const binding = yield* userExecutor.credentialBindings.set({
        targetScope: harness.scopes.userWorkspaceA.id,
        pluginId: TEST_PLUGIN_ID,
        sourceId: TEST_SOURCE_ID,
        sourceScope: harness.scopes.org.id,
        slotKey: TEST_SLOT,
        value: { kind: "secret", secretId: SecretId.make("api-token") },
      });

      const resolved = yield* userExecutor.credentialBindings.resolve({
        pluginId: TEST_PLUGIN_ID,
        sourceId: TEST_SOURCE_ID,
        sourceScope: harness.scopes.org.id,
        slotKey: TEST_SLOT,
      });

      expect(binding.scopeId).toBe(harness.scopes.userWorkspaceA.id);
      expect(resolved.status).toBe("resolved");
      expect(resolved.bindingScopeId).toBe(harness.scopes.userWorkspaceA.id);
      expect(resolved.kind).toBe("secret");
    }),
  );

  it.effect("workspace credential bindings shadow org bindings without copying the source", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const orgExecutor = yield* harness.create([harness.scopes.org]);
      yield* orgExecutor.credentialTest.registerSource(harness.scopes.org.id);
      yield* setSecret(orgExecutor, harness.scopes.org.id, "api-token", "sk-org");
      yield* orgExecutor.credentialBindings.set({
        targetScope: harness.scopes.org.id,
        pluginId: TEST_PLUGIN_ID,
        sourceId: TEST_SOURCE_ID,
        sourceScope: harness.scopes.org.id,
        slotKey: TEST_SLOT,
        value: { kind: "secret", secretId: SecretId.make("api-token") },
      });

      const workspaceExecutor = yield* harness.create([
        harness.scopes.workspace,
        harness.scopes.org,
      ]);
      yield* setSecret(workspaceExecutor, harness.scopes.workspace.id, "api-token", "sk-workspace");
      yield* workspaceExecutor.credentialBindings.set({
        targetScope: harness.scopes.workspace.id,
        pluginId: TEST_PLUGIN_ID,
        sourceId: TEST_SOURCE_ID,
        sourceScope: harness.scopes.org.id,
        slotKey: TEST_SLOT,
        value: { kind: "secret", secretId: SecretId.make("api-token") },
      });

      const resolved = yield* workspaceExecutor.credentialBindings.resolve({
        pluginId: TEST_PLUGIN_ID,
        sourceId: TEST_SOURCE_ID,
        sourceScope: harness.scopes.org.id,
        slotKey: TEST_SLOT,
      });
      const sources = yield* workspaceExecutor.sources.list();

      expect(resolved.bindingScopeId).toBe(harness.scopes.workspace.id);
      expect(sources.filter((source) => source.id === TEST_SOURCE_ID)).toHaveLength(1);
      expect(sources.find((source) => source.id === TEST_SOURCE_ID)?.scopeId).toBe(
        harness.scopes.org.id,
      );
    }),
  );

  it.effect("rejects credential binding writes outside the active scope stack", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const orgExecutor = yield* harness.create([harness.scopes.org]);
      yield* orgExecutor.credentialTest.registerSource(harness.scopes.org.id);

      const userExecutor = yield* harness.create([
        harness.scopes.userWorkspaceA,
        harness.scopes.org,
      ]);
      yield* setSecret(userExecutor, harness.scopes.userWorkspaceA.id, "api-token", "sk-user-a");

      const error = yield* userExecutor.credentialBindings
        .set({
          targetScope: ScopeId.make("other-org"),
          pluginId: TEST_PLUGIN_ID,
          sourceId: TEST_SOURCE_ID,
          sourceScope: harness.scopes.org.id,
          slotKey: TEST_SLOT,
          value: { kind: "secret", secretId: SecretId.make("api-token") },
        })
        .pipe(Effect.flip);

      expect(Predicate.isTagged(error, "StorageError")).toBe(true);
    }),
  );

  it.effect("rejects binding a user-owned source to an outer-scope credential", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const userExecutor = yield* harness.create([
        harness.scopes.userWorkspaceA,
        harness.scopes.workspace,
        harness.scopes.org,
      ]);
      yield* userExecutor.credentialTest.registerSource(harness.scopes.userWorkspaceA.id);
      yield* setSecret(userExecutor, harness.scopes.org.id, "api-token", "sk-org");

      const error = yield* userExecutor.credentialBindings
        .set({
          targetScope: harness.scopes.org.id,
          pluginId: TEST_PLUGIN_ID,
          sourceId: TEST_SOURCE_ID,
          sourceScope: harness.scopes.userWorkspaceA.id,
          slotKey: TEST_SLOT,
          value: { kind: "secret", secretId: SecretId.make("api-token") },
        })
        .pipe(Effect.flip);

      expect(Predicate.isTagged(error, "StorageError")).toBe(true);
    }),
  );

  it.effect("rejects replacing bindings for a user-owned source at an outer scope", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const userExecutor = yield* harness.create([
        harness.scopes.userWorkspaceA,
        harness.scopes.workspace,
        harness.scopes.org,
      ]);
      yield* userExecutor.credentialTest.registerSource(harness.scopes.userWorkspaceA.id);

      const error = yield* userExecutor.credentialBindings
        .replaceForSource({
          targetScope: harness.scopes.org.id,
          pluginId: TEST_PLUGIN_ID,
          sourceId: TEST_SOURCE_ID,
          sourceScope: harness.scopes.userWorkspaceA.id,
          slotPrefixes: ["request.header."],
          bindings: [],
        })
        .pipe(Effect.flip);

      expect(Predicate.isTagged(error, "StorageError")).toBe(true);
    }),
  );

  it.effect("ignores pre-existing outer-scope bindings for an inner source", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const userExecutor = yield* harness.create([
        harness.scopes.userWorkspaceA,
        harness.scopes.workspace,
        harness.scopes.org,
      ]);
      yield* userExecutor.credentialTest.registerSource(harness.scopes.userWorkspaceA.id);
      yield* setSecret(userExecutor, harness.scopes.org.id, "api-token", "sk-org");

      const migratedAt = new Date("2026-05-01T00:00:00.000Z");
      yield* harness.adapter.create({
        model: "credential_binding",
        data: {
          id: "invalid-outer-binding",
          scope_id: harness.scopes.org.id,
          plugin_id: TEST_PLUGIN_ID,
          source_id: TEST_SOURCE_ID,
          source_scope_id: harness.scopes.userWorkspaceA.id,
          slot_key: TEST_SLOT,
          kind: "secret",
          text_value: undefined,
          secret_id: "api-token",
          connection_id: undefined,
          created_at: migratedAt,
          updated_at: migratedAt,
        },
        forceAllowId: true,
      });

      const resolved = yield* userExecutor.credentialBindings.resolve({
        pluginId: TEST_PLUGIN_ID,
        sourceId: TEST_SOURCE_ID,
        sourceScope: harness.scopes.userWorkspaceA.id,
        slotKey: TEST_SLOT,
      });
      const listed = yield* userExecutor.credentialBindings.listForSource({
        pluginId: TEST_PLUGIN_ID,
        sourceId: TEST_SOURCE_ID,
        sourceScope: harness.scopes.userWorkspaceA.id,
      });

      expect(resolved.status).toBe("missing");
      expect(listed).toEqual([]);
    }),
  );

  it.effect("rejects credential binding removals outside the active source scope stack", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const userExecutor = yield* harness.create([
        harness.scopes.userWorkspaceA,
        harness.scopes.org,
      ]);

      const error = yield* userExecutor.credentialBindings
        .remove({
          targetScope: harness.scopes.userWorkspaceA.id,
          pluginId: TEST_PLUGIN_ID,
          sourceId: TEST_SOURCE_ID,
          sourceScope: harness.scopes.userWorkspaceB.id,
          slotKey: TEST_SLOT,
        })
        .pipe(Effect.flip);

      expect(Predicate.isTagged(error, "StorageError")).toBe(true);
    }),
  );

  it.effect("rejects credential binding removals for sources not visible at the given scope", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const userExecutor = yield* harness.create([
        harness.scopes.userWorkspaceA,
        harness.scopes.org,
      ]);

      const error = yield* userExecutor.credentialBindings
        .remove({
          targetScope: harness.scopes.userWorkspaceA.id,
          pluginId: TEST_PLUGIN_ID,
          sourceId: TEST_SOURCE_ID,
          sourceScope: harness.scopes.org.id,
          slotKey: TEST_SLOT,
        })
        .pipe(Effect.flip);

      expect(Predicate.isTagged(error, "StorageError")).toBe(true);
    }),
  );

  it.effect("secret usages only report credential bindings visible to the caller", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const orgExecutor = yield* harness.create([harness.scopes.org]);
      yield* orgExecutor.credentialTest.registerSource(harness.scopes.org.id);

      const userA = yield* harness.create([harness.scopes.userWorkspaceA, harness.scopes.org]);
      yield* setSecret(userA, harness.scopes.userWorkspaceA.id, "shared-token-id", "sk-user-a");
      yield* userA.credentialBindings.set({
        targetScope: harness.scopes.userWorkspaceA.id,
        pluginId: TEST_PLUGIN_ID,
        sourceId: TEST_SOURCE_ID,
        sourceScope: harness.scopes.org.id,
        slotKey: TEST_SLOT,
        value: { kind: "secret", secretId: SecretId.make("shared-token-id") },
      });

      const userB = yield* harness.create([harness.scopes.userWorkspaceB, harness.scopes.org]);
      yield* setSecret(userB, harness.scopes.userWorkspaceB.id, "shared-token-id", "sk-user-b");

      const userAUsages = yield* userA.secrets.usages(SecretId.make("shared-token-id"));
      const userBUsages = yield* userB.secrets.usages(SecretId.make("shared-token-id"));

      expect(userAUsages).toHaveLength(1);
      expect(userAUsages[0]).toMatchObject({
        pluginId: TEST_PLUGIN_ID,
        scopeId: harness.scopes.userWorkspaceA.id,
        ownerId: TEST_SOURCE_ID,
        ownerName: "Shared API",
        slot: TEST_SLOT,
      });
      expect(userBUsages).toEqual([]);
    }),
  );

  it.effect("connection usages only report credential bindings visible to the caller", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const orgExecutor = yield* harness.create([harness.scopes.org]);
      yield* orgExecutor.credentialTest.registerSource(harness.scopes.org.id);

      const userA = yield* harness.create([harness.scopes.userWorkspaceA, harness.scopes.org]);
      yield* createConnection(userA, harness.scopes.userWorkspaceA.id, "oauth-connection");
      yield* userA.credentialBindings.set({
        targetScope: harness.scopes.userWorkspaceA.id,
        pluginId: TEST_PLUGIN_ID,
        sourceId: TEST_SOURCE_ID,
        sourceScope: harness.scopes.org.id,
        slotKey: "oauth.connection",
        value: {
          kind: "connection",
          connectionId: ConnectionId.make("oauth-connection"),
        },
      });

      const userB = yield* harness.create([harness.scopes.userWorkspaceB, harness.scopes.org]);
      yield* createConnection(userB, harness.scopes.userWorkspaceB.id, "oauth-connection");

      const userAUsages = yield* userA.connections.usages(ConnectionId.make("oauth-connection"));
      const userBUsages = yield* userB.connections.usages(ConnectionId.make("oauth-connection"));

      expect(userAUsages).toHaveLength(1);
      expect(userAUsages[0]).toMatchObject({
        pluginId: TEST_PLUGIN_ID,
        scopeId: harness.scopes.userWorkspaceA.id,
        ownerId: TEST_SOURCE_ID,
        slot: "oauth.connection",
      });
      expect(userBUsages).toEqual([]);
    }),
  );

  it.effect("source-owner cleanup removes descendant user credential bindings explicitly", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const orgExecutor = yield* harness.create([harness.scopes.org]);
      yield* orgExecutor.credentialTest.registerSource(harness.scopes.org.id);

      const userA = yield* harness.create([harness.scopes.userWorkspaceA, harness.scopes.org]);
      yield* setSecret(userA, harness.scopes.userWorkspaceA.id, "alice-token", "sk-user-a");
      yield* userA.credentialBindings.set({
        targetScope: harness.scopes.userWorkspaceA.id,
        pluginId: TEST_PLUGIN_ID,
        sourceId: TEST_SOURCE_ID,
        sourceScope: harness.scopes.org.id,
        slotKey: TEST_SLOT,
        value: { kind: "secret", secretId: SecretId.make("alice-token") },
      });

      const userB = yield* harness.create([harness.scopes.userWorkspaceB, harness.scopes.org]);
      yield* setSecret(userB, harness.scopes.userWorkspaceB.id, "bob-token", "sk-user-b");
      yield* userB.credentialBindings.set({
        targetScope: harness.scopes.userWorkspaceB.id,
        pluginId: TEST_PLUGIN_ID,
        sourceId: TEST_SOURCE_ID,
        sourceScope: harness.scopes.org.id,
        slotKey: TEST_SLOT,
        value: { kind: "secret", secretId: SecretId.make("bob-token") },
      });

      yield* orgExecutor.credentialBindings.removeForSource({
        pluginId: TEST_PLUGIN_ID,
        sourceId: TEST_SOURCE_ID,
        sourceScope: harness.scopes.org.id,
      });

      const userAResolved = yield* userA.credentialBindings.resolve({
        pluginId: TEST_PLUGIN_ID,
        sourceId: TEST_SOURCE_ID,
        sourceScope: harness.scopes.org.id,
        slotKey: TEST_SLOT,
      });
      const userBResolved = yield* userB.credentialBindings.resolve({
        pluginId: TEST_PLUGIN_ID,
        sourceId: TEST_SOURCE_ID,
        sourceScope: harness.scopes.org.id,
        slotKey: TEST_SLOT,
      });

      expect(userAResolved.status).toBe("missing");
      expect(userBResolved.status).toBe("missing");
    }),
  );

  it.effect("set replaces migrated bindings by natural slot identity", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const orgExecutor = yield* harness.create([harness.scopes.org]);
      yield* orgExecutor.credentialTest.registerSource(harness.scopes.org.id);

      const userExecutor = yield* harness.create([
        harness.scopes.userWorkspaceA,
        harness.scopes.org,
      ]);
      yield* setSecret(userExecutor, harness.scopes.userWorkspaceA.id, "old-token", "sk-old");
      yield* setSecret(userExecutor, harness.scopes.userWorkspaceA.id, "new-token", "sk-new");

      const migratedAt = new Date("2026-05-01T00:00:00.000Z");
      yield* harness.adapter.create({
        model: "credential_binding",
        data: {
          id: "openapi-source-binding:legacy-row-id",
          scope_id: harness.scopes.userWorkspaceA.id,
          plugin_id: TEST_PLUGIN_ID,
          source_id: TEST_SOURCE_ID,
          source_scope_id: harness.scopes.org.id,
          slot_key: TEST_SLOT,
          kind: "secret",
          text_value: undefined,
          secret_id: "old-token",
          connection_id: undefined,
          created_at: migratedAt,
          updated_at: migratedAt,
        },
        forceAllowId: true,
      });

      const updated = yield* userExecutor.credentialBindings.set({
        targetScope: harness.scopes.userWorkspaceA.id,
        pluginId: TEST_PLUGIN_ID,
        sourceId: TEST_SOURCE_ID,
        sourceScope: harness.scopes.org.id,
        slotKey: TEST_SLOT,
        value: { kind: "secret", secretId: SecretId.make("new-token") },
      });

      const rawRows = yield* harness.adapter.findMany<CredentialBindingRow>({
        model: "credential_binding",
        where: [
          { field: "scope_id", value: harness.scopes.userWorkspaceA.id },
          { field: "plugin_id", value: TEST_PLUGIN_ID },
          { field: "source_id", value: TEST_SOURCE_ID },
          { field: "source_scope_id", value: harness.scopes.org.id },
          { field: "slot_key", value: TEST_SLOT },
        ],
      });

      expect(rawRows).toHaveLength(1);
      expect(rawRows[0]?.id).toBe(updated.id);
      expect(rawRows[0]?.secret_id).toBe("new-token");
    }),
  );

  it.effect("removing a same-id user secret is blocked when a user binding uses that row", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const orgExecutor = yield* harness.create([harness.scopes.org]);
      yield* orgExecutor.credentialTest.registerSource(harness.scopes.org.id);
      yield* setSecret(orgExecutor, harness.scopes.org.id, "shared-token-id", "sk-org");

      const userExecutor = yield* harness.create([
        harness.scopes.userWorkspaceA,
        harness.scopes.org,
      ]);
      yield* setSecret(
        userExecutor,
        harness.scopes.userWorkspaceA.id,
        "shared-token-id",
        "sk-user-a",
      );
      yield* userExecutor.credentialBindings.set({
        targetScope: harness.scopes.userWorkspaceA.id,
        pluginId: TEST_PLUGIN_ID,
        sourceId: TEST_SOURCE_ID,
        sourceScope: harness.scopes.org.id,
        slotKey: TEST_SLOT,
        value: { kind: "secret", secretId: SecretId.make("shared-token-id") },
      });

      const result = yield* Effect.result(
        userExecutor.secrets.remove(
          new RemoveSecretInput({
            id: SecretId.make("shared-token-id"),
            targetScope: harness.scopes.userWorkspaceA.id,
          }),
        ),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("SecretInUseError")(result.failure)).toBe(true);
    }),
  );

  it.effect("a personal binding can point at an organization-owned secret", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const orgExecutor = yield* harness.create([harness.scopes.org]);
      yield* orgExecutor.credentialTest.registerSource(harness.scopes.org.id);
      yield* setSecret(orgExecutor, harness.scopes.org.id, "shared-token-id", "sk-org");

      const userExecutor = yield* harness.create([
        harness.scopes.userWorkspaceA,
        harness.scopes.org,
      ]);

      const binding = yield* userExecutor.credentialBindings.set({
        targetScope: harness.scopes.userWorkspaceA.id,
        pluginId: TEST_PLUGIN_ID,
        sourceId: TEST_SOURCE_ID,
        sourceScope: harness.scopes.org.id,
        slotKey: TEST_SLOT,
        value: {
          kind: "secret",
          secretId: SecretId.make("shared-token-id"),
          secretScopeId: harness.scopes.org.id,
        },
      });

      expect(binding.scopeId).toBe(harness.scopes.userWorkspaceA.id);
      expect(binding.value).toMatchObject({
        kind: "secret",
        secretId: SecretId.make("shared-token-id"),
        secretScopeId: harness.scopes.org.id,
      });

      const resolved = yield* userExecutor.credentialBindings.resolve({
        pluginId: TEST_PLUGIN_ID,
        sourceId: TEST_SOURCE_ID,
        sourceScope: harness.scopes.org.id,
        slotKey: TEST_SLOT,
      });

      expect(resolved.status).toBe("resolved");
      expect(resolved.bindingScopeId).toBe(harness.scopes.userWorkspaceA.id);
    }),
  );

  it.effect(
    "removing an organization secret is blocked when a personal binding references it",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const orgExecutor = yield* harness.create([harness.scopes.org]);
        yield* orgExecutor.credentialTest.registerSource(harness.scopes.org.id);
        yield* setSecret(orgExecutor, harness.scopes.org.id, "shared-token-id", "sk-org");

        const userExecutor = yield* harness.create([
          harness.scopes.userWorkspaceA,
          harness.scopes.org,
        ]);
        yield* userExecutor.credentialBindings.set({
          targetScope: harness.scopes.userWorkspaceA.id,
          pluginId: TEST_PLUGIN_ID,
          sourceId: TEST_SOURCE_ID,
          sourceScope: harness.scopes.org.id,
          slotKey: TEST_SLOT,
          value: {
            kind: "secret",
            secretId: SecretId.make("shared-token-id"),
            secretScopeId: harness.scopes.org.id,
          },
        });

        const result = yield* Effect.result(
          userExecutor.secrets.remove(
            new RemoveSecretInput({
              id: SecretId.make("shared-token-id"),
              targetScope: harness.scopes.org.id,
            }),
          ),
        );

        expect(Result.isFailure(result)).toBe(true);
        if (!Result.isFailure(result)) return;
        expect(Predicate.isTagged("SecretInUseError")(result.failure)).toBe(true);
      }),
  );

  it.effect("rejects an organization binding to a personal secret", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const orgExecutor = yield* harness.create([harness.scopes.org]);
      yield* orgExecutor.credentialTest.registerSource(harness.scopes.org.id);

      const userExecutor = yield* harness.create([
        harness.scopes.userWorkspaceA,
        harness.scopes.org,
      ]);
      yield* setSecret(
        userExecutor,
        harness.scopes.userWorkspaceA.id,
        "personal-token",
        "sk-user-a",
      );

      const result = yield* Effect.result(
        userExecutor.credentialBindings.set({
          targetScope: harness.scopes.org.id,
          pluginId: TEST_PLUGIN_ID,
          sourceId: TEST_SOURCE_ID,
          sourceScope: harness.scopes.org.id,
          slotKey: TEST_SLOT,
          value: {
            kind: "secret",
            secretId: SecretId.make("personal-token"),
            secretScopeId: harness.scopes.userWorkspaceA.id,
          },
        }),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("StorageError")(result.failure)).toBe(true);
    }),
  );

  it.effect(
    "materializes a routing row for read-only provider items (e.g. 1Password) when binding",
    () =>
      Effect.gen(function* () {
        // Read-only provider that lists an item nobody registered via
        // secrets.set — models 1Password / env / file-secrets.
        const itemId = "op-vault-item-1";
        const itemName = "Cloudflare API Token";
        const readonlyProvider: SecretProvider = {
          key: "readonly-vault",
          writable: false,
          allowFallback: false,
          get: (id) => Effect.sync(() => (id === itemId ? "from-vault" : null)),
          list: () => Effect.sync(() => [{ id: itemId, name: itemName }]),
        };

        const scopes = {
          org: scope("org", "Org"),
          userA: scope("user-workspace-a", "User A Workspace"),
        };
        const plugins = [
          memorySecretsPlugin(readonlyProvider),
          memoryConnectionPlugin(),
          credentialTestPlugin(),
        ] as const;
        const adapter = makeMemoryAdapter({ schema: collectSchemas(plugins) });
        const blobs = makeInMemoryBlobStore();
        const orgExecutor = yield* createExecutor({
          scopes: [scopes.org],
          adapter,
          blobs,
          plugins,
          onElicitation: "accept-all",
        });
        yield* orgExecutor.credentialTest.registerSource(scopes.org.id);

        const userExecutor = yield* createExecutor({
          scopes: [scopes.userA, scopes.org],
          adapter,
          blobs,
          plugins,
          onElicitation: "accept-all",
        });

        const binding = yield* userExecutor.credentialBindings.set({
          targetScope: scopes.userA.id,
          pluginId: TEST_PLUGIN_ID,
          sourceId: TEST_SOURCE_ID,
          sourceScope: scopes.org.id,
          slotKey: TEST_SLOT,
          value: { kind: "secret", secretId: SecretId.make(itemId) },
        });

        expect(binding.scopeId).toBe(scopes.userA.id);

        const secrets = yield* userExecutor.secrets.list();
        const materialized = secrets.find((s) => String(s.id) === itemId);
        expect(materialized).toBeDefined();
        expect(materialized?.provider).toBe("readonly-vault");
        expect(materialized?.name).toBe(itemName);

        const resolved = yield* userExecutor.credentialBindings.resolve({
          pluginId: TEST_PLUGIN_ID,
          sourceId: TEST_SOURCE_ID,
          sourceScope: scopes.org.id,
          slotKey: TEST_SLOT,
        });
        expect(resolved.status).toBe("resolved");
      }),
  );
});
