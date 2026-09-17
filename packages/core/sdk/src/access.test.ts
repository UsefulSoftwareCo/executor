// ---------------------------------------------------------------------------
// ExecutorAccess — the product/core boundary itself.
//
// `createExecutor` requires an access value, validates it against the
// binding, and ENFORCES its decisions without owning any of them. These
// tests pin the contract with the REAL product implementations
// (@executor-js/product-access, resolved via the workspace root
// devDependency):
//   - a malformed access fails the boot loudly;
//   - the settings decision is consulted live, never snapshotted;
//   - `owners` really filters storage CRUD and the tool surfaces (org-only
//     and personal-only views included — core forces no partition);
//   - the `toolPolicy` hook is the ONLY policy authority core consults;
//   - the tenant clamp holds even under an over-permissive access.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref } from "effect";

import { standardToolPolicy } from "@executor-js/product-access/policy";
import { testAccess } from "@executor-js/product-access/testing";

import { executorAccessViolation, type ExecutorAccess } from "./access";
import { createExecutor } from "./executor";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
  ProviderKey,
  Tenant,
  ToolAddress,
  ToolName,
} from "./ids";
import { definePlugin } from "./plugin";
import type { CredentialProvider } from "./provider";
import { makeTestConfig } from "./testing";

const memberShaped: ExecutorAccess = testAccess.member();

/** A subject-bound binding whose product view is PERSONAL-ONLY — no
 *  production posture ships this shape yet, which is exactly the point: the
 *  contract must carry it without core forcing the org partition back in. */
const personalOnlyAccess = (): ExecutorAccess => ({
  ...testAccess.member(),
  owners: ["user"],
  toolPolicy: standardToolPolicy(["user"]),
});

/** An org-only view for a subject-BOUND member (narrower than identity). */
const orgOnlyMemberAccess = (): ExecutorAccess => ({
  ...testAccess.member(),
  owners: ["org"],
  toolPolicy: standardToolPolicy(["org"]),
});

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
        Array.from(store.keys()).map((key) => ({ id: ProviderItemId.make(key), name: key })),
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
    Effect.succeed({ tools: [{ name: ToolName.make("deploy"), description: "deploy" }] }),
  invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
  extension: (ctx) => ({
    seed: () => ctx.core.integrations.register({ slug: INTEG, description: "Vercel", config: {} }),
  }),
}))();

/** Seed one org and one user connection (with their tools) plus one org and
 *  one user policy row, through a full-view member executor. */
const seedWorkspace = Effect.fn("seedWorkspace")(function* (
  config: ReturnType<typeof makeTestConfig<readonly [typeof demoPlugin]>>,
) {
  const admin = yield* createExecutor(config);
  yield* Effect.addFinalizer(() => admin.close().pipe(Effect.ignore));
  yield* admin.demo.seed();
  yield* admin.connections.create({
    owner: "org",
    name: ConnectionName.make("shared"),
    integration: INTEG,
    template: TEMPLATE,
    value: "org-token",
  });
  yield* admin.connections.create({
    owner: "user",
    name: ConnectionName.make("mine"),
    integration: INTEG,
    template: TEMPLATE,
    value: "user-token",
  });
  yield* admin.policies.create({ owner: "org", pattern: "github.*", action: "block" });
  yield* admin.policies.create({ owner: "user", pattern: "linear.*", action: "approve" });
  return admin;
});

describe("executorAccessViolation", () => {
  it("accepts the production postures against their bindings", () => {
    expect(executorAccessViolation(memberShaped, "subject-1")).toBeNull();
    expect(executorAccessViolation(testAccess.org(), null)).toBeNull();
    expect(executorAccessViolation(testAccess.platform({ subject: false }), null)).toBeNull();
    // Personal-only is a VALID product shape: core mandates no partition.
    expect(executorAccessViolation(personalOnlyAccess(), "subject-1")).toBeNull();
  });

  it("rejects an empty owners list", () => {
    expect(executorAccessViolation({ ...memberShaped, owners: [] }, "subject-1")).toContain(
      "must not be empty",
    );
  });

  it("rejects a duplicated owner", () => {
    expect(executorAccessViolation({ ...memberShaped, owners: ["user", "user"] }, "s")).toContain(
      "repeat",
    );
  });

  it("rejects a user partition on a subject-less binding", () => {
    expect(executorAccessViolation(memberShaped, null)).toContain("no subject");
  });
});

describe("createExecutor access validation", () => {
  it.effect("fails the boot when the access does not fit the binding", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({ access: testAccess.org(), subject: null });
      const error = yield* Effect.flip(
        // member-shaped access (user partition) on a subject-less binding.
        createExecutor({ ...config, access: testAccess.member() }),
      );
      expect(error).toMatchObject({
        _tag: "StorageError",
        message: expect.stringContaining("no subject"),
      });
    }),
  );
});

describe("settingsWrite is consulted live", () => {
  it.effect("a flipped decision applies to the next guarded call, not a snapshot", () =>
    Effect.gen(function* () {
      const decision = yield* Ref.make<"allowed" | "denied">("allowed");
      const config = makeTestConfig({
        access: {
          ...testAccess.member(),
          settingsWrite: (target) =>
            target.kind === "owner" && target.owner === "user"
              ? Effect.succeed("allowed" as const)
              : Ref.get(decision),
        },
      });
      const executor = yield* createExecutor(config);
      yield* Effect.addFinalizer(() => executor.close().pipe(Effect.ignore));

      const created = yield* executor.policies.create({
        owner: "org",
        pattern: "vercel.*",
        action: "block",
      });
      expect(created.pattern).toBe("vercel.*");

      yield* Ref.set(decision, "denied");
      const error = yield* Effect.flip(
        executor.policies.create({ owner: "org", pattern: "github.*", action: "block" }),
      );
      expect(error).toMatchObject({ _tag: "OrgWriteDeniedError" });

      // Personal-scope writes stay open under the denied decision.
      const personal = yield* executor.policies.create({
        owner: "user",
        pattern: "linear.*",
        action: "approve",
      });
      expect(personal.owner).toBe("user");
    }).pipe(Effect.scoped),
  );
});

describe("owners really filters storage and tool surfaces", () => {
  it.effect("an org-only member view sees no user rows anywhere", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({
        access: testAccess.member(),
        plugins: [demoPlugin] as const,
      });
      yield* seedWorkspace(config);

      const orgOnly = yield* createExecutor({ ...config, access: orgOnlyMemberAccess() });
      yield* Effect.addFinalizer(() => orgOnly.close().pipe(Effect.ignore));

      const policies = yield* orgOnly.policies.list();
      expect(policies.map((p) => p.owner)).toEqual(["org"]);

      const connections = yield* orgOnly.connections.list();
      expect(connections.map((c) => `${c.owner}:${c.name}`)).toEqual(["org:shared"]);

      const tools = yield* orgOnly.tools.list();
      const dynamic = tools.filter((t) => !t.static);
      expect(dynamic.map((t) => `${t.owner}:${t.connection}`)).toEqual(["org:shared"]);

      // The excluded partition is not writable either: the settings gate
      // (personal stays open) passes, and the STORAGE clamp refuses.
      const error = yield* Effect.flip(
        orgOnly.policies.create({ owner: "user", pattern: "x.*", action: "approve" }),
      );
      expect(error).toMatchObject({
        _tag: "StorageError",
        message: expect.stringContaining("does not include"),
      });
    }).pipe(Effect.scoped),
  );

  it.effect("a personal-only view sees no org rows anywhere", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({
        access: testAccess.member(),
        plugins: [demoPlugin] as const,
      });
      yield* seedWorkspace(config);

      const personal = yield* createExecutor({ ...config, access: personalOnlyAccess() });
      yield* Effect.addFinalizer(() => personal.close().pipe(Effect.ignore));

      const policies = yield* personal.policies.list();
      expect(policies.map((p) => p.owner)).toEqual(["user"]);

      const connections = yield* personal.connections.list();
      expect(connections.map((c) => `${c.owner}:${c.name}`)).toEqual(["user:mine"]);

      const tools = yield* personal.tools.list();
      const dynamic = tools.filter((t) => !t.static);
      expect(dynamic.map((t) => `${t.owner}:${t.connection}`)).toEqual(["user:mine"]);

      // Invoking a tool over the hidden org connection fails as not-found —
      // the row is invisible, not merely blocked.
      const invokeError = yield* Effect.flip(
        personal.execute(ToolAddress.make(`tools.${INTEG}.org.shared.deploy`), {}),
      );
      expect(invokeError).toMatchObject({ _tag: "ToolNotFoundError" });

      // Shared-catalog (org-partition) writes refuse loudly at storage.
      const writeError = yield* Effect.flip(
        personal.policies.create({ owner: "org", pattern: "x.*", action: "block" }),
      );
      expect(writeError).toMatchObject({
        _tag: "StorageError",
        message: expect.stringContaining("does not include"),
      });
    }).pipe(Effect.scoped),
  );
});

describe("the product toolPolicy hook is the only policy authority", () => {
  it.effect("a hook that blocks everything gates execute and list, whatever rows say", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({
        access: testAccess.member(),
        plugins: [demoPlugin] as const,
      });
      yield* seedWorkspace(config);

      const blockAll: ExecutorAccess = {
        ...testAccess.member(),
        toolPolicy: () =>
          Effect.succeed({
            resolve: () =>
              Effect.succeed({ action: "block" as const, source: "user" as const, pattern: "*" }),
          }),
      };
      const executor = yield* createExecutor({ ...config, access: blockAll });
      yield* Effect.addFinalizer(() => executor.close().pipe(Effect.ignore));

      const tools = yield* executor.tools.list();
      expect(tools.filter((t) => !t.static)).toHaveLength(0);
      const error = yield* Effect.flip(
        executor.execute(ToolAddress.make(`tools.${INTEG}.org.shared.deploy`), {}),
      );
      expect(error).toMatchObject({ _tag: "ToolBlockedError" });
    }).pipe(Effect.scoped),
  );

  it.effect("a hook that approves everything overrides a stored org block", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({
        access: testAccess.member(),
        plugins: [demoPlugin] as const,
      });
      const admin = yield* seedWorkspace(config);
      // A stored rule that would block the tool under the standard product
      // resolution — proving core itself never consults the rows.
      yield* admin.policies.create({ owner: "org", pattern: "*", action: "block" });

      const approveAll: ExecutorAccess = {
        ...testAccess.member(),
        toolPolicy: () =>
          Effect.succeed({
            resolve: () =>
              Effect.succeed({
                action: "approve" as const,
                source: "plugin-default" as const,
              }),
          }),
      };
      const executor = yield* createExecutor({ ...config, access: approveAll });
      yield* Effect.addFinalizer(() => executor.close().pipe(Effect.ignore));

      const result = yield* executor.execute(
        ToolAddress.make(`tools.${INTEG}.org.shared.deploy`),
        {},
      );
      expect(result).toMatchObject({ ran: "deploy" });
    }).pipe(Effect.scoped),
  );
});

describe("tenant clamp is not product-configurable", () => {
  it.effect("an over-permissive access never reads another tenant's rows", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({
        access: testAccess.member(),
        plugins: [demoPlugin] as const,
      });
      yield* seedWorkspace(config);

      // Same database, different tenant, maximally permissive product view.
      const intruder = yield* createExecutor({
        ...config,
        tenant: Tenant.make("other-tenant"),
        access: {
          ...testAccess.member(),
          toolPolicy: () =>
            Effect.succeed({
              resolve: () =>
                Effect.succeed({
                  action: "approve" as const,
                  source: "plugin-default" as const,
                }),
            }),
        },
      });
      yield* Effect.addFinalizer(() => intruder.close().pipe(Effect.ignore));

      expect(yield* intruder.policies.list()).toHaveLength(0);
      expect(yield* intruder.connections.list()).toHaveLength(0);
      expect((yield* intruder.tools.list()).filter((t) => !t.static)).toHaveLength(0);
      const error = yield* Effect.flip(
        intruder.execute(ToolAddress.make(`tools.${INTEG}.org.shared.deploy`), {}),
      );
      expect(error).toMatchObject({ _tag: "ToolNotFoundError" });
    }).pipe(Effect.scoped),
  );
});
