import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { createExecutor, type ExecutorAdmin } from "./executor";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ProviderItemId,
  ProviderKey,
  Tenant,
} from "./ids";
import { definePlugin } from "./plugin";
import type { CredentialProvider } from "./provider";
import { makeTestConfig } from "./testing";

const INTEGRATION = IntegrationSlug.make("example");
const TEMPLATE = AuthTemplateSlug.make("apiKey");

const memoryProvider = (): CredentialProvider => {
  const store = new Map<string, string>();
  return {
    key: ProviderKey.make("memory"),
    writable: true,
    get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
    set: (id, value) => Effect.sync(() => void store.set(String(id), value)),
    delete: (id) => Effect.sync(() => void store.delete(String(id))),
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

const auditPlugin = definePlugin(() => ({
  id: "audit-test" as const,
  credentialProviders: [memoryProvider()],
  storage: () => ({}),
  extension: (ctx) => ({
    seed: () =>
      ctx.core.integrations.register({
        slug: INTEGRATION,
        description: "Example",
        config: {},
      }),
  }),
}))();

const requireAdmin = (admin: ExecutorAdmin | undefined) =>
  admin === undefined ? Effect.die("expected a platform admin view") : Effect.succeed(admin);

const setup = () =>
  Effect.gen(function* () {
    const config = makeTestConfig({
      tenant: "audit-tenant",
      subject: "actor-123",
      plugins: [auditPlugin] as const,
    });
    const executor = yield* createExecutor(config);
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

      yield* executor.integrations.update(INTEGRATION, { name: "Renamed" });
      yield* executor.integrations.remove(INTEGRATION);

      const events = yield* admin.listAuditEvents();
      expect(events).toHaveLength(10);
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
        ]),
      );

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
});
