import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";
import { withQueryContext } from "@executor-js/fumadb/query";

import { createExecutor, type Executor } from "./executor";
import { type StorageError } from "./fuma-runtime";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderKey,
  Subject,
  ToolAddress,
  ToolName,
} from "./ids";
import { definePlugin } from "./plugin";
import type { CredentialProvider } from "./provider";
import { makeTestConfig } from "./testing";

// ---------------------------------------------------------------------------
// Removing an integration must cascade to EVERY member's rows under it, not
// just the remover's own. Before this, a bound admin's delete only reached
// its own subject's connections and tools; everyone else's survived as
// orphans — absent from the catalog, yet still listed to agents and still a
// valid `oauth.start` target that failed only at the mint.
//
// The fixtures build TWO executors over ONE test database, bound to two
// different subjects. `alice` (the admin) seeds and removes; `bob` connects.
// ---------------------------------------------------------------------------

const memoryProvider = (): CredentialProvider => {
  const store = new Map<string, string>();
  return {
    key: ProviderKey.make("memory"),
    writable: true,
    get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
    set: (id, value) => Effect.sync(() => void store.set(String(id), value)),
    delete: (id) => Effect.sync(() => void store.delete(String(id))),
  };
};

const INTEG = IntegrationSlug.make("datadog");
const KEPT = IntegrationSlug.make("linear");
const TEMPLATE = AuthTemplateSlug.make("apiKey");
const ALICE = "user_alice";
const BOB = "user_bob";

const demoPlugin = definePlugin(() => ({
  id: "demo" as const,
  credentialProviders: [memoryProvider()],
  storage: () => ({}),
  resolveTools: () =>
    Effect.succeed({
      tools: [{ name: ToolName.make("query"), description: "query" }],
    }),
  invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
  extension: (ctx) => ({
    seed: (slug: IntegrationSlug) =>
      ctx.core.integrations.register({ slug, description: String(slug), config: {} }),
  }),
}))();

const setup = () =>
  Effect.gen(function* () {
    const config = makeTestConfig({ plugins: [demoPlugin] as const, subject: ALICE });
    const alice = yield* createExecutor(config);
    const bob = yield* createExecutor({
      ...config,
      subject: Subject.make(BOB),
      db: withQueryContext(config.testDb.db, { tenant: String(config.tenant), subject: BOB }),
    });
    yield* Effect.addFinalizer(() =>
      alice.close().pipe(Effect.andThen(bob.close()), Effect.ignore),
    );
    yield* alice.demo.seed(INTEG);
    yield* alice.demo.seed(KEPT);
    return { alice, bob, config };
  });

const connectPersonal = (executor: Executor, integration: IntegrationSlug, name: string) =>
  executor.connections.create({
    owner: "user",
    name: ConnectionName.make(name),
    integration,
    template: TEMPLATE,
    value: `token-${name}`,
  });

describe("integrations.remove cascade", () => {
  it.effect("drops every subject's connections and tools under the removed slug", () =>
    Effect.gen(function* () {
      const { alice, bob, config } = yield* setup();
      yield* connectPersonal(alice, INTEG, "aliceDd");
      yield* connectPersonal(bob, INTEG, "bobDd");
      yield* connectPersonal(bob, KEPT, "bobLinear");

      yield* alice.integrations.remove(INTEG);

      // Tenant-wide view of what is actually stored, across both subjects.
      const wide = withQueryContext(config.testDb.db, {
        tenant: String(config.tenant),
        subject: null,
        reach: "tenant",
      });
      const connectionRows = yield* Effect.promise(() => wide.findMany("connection", {}));
      const toolRows = yield* Effect.promise(() => wide.findMany("tool", {}));
      expect(connectionRows.map((row) => `${row["subject"]}:${row["integration"]}`).sort()).toEqual(
        [`${BOB}:${KEPT}`],
      );
      expect(toolRows.every((row) => row["integration"] === String(KEPT))).toBe(true);
      expect(toolRows.length).toBeGreaterThan(0);

      // Bob's other integration is untouched, and he sees it.
      const bobConnections = yield* bob.connections.list();
      expect(bobConnections.map((c) => String(c.integration))).toEqual([String(KEPT)]);
    }).pipe(Effect.scoped),
  );

  it.effect("a member (org writes denied) still cannot remove", () =>
    Effect.gen(function* () {
      const { config } = yield* setup();
      const member = yield* createExecutor({ ...config, orgWrites: "denied" });
      yield* Effect.addFinalizer(() => member.close().pipe(Effect.ignore));
      const error = yield* Effect.flip(member.integrations.remove(INTEG));
      expect(Predicate.isTagged("OrgWriteDeniedError")(error)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("the platform view cannot remove (read-only holds ahead of the cascade)", () =>
    Effect.gen(function* () {
      const { config } = yield* setup();
      const platform = yield* createExecutor({ ...config, platformView: true });
      yield* Effect.addFinalizer(() => platform.close().pipe(Effect.ignore));
      yield* platform.integrations.remove(INTEG).pipe(
        Effect.flatMap(() => Effect.die("expected the platform view to refuse the removal")),
        Effect.catchTag("StorageError", (error: StorageError) => {
          expect(error.message).toContain("read-only");
          return Effect.void;
        }),
        Effect.orDie,
      );
    }).pipe(Effect.scoped),
  );
});

describe("orphaned rows are not served", () => {
  // Simulate the pre-fix state: rows whose integration is gone from the
  // catalog. Delete the catalog row directly, bypassing the cascade.
  const orphanBob = (config: ReturnType<typeof makeTestConfig>) =>
    Effect.promise(() =>
      withQueryContext(config.testDb.db, {
        tenant: String(config.tenant),
        subject: ALICE,
      }).deleteMany("integration", { where: (b) => b("slug", "=", String(INTEG)) }),
    );

  it.effect(
    "tools.list and connections.list hide them; invoke reports the missing integration",
    () =>
      Effect.gen(function* () {
        const { bob, config } = yield* setup();
        yield* connectPersonal(bob, INTEG, "bobDd");
        yield* connectPersonal(bob, KEPT, "bobLinear");
        const address = ToolAddress.make(`tools.${INTEG}.user.bobDd.query`);
        expect(yield* bob.execute(address, {})).toEqual({ ran: "query" });

        yield* orphanBob(config);
        // The orphan is still stored — only its catalog row is gone.
        const stored = yield* Effect.promise(() =>
          withQueryContext(config.testDb.db, {
            tenant: String(config.tenant),
            subject: BOB,
          }).findMany("tool", {}),
        );
        expect(stored.map((row) => String(row.integration)).sort()).toEqual([
          String(INTEG),
          String(KEPT),
        ]);

        const tools = yield* bob.tools.list();
        expect(tools.filter((t) => !t.static).map((t) => String(t.integration))).toEqual([
          String(KEPT),
        ]);
        const connections = yield* bob.connections.list();
        expect(connections.map((c) => String(c.integration))).toEqual([String(KEPT)]);

        const error = yield* Effect.flip(bob.execute(address, {}));
        expect(Predicate.isTagged("IntegrationNotFoundError")(error)).toBe(true);
      }).pipe(Effect.scoped),
  );
});
