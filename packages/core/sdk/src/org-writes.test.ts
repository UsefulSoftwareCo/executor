import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ProviderItemId,
  ProviderKey,
  ToolAddress,
  ToolName,
} from "./ids";
import { createExecutor } from "./executor";
import { definePlugin } from "./plugin";
import type { CredentialProvider } from "./provider";
import { makeTestConfig } from "./testing";

// ---------------------------------------------------------------------------
// `ExecutorConfig.orgWrites` — the workspace-settings gate.
//
// A `"denied"` binding (a plain member) may USE workspace resources — read
// them, execute tools over org connections — but every user-intent
// workspace-level mutation refuses with `OrgWriteDeniedError`: all new
// connections, org-owned policies / OAuth clients, and the tenant-shared
// integration catalog. `"allowed"` (admins, and hosts with no role model)
// behaves exactly as before.
//
// The fixtures build TWO executors over ONE test database: an admin
// (default `orgWrites`) that seeds the workspace, and a member
// (`orgWrites: "denied"`) that the assertions run against.
// ---------------------------------------------------------------------------

const memoryProvider = (): CredentialProvider => {
  const store = new Map<string, string>();
  return {
    key: ProviderKey.make("memory"),
    writable: true,
    get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
    set: (id, value) => Effect.sync(() => void store.set(String(id), value)),
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

const INTEG = IntegrationSlug.make("vercel");
const TEMPLATE = AuthTemplateSlug.make("apiKey");

const demoPlugin = definePlugin(() => ({
  id: "demo" as const,
  credentialProviders: [memoryProvider()],
  storage: () => ({}),
  resolveTools: () =>
    Effect.succeed({
      tools: [{ name: ToolName.make("deploy"), description: "deploy" }],
    }),
  invokeTool: ({ toolRow, credential }) =>
    Effect.succeed({ ran: toolRow.name, value: credential.value }),
  extension: (ctx) => ({
    seed: () =>
      ctx.core.integrations.register({
        slug: INTEG,
        description: "Vercel",
        config: {},
      }),
    seedFresh: () =>
      ctx.core.integrations.register({
        slug: IntegrationSlug.make("fresh"),
        description: "Fresh",
        config: {},
      }),
  }),
}))();

const setup = () =>
  Effect.gen(function* () {
    const config = makeTestConfig({ plugins: [demoPlugin] as const });
    const admin = yield* createExecutor(config);
    const member = yield* createExecutor({ ...config, orgWrites: "denied" });
    yield* Effect.addFinalizer(() =>
      admin.close().pipe(Effect.andThen(member.close()), Effect.ignore),
    );
    yield* admin.demo.seed();
    return { admin, member };
  });

const expectOrgWriteDenied = <A, R>(effect: Effect.Effect<A, unknown, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => {
      expect(error).toMatchObject({ _tag: "OrgWriteDeniedError" });
    }),
  );

describe("orgWrites: denied", () => {
  it.effect("refuses org tool policies but accepts user ones", () =>
    Effect.gen(function* () {
      const { member } = yield* setup();
      yield* expectOrgWriteDenied(
        member.policies.create({ owner: "org", pattern: "*", action: "block" }),
      );
      const mine = yield* member.policies.create({
        owner: "user",
        pattern: "*",
        action: "require_approval",
      });
      yield* expectOrgWriteDenied(
        member.policies.update({ id: mine.id, owner: "org", action: "block" }),
      );
      yield* expectOrgWriteDenied(member.policies.remove({ id: mine.id, owner: "org" }));
      yield* member.policies.update({ id: mine.id, owner: "user", action: "approve" });
      yield* member.policies.remove({ id: mine.id, owner: "user" });
    }).pipe(Effect.scoped),
  );

  it.effect("refuses new workspace and personal connections", () =>
    Effect.gen(function* () {
      const { admin, member } = yield* setup();
      yield* expectOrgWriteDenied(
        member.connections.create({
          owner: "org",
          name: ConnectionName.make("shared"),
          integration: INTEG,
          template: TEMPLATE,
          value: "org-token",
        }),
      );
      yield* expectOrgWriteDenied(
        member.connections.create({
          owner: "user",
          name: ConnectionName.make("mine"),
          integration: INTEG,
          template: TEMPLATE,
          value: "user-token",
        }),
      );

      const shared = yield* admin.connections.create({
        owner: "org",
        name: ConnectionName.make("shared"),
        integration: INTEG,
        template: TEMPLATE,
        value: "org-token",
      });
      const ref = { owner: shared.owner, integration: shared.integration, name: shared.name };
      yield* expectOrgWriteDenied(member.connections.update(ref, { description: "renamed" }));
      yield* expectOrgWriteDenied(member.connections.remove(ref));
    }).pipe(Effect.scoped),
  );

  it.effect("still USES the workspace: reads org rows and executes org-connection tools", () =>
    Effect.gen(function* () {
      const { admin, member } = yield* setup();
      yield* admin.connections.create({
        owner: "org",
        name: ConnectionName.make("shared"),
        integration: INTEG,
        template: TEMPLATE,
        value: "org-token",
      });
      const visible = yield* member.connections.list({ owner: "org" });
      expect(visible.map((c) => String(c.name))).toContain("shared");
      const out = yield* member.execute(ToolAddress.make("tools.vercel.org.shared.deploy"), {});
      expect(out).toMatchObject({ ran: "deploy", value: "org-token" });
    }).pipe(Effect.scoped),
  );

  it.effect("refuses catalog mutations: new registration, update, health check, removal", () =>
    Effect.gen(function* () {
      const { member } = yield* setup();
      // A NEW slug is refused through the plugin ctx register path (the seam
      // every add-integration flow funnels through)…
      yield* expectOrgWriteDenied(member.demo.seedFresh());
      const fresh = yield* member.integrations.get(IntegrationSlug.make("fresh"));
      expect(fresh).toBeNull();
      // …and so are the public catalog mutations.
      yield* expectOrgWriteDenied(member.integrations.update(INTEG, { name: "Renamed" }));
      yield* expectOrgWriteDenied(member.integrations.healthCheck.set(INTEG, null));
      yield* expectOrgWriteDenied(member.integrations.remove(INTEG));
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the register REPLACE arm open (config rewrites converge for members)", () =>
    Effect.gen(function* () {
      const { member } = yield* setup();
      // The admin already registered `vercel`; re-registering the same slug on
      // the denied binding is the replace arm and must succeed — this is the
      // path catalog rebuilds and legacy healing converge through.
      yield* member.demo.seed();
      const row = yield* member.integrations.get(INTEG);
      expect(row?.slug).toBe(INTEG);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses org OAuth clients and all new connect flows", () =>
    Effect.gen(function* () {
      const { member } = yield* setup();
      yield* expectOrgWriteDenied(
        member.oauth.createClient({
          owner: "org",
          slug: OAuthClientSlug.make("shared-app"),
          authorizationUrl: "https://example.com/authorize",
          tokenUrl: "https://example.com/token",
          grant: "authorization_code",
          clientId: "client-id",
          clientSecret: "",
        }),
      );
      yield* expectOrgWriteDenied(
        member.oauth.removeClient("org", OAuthClientSlug.make("shared-app")),
      );
      yield* expectOrgWriteDenied(
        member.oauth.start({
          owner: "org",
          clientOwner: "org",
          client: OAuthClientSlug.make("shared-app"),
          integration: INTEG,
          template: TEMPLATE,
          name: ConnectionName.make("shared"),
        }),
      );
      // Personal clients stay open.
      const slug = yield* member.oauth.createClient({
        owner: "user",
        slug: OAuthClientSlug.make("my-app"),
        authorizationUrl: "https://example.com/authorize",
        tokenUrl: "https://example.com/token",
        grant: "authorization_code",
        clientId: "client-id",
        clientSecret: "",
      });
      expect(String(slug)).toBe("my-app");
      yield* expectOrgWriteDenied(
        member.oauth.start({
          owner: "user",
          clientOwner: "user",
          client: slug,
          integration: INTEG,
          template: TEMPLATE,
          name: ConnectionName.make("mine"),
          newConnection: true,
        }),
      );
    }).pipe(Effect.scoped),
  );
});

describe("orgWrites: default (allowed)", () => {
  it.effect("admin bindings mutate workspace-level state as before", () =>
    Effect.gen(function* () {
      const { admin } = yield* setup();
      const policy = yield* admin.policies.create({
        owner: "org",
        pattern: "*",
        action: "require_approval",
      });
      expect(policy.owner).toBe("org");
      yield* admin.policies.remove({ id: policy.id, owner: "org" });
      yield* admin.integrations.update(INTEG, { name: "Vercel (renamed)" });
      const row = yield* admin.integrations.get(INTEG);
      expect(row?.name).toBe("Vercel (renamed)");
    }).pipe(Effect.scoped),
  );
});
