import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import { createExecutor, type ExecutorAdmin } from "./executor";
import { StorageError, type FumaDb } from "./fuma-runtime";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ProviderItemId,
  ProviderKey,
  ToolName,
  Tenant,
} from "./ids";
import { definePlugin } from "./plugin";
import type { CredentialProvider } from "./provider";
import { makeTestConfig } from "./testing";
import { serveOAuthTestServer } from "./testing/oauth-test-server";
import { firstPartyOAuthClientSlug, type FirstPartyOAuthClientConfig } from "./oauth-client";

const INTEGRATION = IntegrationSlug.make("example");
const TEMPLATE = AuthTemplateSlug.make("apiKey");

const memoryProvider = (
  failWrites: () => boolean = () => false,
  failDeletes: () => boolean = () => false,
): CredentialProvider => {
  const store = new Map<string, string>();
  return {
    key: ProviderKey.make("memory"),
    writable: true,
    get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
    set: (id, value) =>
      failWrites()
        ? Effect.fail(
            new StorageError({ message: "credential provider write refused", cause: undefined }),
          )
        : Effect.sync(() => void store.set(String(id), value)),
    delete: (id) =>
      failDeletes()
        ? Effect.fail(
            new StorageError({ message: "credential provider delete refused", cause: undefined }),
          )
        : Effect.sync(() => void store.delete(String(id))),
    has: (id) => Effect.sync(() => store.has(String(id))),
    list: () =>
      Effect.sync(() =>
        Array.from(store.keys()).map((key) => ({
          id: ProviderItemId.make(key),
          name: key,
        })),
      ),
  };
};

const racingProvider = () => {
  const store = new Map<string, string>();
  let failWrites = false;
  const provider: CredentialProvider = {
    key: ProviderKey.make("memory"),
    writable: true,
    get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
    set: (id, value) =>
      failWrites
        ? Effect.sync(() => void store.set(String(id), "partial-stale-write")).pipe(
            Effect.andThen(
              Effect.fail(
                new StorageError({
                  message: "credential provider write refused",
                  cause: undefined,
                }),
              ),
            ),
          )
        : Effect.sync(() => void store.set(String(id), value)),
    delete: (id) => Effect.sync(() => void store.delete(String(id))),
    list: () =>
      Effect.sync(() =>
        Array.from(store.keys()).map((key) => ({
          id: ProviderItemId.make(key),
          name: key,
        })),
      ),
  };
  return {
    provider,
    armFailure: () => {
      failWrites = true;
    },
    installSuccessorSecret: () => {
      for (const key of store.keys()) store.set(key, "successor-secret");
    },
    values: () => [...store.values()],
  };
};

const makeAuditPlugin = (provider: CredentialProvider) =>
  definePlugin(() => ({
    id: "audit-test" as const,
    credentialProviders: [provider],
    storage: () => ({}),
    resolveTools: () => Effect.succeed({ tools: [{ name: ToolName.make("run") }] }),
    describeAuthMethods: () => [
      {
        id: "oauth",
        label: "OAuth2",
        kind: "oauth" as const,
        template: String(TEMPLATE),
        oauth: { scopes: ["read"] },
      },
    ],
    extension: (ctx) => ({
      seed: () =>
        ctx.core.integrations.register({
          slug: INTEGRATION,
          description: "Example",
          config: {},
        }),
      replace: () =>
        ctx.core.integrations.register({
          slug: INTEGRATION,
          description: "Replacement",
          config: { version: 2 },
        }),
    }),
  }))();

/** Fault-inject only audit inserts, including inside transaction handles. */
const failAuditInserts = (db: FumaDb, armed: () => boolean): FumaDb => {
  const wrap = (inner: FumaDb): FumaDb =>
    new Proxy(inner, {
      get(target, property) {
        if (property === "withContext") {
          return (context: unknown) =>
            wrap((target.withContext as (value: unknown) => FumaDb)(context));
        }
        if (property === "transaction") {
          return (run: (transactionDb: FumaDb) => Promise<unknown>) =>
            target.transaction((transactionDb) => run(wrap(transactionDb as FumaDb)));
        }
        if (property === "create") {
          return (table: unknown, values: unknown) =>
            armed() && table === "audit_event"
              ? // oxlint-disable-next-line executor/no-promise-reject -- boundary: fault-injecting raw FumaDB adapter simulates a rejected audit insert
                Promise.reject(
                  new StorageError({ message: "audit insert refused", cause: undefined }),
                )
              : (target.create as (name: unknown, input: unknown) => Promise<unknown>)(
                  table,
                  values,
                );
        }
        return Reflect.get(target, property);
      },
    });
  return wrap(db);
};

/** Replace the compensated OAuth row immediately before its provider-ownership
 * recheck, modeling a concurrent successor that committed in that interval. */
const replaceOAuthClientBeforeCompensationRecheck = (
  db: FumaDb,
  armed: () => boolean,
  installSuccessorSecret: () => void,
): FumaDb => {
  let transactionCount = 0;
  const wrap = (inner: FumaDb): FumaDb =>
    new Proxy(inner, {
      get(target, property) {
        if (property === "withContext") {
          return (context: unknown) =>
            wrap((target.withContext as (value: unknown) => FumaDb)(context));
        }
        if (property === "transaction") {
          return (run: (transactionDb: FumaDb) => Promise<unknown>) => {
            if (armed()) transactionCount += 1;
            return target.transaction(async (transactionDb) => {
              if (armed() && transactionCount === 3) {
                const current = await transactionDb.findFirst("oauth_client", {});
                if (current !== null) {
                  const { row_id: _rowId, ...values } = current as Record<string, unknown>;
                  await transactionDb.deleteMany("oauth_client", {});
                  await transactionDb.create("oauth_client", {
                    ...values,
                    client_id: "successor-client-id",
                  });
                  installSuccessorSecret();
                }
              }
              return run(wrap(transactionDb as FumaDb));
            });
          };
        }
        return Reflect.get(target, property);
      },
    });
  return wrap(db);
};

const requireAdmin = (admin: ExecutorAdmin | undefined) =>
  admin === undefined ? Effect.die("expected a platform admin view") : Effect.succeed(admin);

const setup = (
  failAudit?: () => boolean,
  provider: CredentialProvider = memoryProvider(),
  firstPartyOAuthClients?: readonly FirstPartyOAuthClientConfig[],
) =>
  Effect.gen(function* () {
    const auditPlugin = makeAuditPlugin(provider);
    const config = makeTestConfig({
      tenant: "audit-tenant",
      subject: "actor-123",
      plugins: [auditPlugin] as const,
      firstPartyOAuthClients,
    });
    const executor = yield* createExecutor({
      ...config,
      db: failAudit ? failAuditInserts(config.db, failAudit) : config.db,
    });
    const platformExecutor = yield* createExecutor({
      tenant: config.tenant,
      db: config.testDb.db,
      platformView: true,
      onElicitation: "accept-all",
    });
    const admin = yield* requireAdmin(platformExecutor.admin);
    yield* Effect.addFinalizer(() =>
      executor
        .close()
        .pipe(
          Effect.andThen(platformExecutor.close()),
          Effect.andThen(Effect.promise(() => config.testDb.close())),
          Effect.ignore,
        ),
    );
    return { executor, admin, db: config.testDb.db };
  });

describe("admin audit events", () => {
  it.effect("records successful lifecycle changes with actor, scope, and safe identifiers", () =>
    Effect.gen(function* () {
      const { executor, admin } = yield* setup();
      yield* executor["audit-test"].seed();

      const shared = yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("shared"),
        integration: INTEGRATION,
        template: TEMPLATE,
        value: "SECRET-workspace-token",
      });
      const personal = yield* executor.connections.create({
        owner: "user",
        name: ConnectionName.make("personal"),
        integration: INTEGRATION,
        template: TEMPLATE,
        value: "SECRET-personal-token",
      });
      yield* executor.connections.update(
        { owner: shared.owner, integration: shared.integration, name: shared.name },
        { description: "renamed" },
      );
      yield* executor.connections.remove({
        owner: personal.owner,
        integration: personal.integration,
        name: personal.name,
      });

      const client = OAuthClientSlug.make("workspace-app");
      const clientInput = {
        owner: "org" as const,
        slug: client,
        authorizationUrl: "https://example.test/authorize",
        tokenUrl: "https://example.test/token",
        grant: "authorization_code" as const,
        clientId: "client-id",
        clientSecret: "SECRET-client-secret",
      };
      yield* executor.oauth.createClient(clientInput);
      yield* executor.oauth.createClient({ ...clientInput, clientId: "updated-client-id" });
      yield* executor.oauth.removeClient("org", client);

      yield* executor["audit-test"].replace();
      yield* executor.integrations.update(INTEGRATION, { name: "Renamed" });
      yield* executor.integrations.healthCheck.set(INTEGRATION, {
        operation: "run",
      });
      const policy = yield* executor.policies.create({
        owner: "org",
        pattern: "*",
        action: "require_approval",
      });
      yield* executor.policies.update({
        id: policy.id,
        owner: "org",
        action: "block",
      });
      yield* executor.policies.remove({ id: policy.id, owner: "org" });
      yield* executor.integrations.remove(INTEGRATION);

      const events = yield* admin.listAuditEvents();
      expect(events).toHaveLength(15);
      expect(new Set(events.map((event) => event.actorId))).toEqual(new Set(["actor-123"]));
      expect(
        events.map(({ action, resourceType, resourceOwner, resourceParent, resourceId }) => ({
          action,
          resourceType,
          resourceOwner,
          resourceParent,
          resourceId,
        })),
      ).toEqual(
        expect.arrayContaining([
          {
            action: "created",
            resourceType: "connection",
            resourceOwner: "org",
            resourceParent: "example",
            resourceId: "shared",
          },
          {
            action: "removed",
            resourceType: "connection",
            resourceOwner: "user",
            resourceParent: "example",
            resourceId: "personal",
          },
          {
            action: "updated",
            resourceType: "oauth_client",
            resourceOwner: "org",
            resourceParent: null,
            resourceId: "workspace-app",
          },
          {
            action: "removed",
            resourceType: "integration",
            resourceOwner: null,
            resourceParent: null,
            resourceId: "example",
          },
          {
            action: "updated",
            resourceType: "integration",
            resourceOwner: null,
            resourceParent: null,
            resourceId: "example",
          },
          {
            action: "created",
            resourceType: "tool_policy",
            resourceOwner: "org",
            resourceParent: null,
            resourceId: String(policy.id),
          },
          {
            action: "updated",
            resourceType: "tool_policy",
            resourceOwner: "org",
            resourceParent: null,
            resourceId: String(policy.id),
          },
          {
            action: "removed",
            resourceType: "tool_policy",
            resourceOwner: "org",
            resourceParent: null,
            resourceId: String(policy.id),
          },
        ]),
      );
      expect(
        events.filter(
          (event) =>
            event.action === "updated" &&
            event.resourceType === "integration" &&
            event.resourceId === "example",
        ),
      ).toHaveLength(3);

      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain("SECRET-");
      expect(serialized).not.toContain("client-id");
      expect(serialized).not.toContain("authorizationUrl");
    }).pipe(Effect.scoped),
  );

  it.effect("filters, pages, and isolates the tenant", () =>
    Effect.gen(function* () {
      const { executor, admin, db } = yield* setup();
      yield* executor["audit-test"].seed();
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("shared"),
        integration: INTEGRATION,
        template: TEMPLATE,
        value: "workspace-token",
      });
      yield* executor.connections.create({
        owner: "user",
        name: ConnectionName.make("personal"),
        integration: INTEGRATION,
        template: TEMPLATE,
        value: "personal-token",
      });

      const orgEvents = yield* admin.listAuditEvents({ resourceOwner: "org" });
      expect(orgEvents).toHaveLength(1);
      expect(orgEvents[0]).toMatchObject({ resourceType: "connection", resourceId: "shared" });
      expect(yield* admin.listAuditEvents({ resourceType: "connection", limit: 1 })).toHaveLength(
        1,
      );
      expect(yield* admin.listAuditEvents({ resourceType: "connection", offset: 1 })).toHaveLength(
        1,
      );

      const otherPlatform = yield* createExecutor({
        tenant: Tenant.make("other-tenant"),
        db,
        platformView: true,
        onElicitation: "accept-all",
      });
      yield* Effect.addFinalizer(() => otherPlatform.close().pipe(Effect.ignore));
      const otherAdmin = yield* requireAdmin(otherPlatform.admin);
      expect(yield* otherAdmin.listAuditEvents()).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves credentials untouched when the audit insert rolls back", () =>
    Effect.gen(function* () {
      let armed = false;
      const { executor, admin } = yield* setup(() => armed);
      yield* executor["audit-test"].seed();
      const beforeItems = yield* executor.providers.items(ProviderKey.make("memory"));
      const beforeEvents = yield* admin.listAuditEvents();
      armed = true;

      const connectionResult = yield* executor.connections
        .create({
          owner: "org",
          name: ConnectionName.make("audit-failure"),
          integration: INTEGRATION,
          template: TEMPLATE,
          value: "SECRET-must-not-stick",
        })
        .pipe(Effect.result);
      expect(Result.isFailure(connectionResult)).toBe(true);
      expect(yield* executor.connections.list()).toEqual([]);
      expect(yield* executor.providers.items(ProviderKey.make("memory"))).toEqual(beforeItems);

      const oauthResult = yield* executor.oauth
        .createClient({
          owner: "org",
          slug: OAuthClientSlug.make("audit-failure-app"),
          authorizationUrl: "https://example.test/authorize",
          tokenUrl: "https://example.test/token",
          grant: "authorization_code",
          clientId: "client-id",
          clientSecret: "SECRET-must-not-stick-either",
        })
        .pipe(Effect.result);
      expect(Result.isFailure(oauthResult)).toBe(true);
      expect(yield* executor.oauth.listClients()).toEqual([]);
      expect(yield* executor.providers.items(ProviderKey.make("memory"))).toEqual(beforeItems);
      expect(yield* admin.listAuditEvents()).toEqual(beforeEvents);
    }).pipe(Effect.scoped),
  );

  it.effect("records rollback events when credential persistence fails after commit", () =>
    Effect.gen(function* () {
      let failWrites = false;
      const { executor, admin } = yield* setup(
        undefined,
        memoryProvider(() => failWrites),
      );
      yield* executor["audit-test"].seed();
      failWrites = true;

      const connectionResult = yield* executor.connections
        .create({
          owner: "org",
          name: ConnectionName.make("provider-failure"),
          integration: INTEGRATION,
          template: TEMPLATE,
          value: "SECRET-must-not-stick",
        })
        .pipe(Effect.result);
      expect(Result.isFailure(connectionResult)).toBe(true);
      expect(yield* executor.connections.list()).toEqual([]);

      const oauthResult = yield* executor.oauth
        .createClient({
          owner: "org",
          slug: OAuthClientSlug.make("provider-failure-app"),
          authorizationUrl: "https://example.test/authorize",
          tokenUrl: "https://example.test/token",
          grant: "authorization_code",
          clientId: "client-id",
          clientSecret: "SECRET-must-not-stick-either",
        })
        .pipe(Effect.result);
      expect(Result.isFailure(oauthResult)).toBe(true);
      expect(yield* executor.oauth.listClients()).toEqual([]);
      expect(yield* executor.providers.items(ProviderKey.make("memory"))).toEqual([]);

      const events = yield* admin.listAuditEvents();
      const connectionActions = events
        .filter((event) => event.resourceId === "providerFailure")
        .map((event) => event.action);
      expect(connectionActions).toHaveLength(2);
      expect(connectionActions).toEqual(expect.arrayContaining(["created", "rolled_back"]));
      const clientActions = events
        .filter((event) => event.resourceId === "provider-failure-app")
        .map((event) => event.action);
      expect(clientActions).toHaveLength(2);
      expect(clientActions).toEqual(expect.arrayContaining(["created", "rolled_back"]));
    }).pipe(Effect.scoped),
  );

  it.effect("commits and audits an OAuth connection before persisting its tokens", () =>
    Effect.gen(function* () {
      const server = yield* serveOAuthTestServer({ scopes: ["read"] });
      let failWrites = false;
      const firstPartyClient: FirstPartyOAuthClientConfig = {
        name: "audit-order",
        authorizationUrl: server.authorizationEndpoint,
        tokenUrl: server.tokenEndpoint,
        clientId: "test-client",
        clientSecret: "test-secret",
        integrations: [INTEGRATION],
      };
      const { executor, admin } = yield* setup(
        undefined,
        memoryProvider(() => failWrites),
        [firstPartyClient],
      );
      yield* executor["audit-test"].seed();
      const started = yield* executor.oauth.start({
        owner: "org",
        client: firstPartyOAuthClientSlug(firstPartyClient.name),
        clientOwner: "org",
        name: ConnectionName.make("oauth-order"),
        integration: INTEGRATION,
        template: TEMPLATE,
      });
      expect(started.status).toBe("redirect");
      if (started.status !== "redirect") return;
      const callback = yield* server.completeAuthorizationCodeFlow({
        authorizationUrl: started.authorizationUrl,
      });
      failWrites = true;

      const result = yield* executor.oauth
        .complete({ state: started.state, code: callback.code })
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(yield* executor.connections.list()).toEqual([]);
      expect(yield* executor.providers.items(ProviderKey.make("memory"))).toEqual([]);
      const connectionActions = (yield* admin.listAuditEvents())
        .filter((event) => event.resourceId === "oauthOrder")
        .map((event) => event.action);
      expect(connectionActions).toHaveLength(2);
      expect(connectionActions).toEqual(expect.arrayContaining(["created", "rolled_back"]));
    }).pipe(Effect.scoped),
  );

  it.effect("records rollback failure when provider credential restoration fails", () =>
    Effect.gen(function* () {
      const server = yield* serveOAuthTestServer({ scopes: ["read"] });
      let failProviderWrites = false;
      let failProviderDeletes = false;
      const firstPartyClient: FirstPartyOAuthClientConfig = {
        name: "rollback-failure",
        authorizationUrl: server.authorizationEndpoint,
        tokenUrl: server.tokenEndpoint,
        clientId: "test-client",
        clientSecret: "test-secret",
        integrations: [INTEGRATION],
      };
      const { executor, admin } = yield* setup(
        undefined,
        memoryProvider(
          () => failProviderWrites,
          () => failProviderDeletes,
        ),
        [firstPartyClient],
      );
      yield* executor["audit-test"].seed();

      const clientSlug = OAuthClientSlug.make("rollback-failure-app");
      failProviderWrites = true;
      failProviderDeletes = true;
      const clientResult = yield* executor.oauth
        .createClient({
          owner: "org",
          slug: clientSlug,
          authorizationUrl: "https://example.test/authorize",
          tokenUrl: "https://example.test/token",
          grant: "authorization_code",
          clientId: "client-id",
          clientSecret: "SECRET-will-fail",
        })
        .pipe(Effect.result);
      expect(Result.isFailure(clientResult)).toBe(true);

      failProviderWrites = false;
      failProviderDeletes = false;
      const started = yield* executor.oauth.start({
        owner: "org",
        client: firstPartyOAuthClientSlug(firstPartyClient.name),
        clientOwner: "org",
        name: ConnectionName.make("rollback-failure"),
        integration: INTEGRATION,
        template: TEMPLATE,
      });
      expect(started.status).toBe("redirect");
      if (started.status !== "redirect") return;
      const callback = yield* server.completeAuthorizationCodeFlow({
        authorizationUrl: started.authorizationUrl,
      });
      failProviderWrites = true;
      failProviderDeletes = true;
      const connectionResult = yield* executor.oauth
        .complete({ state: started.state, code: callback.code })
        .pipe(Effect.result);
      expect(Result.isFailure(connectionResult)).toBe(true);

      const events = yield* admin.listAuditEvents();
      expect(
        events
          .filter((event) => event.resourceId === String(clientSlug))
          .map((event) => event.action),
      ).toEqual(expect.arrayContaining(["created", "rolled_back", "rollback_failed"]));
      expect(
        events
          .filter((event) => event.resourceId === "rollbackFailure")
          .map((event) => event.action),
      ).toEqual(expect.arrayContaining(["created", "rolled_back", "rollback_failed"]));
    }).pipe(Effect.scoped),
  );

  it.effect("attempts later credential restores after one fails and audits the failure", () =>
    Effect.gen(function* () {
      const store = new Map<string, string>();
      const deleteAttempts: string[] = [];
      let armed = false;
      const provider: CredentialProvider = {
        key: ProviderKey.make("memory"),
        writable: true,
        get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
        set: (id, value) =>
          armed && String(id).endsWith(":third")
            ? Effect.fail(new StorageError({ message: "third write refused", cause: undefined }))
            : Effect.sync(() => void store.set(String(id), value)),
        delete: (id) =>
          Effect.sync(() => {
            const itemId = String(id);
            deleteAttempts.push(itemId);
            if (!itemId.endsWith(":first")) store.delete(itemId);
          }).pipe(
            Effect.andThen(
              String(id).endsWith(":first")
                ? Effect.fail(
                    new StorageError({ message: "first restore refused", cause: undefined }),
                  )
                : Effect.void,
            ),
          ),
      };
      const { executor, admin } = yield* setup(undefined, provider);
      yield* executor["audit-test"].seed();
      armed = true;

      const result = yield* executor.connections
        .create({
          owner: "org",
          name: ConnectionName.make("attempt-all-restores"),
          integration: INTEGRATION,
          template: TEMPLATE,
          values: { first: "one", second: "two", third: "three" },
        })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      expect(deleteAttempts).toHaveLength(2);
      expect(deleteAttempts[0]).toMatch(/:first$/);
      expect(deleteAttempts[1]).toMatch(/:second$/);
      expect([...store.keys()]).toHaveLength(1);
      expect([...store.keys()][0]).toMatch(/:first$/);
      const actions = (yield* admin.listAuditEvents())
        .filter((event) => event.resourceId === "attemptAllRestores")
        .map((event) => event.action);
      expect(actions).toEqual(
        expect.arrayContaining(["created", "rolled_back", "rollback_failed"]),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("does not overwrite a concurrent OAuth-client successor during compensation", () =>
    Effect.gen(function* () {
      const controlled = racingProvider();
      let armed = false;
      const auditPlugin = makeAuditPlugin(controlled.provider);
      const config = makeTestConfig({
        tenant: "audit-tenant",
        subject: "actor-123",
        plugins: [auditPlugin] as const,
      });
      const executor = yield* createExecutor({
        ...config,
        db: replaceOAuthClientBeforeCompensationRecheck(
          config.db,
          () => armed,
          controlled.installSuccessorSecret,
        ),
      });
      yield* Effect.addFinalizer(() =>
        executor
          .close()
          .pipe(Effect.andThen(Effect.promise(() => config.testDb.close())), Effect.ignore),
      );
      const slug = OAuthClientSlug.make("racing-app");
      const base = {
        owner: "org" as const,
        slug,
        authorizationUrl: "https://example.test/authorize",
        tokenUrl: "https://example.test/token",
        grant: "authorization_code" as const,
      };
      yield* executor.oauth.createClient({
        ...base,
        clientId: "original-client-id",
        clientSecret: "original-secret",
      });
      controlled.armFailure();
      armed = true;

      const result = yield* executor.oauth
        .createClient({
          ...base,
          clientId: "stale-client-id",
          clientSecret: "stale-secret",
        })
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(yield* executor.oauth.listClients()).toEqual([
        expect.objectContaining({ slug, clientId: "successor-client-id" }),
      ]);
      expect(controlled.values()).not.toContain("partial-stale-write");
      expect(controlled.values()).toEqual(expect.arrayContaining(["successor-secret"]));
    }).pipe(Effect.scoped),
  );
});
