import { describe, expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Fiber,
  Inspectable,
  Logger,
  Option,
  Predicate,
  Result,
  Schema,
} from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
  ProviderKey,
  Subject,
  Tenant,
  ToolAddress,
  ToolName,
} from "./ids";
import { createExecutor } from "./executor";
import { StorageError, type FumaDb } from "./fuma-runtime";
import { HealthCheckResult } from "./health-check";
import { definePlugin } from "./plugin";
import type { CredentialProvider } from "./provider";
import { makeTestConfig, makeTestExecutor } from "./testing";
import { ToolResult } from "./tool-result";

// removed: v1 connection-refresh lifecycle, ConnectionProvider.refresh,
// SecretProvider, accessToken token-refresh + in-flight dedup tests — the v2
// model folds secret/connection into one provider-resolved Connection, and OAuth
// refresh is core's responsibility (stubbed for milestone 1). The cases below
// cover the v2 connection surface: create (inline + external), list, get,
// remove, refresh, and per-connection tool production.

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

/** Wrap a test `FumaDb` so every transaction it opens is observable. The
 *  executor re-binds its own owner context onto the handle it is given, so the
 *  wrapper must forward `withContext` re-wrapped — otherwise the instrument is
 *  dropped before any executor query runs. */
const instrumentTransactions = (
  db: FumaDb,
  hooks: { readonly enter: () => void; readonly exit: () => void },
): FumaDb => {
  const wrap = (inner: FumaDb): FumaDb =>
    new Proxy(inner, {
      get(target, prop) {
        if (prop === "withContext") {
          return (context: unknown) =>
            wrap((target.withContext as (c: unknown) => FumaDb)(context));
        }
        if (prop === "transaction") {
          return async (run: Parameters<FumaDb["transaction"]>[0]) => {
            hooks.enter();
            // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: test instrument must unwind on both outcomes
            try {
              return await target.transaction(run);
            } finally {
              hooks.exit();
            }
          };
        }
        return Reflect.get(target, prop);
      },
    });
  return wrap(db);
};

const ConnectionListHealthOutput = Schema.Struct({
  connections: Schema.Array(Schema.Struct({ lastHealth: Schema.NullOr(HealthCheckResult) })),
});
const decodeConnectionListHealthOutput = Schema.decodeUnknownEffect(ConnectionListHealthOutput);

const demoPlugin = definePlugin(() => ({
  id: "demo" as const,
  credentialProviders: [memoryProvider()],
  storage: () => ({}),
  resolveTools: () =>
    Effect.succeed({
      tools: [
        { name: ToolName.make("deploy"), description: "deploy" },
        { name: ToolName.make("list"), description: "list" },
      ],
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
    resolveValue: (owner: "org" | "user", name: string) =>
      ctx.connections.resolveValue({
        owner,
        integration: INTEG,
        name: ConnectionName.make(name),
      }),
  }),
}))();

const setup = () =>
  makeTestExecutor({ plugins: [demoPlugin] as const }).pipe(
    Effect.tap((executor) => executor.demo.seed()),
  );

describe("connections.create", () => {
  it.effect("inline value writes to the default writable provider and produces tools", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      const connection = yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: INTEG,
        template: TEMPLATE,
        value: "secret-token",
      });
      expect(connection.provider).toBe(ProviderKey.make("memory"));
      expect(String(connection.address)).toBe("tools.vercel.org.main");

      const tools = yield* executor.tools.list();
      expect(tools.map((t) => String(t.name)).sort()).toEqual(["deploy", "list"]);

      // The inline value is resolvable via the connection's provider.
      const value = yield* executor.demo.resolveValue("org", "main");
      expect(value).toBe("secret-token");
    }),
  );

  it.effect("normalizes free-form names into JS-callable connection identifiers", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      const connection = yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("my-api-key"),
        integration: INTEG,
        template: TEMPLATE,
        value: "secret-token",
      });

      expect(String(connection.name)).toBe("myApiKey");
      expect(String(connection.address)).toBe("tools.vercel.org.myApiKey");

      const tools = yield* executor.tools.list();
      expect(tools.map((t) => String(t.address)).sort()).toEqual([
        "tools.vercel.org.myApiKey.deploy",
        "tools.vercel.org.myApiKey.list",
      ]);

      const value = yield* executor.demo.resolveValue("org", "myApiKey");
      expect(value).toBe("secret-token");
    }),
  );

  it.effect("external `from` references a provider item without writing it", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      const connection = yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("byo"),
        integration: INTEG,
        template: TEMPLATE,
        from: {
          provider: ProviderKey.make("memory"),
          id: ProviderItemId.make("ext-item"),
        },
      });
      expect(connection.provider).toBe(ProviderKey.make("memory"));
      // No value was stored (external reference) — resolveValue returns null.
      const value = yield* executor.demo.resolveValue("org", "byo");
      expect(value).toBeNull();
    }),
  );

  it.effect("create on an unknown integration fails with IntegrationNotFoundError", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      const result = yield* Effect.result(
        executor.connections.create({
          owner: "org",
          name: ConnectionName.make("x"),
          integration: IntegrationSlug.make("unknown"),
          template: TEMPLATE,
          value: "v",
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("IntegrationNotFoundError")(result.failure)).toBe(true);
    }),
  );

  // A credentialed connection is "born wired": it must reference at least one
  // credential input. An empty binding (an empty `values`/`inputs` map) produces
  // a credential with no credential — it persists, produces a full tool catalog,
  // and then fails every invocation with `connection_value_missing`. These cases
  // must be rejected at create with a typed `InvalidConnectionInputError` (the
  // HTTP edge answers 400 with the reason, not an opaque 500). The exception is
  // the no-auth template ("none"), where zero inputs and an empty `item_ids`
  // map are the canonical shape — covered below. (An empty-STRING value is also
  // allowed, and an external `from` that resolves to null is a supported case —
  // both covered by their own tests.)
  it.effect("rejects an empty `values` map on a credentialed template and persists nothing", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      const result = yield* Effect.result(
        executor.connections.create({
          owner: "org",
          name: ConnectionName.make("empty"),
          integration: INTEG,
          template: TEMPLATE,
          values: {},
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("InvalidConnectionInputError")(result.failure)).toBe(true);
      // No connection row and — critically — no tools were produced.
      expect(yield* executor.connections.list()).toEqual([]);
      expect(yield* executor.tools.list()).toEqual([]);
    }),
  );

  it.effect("rejects an empty `inputs` map on a credentialed template", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      const result = yield* Effect.result(
        executor.connections.create({
          owner: "org",
          name: ConnectionName.make("empty2"),
          integration: INTEG,
          template: TEMPLATE,
          inputs: {},
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("InvalidConnectionInputError")(result.failure)).toBe(true);
      expect(yield* executor.connections.list()).toEqual([]);
    }),
  );

  // The no-auth template: public servers need no credential. The UI submits
  // `values: {}` for them and the persisted row carries an empty `item_ids`
  // map — that is the canonical shape (every migrated no-auth connection in
  // prod has it), so it must create cleanly and keep its tools on refresh.
  it.effect('creates a no-auth (`template: "none"`) connection from an empty `values` map', () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      const connection = yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("public"),
        integration: INTEG,
        template: AuthTemplateSlug.make("none"),
        values: {},
      });
      expect(String(connection.address)).toBe("tools.vercel.org.public");

      const tools = yield* executor.tools.list();
      expect(tools.map((t) => String(t.name)).sort()).toEqual(["deploy", "list"]);

      // Refresh must NOT treat the empty binding as invalid and wipe the tools.
      const refreshed = yield* executor.connections.refresh({
        owner: "org",
        integration: INTEG,
        name: ConnectionName.make("public"),
      });
      expect(refreshed.map((t) => String(t.name)).sort()).toEqual(["deploy", "list"]);
      expect((yield* executor.tools.list()).length).toBe(2);
    }),
  );

  it.effect("allows an empty-string value (no-auth integrations bind one)", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      const connection = yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("noauth"),
        integration: INTEG,
        template: TEMPLATE,
        value: "",
      });
      // The binding exists (non-empty item_ids), so tools are produced; the
      // empty value itself is the integration's concern, surfaced at invoke.
      expect(String(connection.address)).toBe("tools.vercel.org.noauth");
      const tools = yield* executor.tools.list();
      expect(tools.map((t) => String(t.name)).sort()).toEqual(["deploy", "list"]);
    }),
  );
});

describe("connections.list / get", () => {
  it.effect("only includes full health diagnostics in verbose core tool output", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({ plugins: [demoPlugin] as const, coreTools: {} });
      const executor = yield* createExecutor(config);
      yield* executor.demo.seed();
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("health"),
        integration: INTEG,
        template: TEMPLATE,
        value: "v",
      });

      const health = {
        status: "healthy" as const,
        identity: "account@example.com",
        checkedAt: 1234,
        httpStatus: 200,
        detail: "GET /me returned 200",
        responseSample: [{ path: "user.email", value: "account@example.com" }],
      };
      yield* Effect.promise(() =>
        config.db.updateMany("connection", {
          where: (b) => b.and(b("integration", "=", String(INTEG)), b("name", "=", "health")),
          set: { last_health: health },
        }),
      );

      const list = (input: { readonly verbose?: boolean }) =>
        executor
          .execute(ToolAddress.make("executor.coreTools.connections.list"), {
            integration: String(INTEG),
            owner: "org",
            ...input,
          })
          .pipe(Effect.flatMap(decodeConnectionListHealthOutput));

      const defaultList = yield* list({});
      const nonVerboseList = yield* list({ verbose: false });
      const verboseList = yield* list({ verbose: true });
      const summary = {
        status: "healthy",
        identity: "account@example.com",
        checkedAt: 1234,
      };

      expect(defaultList.connections[0]?.lastHealth).toEqual(summary);
      expect(nonVerboseList.connections[0]?.lastHealth).toEqual(summary);
      expect(verboseList.connections[0]?.lastHealth).toEqual(health);
    }),
  );

  it.effect("lists created connections and filters by integration", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("a"),
        integration: INTEG,
        template: TEMPLATE,
        value: "v",
      });
      const all = yield* executor.connections.list();
      expect(all.map((c) => String(c.name))).toEqual(["a"]);
      const filtered = yield* executor.connections.list({ integration: INTEG });
      expect(filtered.length).toBe(1);
      const get = yield* executor.connections.get({
        owner: "org",
        integration: INTEG,
        name: ConnectionName.make("a"),
      });
      expect(get?.name).toBe(ConnectionName.make("a"));
    }),
  );

  it.effect("get returns null for an unknown connection", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      const get = yield* executor.connections.get({
        owner: "org",
        integration: INTEG,
        name: ConnectionName.make("missing"),
      });
      expect(get).toBeNull();
    }),
  );
});

describe("connections.remove", () => {
  it.effect("removes the connection and its tools", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: INTEG,
        template: TEMPLATE,
        value: "v",
      });
      yield* executor.connections.remove({
        owner: "org",
        integration: INTEG,
        name: ConnectionName.make("main"),
      });
      const connections = yield* executor.connections.list();
      expect(connections).toEqual([]);
      const tools = yield* executor.tools.list();
      expect(tools).toEqual([]);
    }),
  );

  it.effect("remove on an unknown connection fails with ConnectionNotFoundError", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      const result = yield* Effect.result(
        executor.connections.remove({
          owner: "org",
          integration: INTEG,
          name: ConnectionName.make("missing"),
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("ConnectionNotFoundError")(result.failure)).toBe(true);
    }),
  );
});

describe("connections.refresh", () => {
  it.effect("re-produces the connection's tools", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: INTEG,
        template: TEMPLATE,
        value: "v",
      });
      const tools = yield* executor.connections.refresh({
        owner: "org",
        integration: INTEG,
        name: ConnectionName.make("main"),
      });
      expect(tools.map((t) => String(t.name)).sort()).toEqual(["deploy", "list"]);
    }),
  );
});

describe("tool catalog sync safety", () => {
  it.effect("single-flights concurrent refreshes of the same stale connection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const refreshStarted = yield* Deferred.make<void>();
        const releaseRefresh = yield* Deferred.make<void>();
        let resolutions = 0;
        const guardedPlugin = definePlugin(() => ({
          id: "guarded" as const,
          credentialProviders: [memoryProvider()],
          storage: () => ({}),
          remoteToolCatalog: true,
          resolveTools: () =>
            Effect.gen(function* () {
              resolutions += 1;
              if (resolutions > 1) {
                yield* Deferred.succeed(refreshStarted, undefined);
                yield* Deferred.await(releaseRefresh);
              }
              return {
                tools: [{ name: ToolName.make("deploy"), description: "deploy" }],
              };
            }),
          invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
          extension: (ctx) => ({
            seed: () =>
              ctx.core.integrations.register({
                slug: INTEG,
                description: "Vercel",
                config: {},
              }),
          }),
        }))();
        const config = makeTestConfig({ plugins: [guardedPlugin] as const });
        const executor = yield* createExecutor(config);
        yield* executor.guarded.seed();
        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
          value: "secret-token",
        });
        yield* Effect.promise(() =>
          config.db.updateMany("connection", {
            where: (b) => b.and(b("integration", "=", String(INTEG)), b("name", "=", "main")),
            set: { tools_synced_at: null },
          }),
        );

        const readsFiber = yield* Effect.forkChild(
          Effect.all(
            [
              executor.tools.list({ integration: INTEG }),
              executor.tools.list({ integration: INTEG }),
            ],
            { concurrency: "unbounded" },
          ),
        );
        yield* Deferred.await(refreshStarted);
        yield* Deferred.succeed(releaseRefresh, undefined);
        const reads = yield* Fiber.join(readsFiber);

        expect(reads).toHaveLength(2);
        expect(resolutions).toBe(2);
      }),
    ),
  );

  it.effect(
    "background sync preserves a nonzero remote catalog when a plugin returns authoritative empty",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let empty = false;
          const guardedPlugin = definePlugin(() => ({
            id: "guarded" as const,
            remoteToolCatalog: true,
            credentialProviders: [memoryProvider()],
            storage: () => ({}),
            resolveTools: () =>
              Effect.sync(() => ({
                tools: empty
                  ? []
                  : [
                      { name: ToolName.make("deploy"), description: "deploy" },
                      { name: ToolName.make("list"), description: "list" },
                    ],
              })),
            invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
            extension: (ctx) => ({
              seed: () =>
                ctx.core.integrations.register({
                  slug: INTEG,
                  description: "Vercel",
                  config: {},
                }),
            }),
          }))();
          const config = makeTestConfig({ plugins: [guardedPlugin] as const });
          const executor = yield* createExecutor(config);
          yield* executor.guarded.seed();
          yield* executor.connections.create({
            owner: "org",
            name: ConnectionName.make("main"),
            integration: INTEG,
            template: TEMPLATE,
            value: "secret-token",
          });

          empty = true;
          yield* Effect.promise(() =>
            config.db.updateMany("connection", {
              where: (b) => b.and(b("integration", "=", String(INTEG)), b("name", "=", "main")),
              set: { tools_synced_at: null },
            }),
          );
          const tools = yield* executor.tools.list({ integration: INTEG });
          const connection = yield* executor.connections.get({
            owner: "org",
            integration: INTEG,
            name: ConnectionName.make("main"),
          });

          expect(tools.map((tool) => String(tool.name)).sort()).toEqual(["deploy", "list"]);
          expect(connection?.lastHealth).toMatchObject({
            status: "degraded",
            detail: expect.stringContaining("authoritative empty catalog"),
          });
        }),
      ),
  );

  it.effect(
    "background sync clears a non-remote catalog when a plugin returns authoritative empty",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let empty = false;
          const storedStatePlugin = definePlugin(() => ({
            id: "stored-state" as const,
            credentialProviders: [memoryProvider()],
            storage: () => ({}),
            resolveTools: () =>
              Effect.sync(() => ({
                tools: empty
                  ? []
                  : [
                      { name: ToolName.make("deploy"), description: "deploy" },
                      { name: ToolName.make("list"), description: "list" },
                    ],
              })),
            invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
            extension: (ctx) => ({
              seed: () =>
                ctx.core.integrations.register({
                  slug: INTEG,
                  description: "Vercel",
                  config: {},
                }),
            }),
          }))();
          const config = makeTestConfig({ plugins: [storedStatePlugin] as const });
          const executor = yield* createExecutor(config);
          yield* executor["stored-state"].seed();
          yield* executor.connections.create({
            owner: "org",
            name: ConnectionName.make("main"),
            integration: INTEG,
            template: TEMPLATE,
            value: "secret-token",
          });

          empty = true;
          yield* Effect.promise(() =>
            config.db.updateMany("connection", {
              where: (b) => b.and(b("integration", "=", String(INTEG)), b("name", "=", "main")),
              set: { tools_synced_at: null },
            }),
          );
          const tools = yield* executor.tools.list({ integration: INTEG });
          const connection = yield* executor.connections.get({
            owner: "org",
            integration: INTEG,
            name: ConnectionName.make("main"),
          });

          expect(tools).toEqual([]);
          expect(connection?.lastHealth).toBeNull();
        }),
      ),
  );

  it.effect("explicit refresh accepts an authoritative empty catalog", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let empty = false;
        const guardedPlugin = definePlugin(() => ({
          id: "guarded" as const,
          credentialProviders: [memoryProvider()],
          storage: () => ({}),
          resolveTools: () =>
            Effect.sync(() => ({
              tools: empty
                ? []
                : [
                    { name: ToolName.make("deploy"), description: "deploy" },
                    { name: ToolName.make("list"), description: "list" },
                  ],
            })),
          invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
          extension: (ctx) => ({
            seed: () =>
              ctx.core.integrations.register({
                slug: INTEG,
                description: "Vercel",
                config: {},
              }),
          }),
        }))();
        const executor = yield* createExecutor(
          makeTestConfig({ plugins: [guardedPlugin] as const }),
        );
        yield* executor.guarded.seed();
        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
          value: "secret-token",
        });

        empty = true;
        const refreshed = yield* executor.connections.refresh({
          owner: "org",
          integration: INTEG,
          name: ConnectionName.make("main"),
        });
        const tools = yield* executor.tools.list({ integration: INTEG });

        expect(refreshed).toEqual([]);
        expect(tools).toEqual([]);
      }),
    ),
  );

  it.effect("successful sync clears a prior tool-sync failure health record", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let incomplete = false;
        const guardedPlugin = definePlugin(() => ({
          id: "guarded" as const,
          credentialProviders: [memoryProvider()],
          storage: () => ({}),
          resolveTools: () =>
            Effect.sync(() =>
              incomplete
                ? {
                    tools: [],
                    incomplete: true,
                    incompleteReason: "temporary catalog outage",
                  }
                : {
                    tools: [
                      { name: ToolName.make("deploy"), description: "deploy" },
                      { name: ToolName.make("list"), description: "list" },
                    ],
                  },
            ),
          invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
          extension: (ctx) => ({
            seed: () =>
              ctx.core.integrations.register({
                slug: INTEG,
                description: "Vercel",
                config: {},
              }),
          }),
        }))();
        const config = makeTestConfig({ plugins: [guardedPlugin] as const });
        const executor = yield* createExecutor(config);
        yield* executor.guarded.seed();
        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
          value: "secret-token",
        });

        incomplete = true;
        yield* Effect.promise(() =>
          config.db.updateMany("connection", {
            where: (b) => b.and(b("integration", "=", String(INTEG)), b("name", "=", "main")),
            set: { tools_synced_at: null },
          }),
        );
        yield* executor.tools.list({ integration: INTEG });
        expect(
          (yield* executor.connections.get({
            owner: "org",
            integration: INTEG,
            name: ConnectionName.make("main"),
          }))?.lastHealth,
        ).toMatchObject({
          status: "degraded",
          detail: expect.stringContaining("temporary catalog outage"),
        });

        incomplete = false;
        yield* Effect.promise(() =>
          config.db.updateMany("connection", {
            where: (b) => b.and(b("integration", "=", String(INTEG)), b("name", "=", "main")),
            set: { tools_synced_at: null },
          }),
        );
        yield* executor.tools.list({ integration: INTEG });
        const connection = yield* executor.connections.get({
          owner: "org",
          integration: INTEG,
          name: ConnectionName.make("main"),
        });

        expect(connection?.lastHealth).toBeNull();
      }),
    ),
  );

  it.effect("successful sync preserves genuine health-check records", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const guardedPlugin = definePlugin(() => ({
          id: "guarded" as const,
          credentialProviders: [memoryProvider()],
          storage: () => ({}),
          resolveTools: () =>
            Effect.succeed({
              tools: [
                { name: ToolName.make("deploy"), description: "deploy" },
                { name: ToolName.make("list"), description: "list" },
              ],
            }),
          invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
          extension: (ctx) => ({
            seed: () =>
              ctx.core.integrations.register({
                slug: INTEG,
                description: "Vercel",
                config: {},
              }),
          }),
        }))();
        const config = makeTestConfig({ plugins: [guardedPlugin] as const });
        const executor = yield* createExecutor(config);
        yield* executor.guarded.seed();
        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
          value: "secret-token",
        });

        const health = {
          status: "degraded" as const,
          checkedAt: Date.now(),
          detail: "health check returned HTTP 503",
        };
        yield* Effect.promise(() =>
          config.db.updateMany("connection", {
            where: (b) => b.and(b("integration", "=", String(INTEG)), b("name", "=", "main")),
            set: { tools_synced_at: null, last_health: health },
          }),
        );
        yield* executor.tools.list({ integration: INTEG });
        const connection = yield* executor.connections.get({
          owner: "org",
          integration: INTEG,
          name: ConnectionName.make("main"),
        });

        expect(connection?.lastHealth).toMatchObject(health);
      }),
    ),
  );

  // A tools read rebuilds every stale connection it finds, and those rebuilds
  // run their upstream listings together. Their catalog WRITES must not: the
  // self-host database is a single libSQL connection issuing raw BEGIN/COMMIT,
  // where a second transaction opened while one is live fails outright. The
  // test observes real transactions through the db handle, so it fails if the
  // persist step ever loses its permit.
  it.effect("overlaps stale discovery but never overlaps catalog persistence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const STALE_CONNECTIONS = 4;
        const CONNECTION_NAMES = ["alpha", "beta", "gamma", "delta"] as const;

        let openTransactions = 0;
        let maxOpenTransactions = 0;
        let discovering = 0;
        let latched = false;
        const allDiscovering = yield* Deferred.make<void>();

        const guardedPlugin = definePlugin(() => ({
          id: "guarded" as const,
          credentialProviders: [memoryProvider()],
          storage: () => ({}),
          remoteToolCatalog: true,
          // Once latched, no listing answers until every stale connection is
          // discovering. A serial fan-out parks on the first one forever, so
          // this also proves discovery still overlaps after the restructure.
          resolveTools: ({ connection }) =>
            Effect.gen(function* () {
              if (latched) {
                discovering += 1;
                if (discovering >= STALE_CONNECTIONS) {
                  yield* Deferred.succeed(allDiscovering, undefined);
                }
                yield* Deferred.await(allDiscovering);
              }
              return {
                tools: [
                  { name: ToolName.make(`deploy_${String(connection.name)}`), description: "d" },
                ],
              };
            }),
          invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
          extension: (ctx) => ({
            seed: () =>
              ctx.core.integrations.register({
                slug: INTEG,
                description: "Vercel",
                config: {},
              }),
          }),
        }))();

        const config = makeTestConfig({ plugins: [guardedPlugin] as const });
        const executor = yield* createExecutor({
          ...config,
          db: instrumentTransactions(config.db, {
            enter: () => {
              openTransactions += 1;
              maxOpenTransactions = Math.max(maxOpenTransactions, openTransactions);
            },
            exit: () => {
              openTransactions -= 1;
            },
          }),
        });
        yield* executor.guarded.seed();
        for (const name of CONNECTION_NAMES) {
          yield* executor.connections.create({
            owner: "org",
            name: ConnectionName.make(name),
            integration: INTEG,
            template: TEMPLATE,
            value: "secret-token",
          });
        }

        // Mark the whole set stale, then arm the latch so the next read is
        // purely the stale-refresh fan-out.
        yield* Effect.promise(() =>
          config.db.updateMany("connection", {
            where: (b) => b("integration", "=", String(INTEG)),
            set: { tools_synced_at: null },
          }),
        );
        latched = true;

        // Well inside the harness timeout: a serial fan-out never releases the
        // latch and fails the assertion below instead of the whole runner.
        const tools = yield* executor.tools
          .list({ integration: INTEG })
          .pipe(Effect.timeoutOption("10 seconds"));

        expect(Option.isSome(tools)).toBe(true);
        expect(discovering).toBe(STALE_CONNECTIONS);
        // The load-bearing assertion: concurrent discovery, single-file writes.
        expect(maxOpenTransactions).toBe(1);
      }),
    ),
  );

  // Partial failure must stay partial AND stay visible. A rebuild that cannot
  // reach its upstream keeps the stale-but-working catalog, lets its peers
  // finish, and leaves a warning naming the connection — otherwise a
  // permanently broken connection re-fails on every read with no trace.
  it.effect("a failed stale rebuild warns and neither fails nor blocks the read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let latched = false;
        const guardedPlugin = definePlugin(() => ({
          id: "guarded" as const,
          credentialProviders: [memoryProvider()],
          storage: () => ({}),
          remoteToolCatalog: true,
          // The realistic failure shape: a plugin reports a StorageError whose
          // `cause` carries the actionable upstream detail, exactly as the MCP
          // plugin does when a server cannot be reached.
          resolveTools: ({ connection }) =>
            latched && String(connection.name) === "broken"
              ? Effect.fail(
                  new StorageError({
                    message: "upstream listing refused",
                    // oxlint-disable-next-line executor/no-error-constructor -- boundary: the fixture reproduces a real plugin cause, which is a built-in Error
                    cause: new Error("connect ECONNREFUSED"),
                  }),
                )
              : Effect.succeed({
                  tools: [
                    { name: ToolName.make(`deploy_${String(connection.name)}`), description: "d" },
                  ],
                }),
          invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
          extension: (ctx) => ({
            seed: () =>
              ctx.core.integrations.register({
                slug: INTEG,
                description: "Vercel",
                config: {},
              }),
          }),
        }))();

        const config = makeTestConfig({ plugins: [guardedPlugin] as const });
        const executor = yield* createExecutor(config);
        yield* executor.guarded.seed();
        for (const name of ["broken", "healthy"]) {
          yield* executor.connections.create({
            owner: "org",
            name: ConnectionName.make(name),
            integration: INTEG,
            template: TEMPLATE,
            value: "secret-token",
          });
        }

        yield* Effect.promise(() =>
          config.db.updateMany("connection", {
            where: (b) => b("integration", "=", String(INTEG)),
            set: { tools_synced_at: null },
          }),
        );
        latched = true;

        const warnings: string[] = [];
        const capture = Logger.make<unknown, void>((options) => {
          if (options.logLevel === "Warn") {
            warnings.push(Inspectable.toStringUnknown(options.message, 0));
          }
        });
        const tools = yield* executor.tools
          .list({ integration: INTEG })
          .pipe(Effect.provide(Logger.layer([capture])));

        // The read succeeds, and the failing connection keeps its previously
        // persisted catalog rather than being wiped by a failed listing.
        expect(tools.map((tool) => String(tool.name)).sort()).toEqual([
          "deploy_broken",
          "deploy_healthy",
        ]);

        const failureWarning = warnings.find((line) =>
          line.includes("executor stale tool sync failed"),
        );
        expect(failureWarning).toBeDefined();
        expect(failureWarning).toContain("broken");
        // Both halves: the failure and the cause that names what to fix. A bare
        // structural render of the error drops the cause entirely.
        expect(failureWarning).toContain("upstream listing refused");
        expect(failureWarning).toContain("connect ECONNREFUSED");
        // The healthy peer is not swept into the failure.
        expect(failureWarning).not.toContain("healthy");
      }),
    ),
  );
});

describe("connections.checkHealth", () => {
  it.effect("keeps API-key connections without a probe unknown", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: INTEG,
        template: TEMPLATE,
        value: "secret-token",
      });

      const result = yield* executor.connections.checkHealth({
        owner: "org",
        integration: INTEG,
        name: ConnectionName.make("main"),
      });

      expect(result.status).toBe("unknown");
    }),
  );
});

describe("execute over a connection", () => {
  it.effect("resolves the credential value and hands it to invokeTool", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: INTEG,
        template: TEMPLATE,
        value: "secret-token",
      });
      const out = yield* executor.execute(ToolAddress.make("tools.vercel.org.main.deploy"), {});
      expect(out).toEqual({ ran: "deploy", value: "secret-token" });
    }),
  );
});

// ---------------------------------------------------------------------------
// Sticky-verdict repair: agents read `lastHealth` through coreTools
// connections.list, and nothing else ever re-probes a persisted verdict, so a
// transient failure used to read as "unhealthy, reconnect" until a human
// clicked "Check now". These cover the two repair paths: read-time
// revalidation on the agent list, and heal-on-use from a successful
// invocation.
// ---------------------------------------------------------------------------

const CORE_LIST = ToolAddress.make("executor.coreTools.connections.list");
const STALE_MS = 5 * 60 * 1000;

type ListedConnections = {
  readonly connections: readonly {
    readonly name: string;
    readonly lastHealth: { readonly status: string; readonly detail?: string } | null;
  }[];
};

const makeHealthHarness = (options?: {
  /** Replaces the default instant-healthy probe. Entries are still counted in
   *  `counters.probes`, so a Deferred-gated probe lets a test hold every
   *  in-flight health check open and count how many actually started. */
  readonly probe?: Effect.Effect<typeof HealthCheckResult.Type>;
}) => {
  const counters = { probes: 0 };
  // Runs inside every invocation before it returns, so a test can interleave
  // a concurrent write (e.g. a refresh discovering invalid_grant) between the
  // row load and the heal-on-use decision.
  const hooks = { onInvoke: Effect.void as Effect.Effect<void> };
  const plugin = definePlugin(() => ({
    id: "healthdemo" as const,
    credentialProviders: [memoryProvider()],
    storage: () => ({}),
    resolveTools: () =>
      Effect.succeed({ tools: [{ name: ToolName.make("deploy"), description: "deploy" }] }),
    invokeTool: ({ toolRow, credential, args }) =>
      Effect.as(
        hooks.onInvoke,
        (args as { fail?: boolean }).fail === true
          ? ToolResult.fail({ code: "upstream_error", message: "boom" })
          : { ran: toolRow.name, value: credential.value },
      ),
    checkHealth: () =>
      Effect.suspend(() => {
        counters.probes += 1;
        return (
          options?.probe ??
          Effect.succeed({ status: "healthy" as const, checkedAt: Date.now(), detail: "probe ok" })
        );
      }),
    extension: (ctx) => ({
      seed: () =>
        ctx.core.integrations.register({ slug: INTEG, description: "Vercel", config: {} }),
    }),
  }))();

  return Effect.gen(function* () {
    const config = makeTestConfig({
      plugins: [plugin] as const,
      coreTools: { webBaseUrl: "http://localhost:3000" },
    });
    const executor = yield* createExecutor(config);
    yield* executor.healthdemo.seed();
    yield* executor.connections.create({
      owner: "org",
      name: ConnectionName.make("main"),
      integration: INTEG,
      template: TEMPLATE,
      value: "secret-token",
    });
    const stamp = (set: Record<string, unknown>) =>
      Effect.promise(() =>
        config.db.updateMany("connection", {
          where: (b) => b.and(b("integration", "=", String(INTEG)), b("name", "=", "main")),
          set,
        }),
      );
    const persisted = () =>
      executor.connections.get({
        owner: "org",
        integration: INTEG,
        name: ConnectionName.make("main"),
      });
    return { executor, counters, stamp, persisted, hooks } as const;
  });
};

describe("agent read revalidation (coreTools connections.list)", () => {
  it.effect("re-probes a stale non-healthy verdict and reports + persists the fresh one", () =>
    Effect.gen(function* () {
      const { executor, counters, stamp, persisted } = yield* makeHealthHarness();
      yield* stamp({
        last_health: { status: "expired", checkedAt: Date.now() - STALE_MS, detail: "HTTP 401" },
      });

      const out = (yield* executor.execute(CORE_LIST, {})) as ListedConnections;
      const listed = out.connections.find((c) => c.name === "main");
      expect(listed?.lastHealth?.status).toBe("healthy");
      expect(counters.probes).toBe(1);

      const row = yield* persisted();
      expect(row?.lastHealth?.status).toBe("healthy");
    }),
  );

  it.effect("serves a fresh non-healthy verdict without re-probing", () =>
    Effect.gen(function* () {
      const { executor, counters, stamp } = yield* makeHealthHarness();
      yield* stamp({
        last_health: { status: "expired", checkedAt: Date.now(), detail: "HTTP 401" },
      });

      const out = (yield* executor.execute(CORE_LIST, {})) as ListedConnections;
      const listed = out.connections.find((c) => c.name === "main");
      expect(listed?.lastHealth?.status).toBe("expired");
      expect(counters.probes).toBe(0);
    }),
  );

  it.effect("never probes a healthy verdict, however old", () =>
    Effect.gen(function* () {
      const { executor, counters, stamp } = yield* makeHealthHarness();
      yield* stamp({
        last_health: { status: "healthy", checkedAt: Date.now() - STALE_MS, detail: "probe ok" },
      });

      const out = (yield* executor.execute(CORE_LIST, {})) as ListedConnections;
      const listed = out.connections.find((c) => c.name === "main");
      expect(listed?.lastHealth?.status).toBe("healthy");
      expect(counters.probes).toBe(0);
    }),
  );

  it.effect("concurrent lists past the freshness gate collapse to one probe", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const { executor, counters, stamp, persisted } = yield* makeHealthHarness({
        probe: Deferred.await(gate).pipe(
          Effect.map(() => ({
            status: "healthy" as const,
            checkedAt: Date.now(),
            detail: "probe ok",
          })),
        ),
      });
      yield* stamp({
        last_health: { status: "expired", checkedAt: Date.now() - STALE_MS, detail: "HTTP 401" },
      });

      const lists = yield* Effect.forkChild(
        Effect.all(
          Array.from({ length: 5 }, () => executor.execute(CORE_LIST, {})),
          { concurrency: "unbounded" },
        ),
      );
      // The probe is held open by the gate, so NOTHING has been persisted yet:
      // every one of the five lists must pass the freshness check and reach
      // the probe path. Give them real time to get there — the counter then
      // says how many probes actually started.
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
      expect(counters.probes).toBe(1);

      yield* Deferred.succeed(gate, void 0);
      const outs = (yield* Fiber.join(lists)) as readonly ListedConnections[];
      for (const out of outs) {
        const listed = out.connections.find((c) => c.name === "main");
        expect(listed?.lastHealth?.status).toBe("healthy");
      }
      expect(counters.probes).toBe(1);

      const row = yield* persisted();
      expect(row?.lastHealth?.status).toBe("healthy");
    }),
  );

  it.effect("a grant recorded invalid_grant-dead is never auto-revalidated", () =>
    Effect.gen(function* () {
      const { executor, counters, stamp, persisted } = yield* makeHealthHarness();
      yield* stamp({
        provider_state: {
          oauthReauthRequiredAt: Date.now(),
          oauthReauthRequiredDetail: "invalid_grant",
        },
        last_health: {
          status: "expired",
          checkedAt: Date.now() - STALE_MS,
          detail: "invalid_grant",
        },
      });

      // The list serves the persisted verdict without probing: a probe could
      // pass on the access token's remaining lifetime and persist "healthy",
      // hiding the required reconnect forever.
      const out = (yield* executor.execute(CORE_LIST, {})) as ListedConnections;
      const listed = out.connections.find((c) => c.name === "main");
      expect(listed?.lastHealth?.status).toBe("expired");
      expect(counters.probes).toBe(0);

      // The manual "Check now" (no freshness window) refuses too: only an
      // explicit reconnect clears a dead grant.
      const manual = yield* executor.connections.checkHealth({
        owner: "org",
        integration: INTEG,
        name: ConnectionName.make("main"),
      });
      expect(manual.status).toBe("expired");
      expect(counters.probes).toBe(0);

      const row = yield* persisted();
      expect(row?.lastHealth?.status).toBe("expired");
    }),
  );

  it.effect("leaves tool-sync failure verdicts for sync to clear", () =>
    Effect.gen(function* () {
      const { executor, counters, stamp, persisted } = yield* makeHealthHarness();
      const detail = "Tool sync failing: plugin returned an incomplete tool catalog";
      yield* stamp({
        last_health: { status: "degraded", checkedAt: Date.now() - STALE_MS, detail },
      });

      const out = (yield* executor.execute(CORE_LIST, {})) as ListedConnections;
      const listed = out.connections.find((c) => c.name === "main");
      expect(listed?.lastHealth?.status).toBe("degraded");
      expect(counters.probes).toBe(0);

      // The compact list shape omits `detail`, so read the untouched verdict
      // off the row: a tool-sync failure is cleared by a successful sync, not
      // by a credential probe.
      const row = yield* persisted();
      expect(row?.lastHealth?.detail).toBe(detail);
    }),
  );
});

describe("heal-on-use", () => {
  it.effect("a successful invocation flips a stale non-healthy verdict to healthy", () =>
    Effect.gen(function* () {
      const { executor, stamp, persisted } = yield* makeHealthHarness();
      yield* stamp({
        last_health: { status: "expired", checkedAt: Date.now() - STALE_MS, detail: "HTTP 401" },
      });

      yield* executor.execute(ToolAddress.make("tools.vercel.org.main.deploy"), {});

      const row = yield* persisted();
      expect(row?.lastHealth).toMatchObject({
        status: "healthy",
        detail: "Tool invocation succeeded.",
      });
    }),
  );

  it.effect("an explicit tool failure does not heal", () =>
    Effect.gen(function* () {
      const { executor, stamp, persisted } = yield* makeHealthHarness();
      yield* stamp({
        last_health: { status: "expired", checkedAt: Date.now() - STALE_MS, detail: "HTTP 401" },
      });

      yield* executor.execute(ToolAddress.make("tools.vercel.org.main.deploy"), { fail: true });

      const row = yield* persisted();
      expect(row?.lastHealth?.status).toBe("expired");
    }),
  );

  it.effect("a grant recorded invalid_grant-dead is not healed by a lingering token", () =>
    Effect.gen(function* () {
      const { executor, stamp, persisted } = yield* makeHealthHarness();
      yield* stamp({
        provider_state: { oauthReauthRequiredAt: Date.now() },
        last_health: {
          status: "expired",
          checkedAt: Date.now() - STALE_MS,
          detail: "invalid_grant",
        },
      });

      yield* executor.execute(ToolAddress.make("tools.vercel.org.main.deploy"), {});

      const row = yield* persisted();
      expect(row?.lastHealth?.status).toBe("expired");
    }),
  );

  it.effect("does not overwrite a newer verdict written while the call was in flight", () =>
    Effect.gen(function* () {
      const { executor, stamp, persisted, hooks } = yield* makeHealthHarness();
      yield* stamp({
        last_health: { status: "expired", checkedAt: Date.now() - STALE_MS, detail: "HTTP 401" },
      });
      // A probe (or refresh) lands a NEWER expired verdict while the call is
      // in flight. Heal-on-use decided from the row loaded BEFORE invocation;
      // it must re-check at write time and leave the newer evidence standing.
      const newerDetail = "revoked upstream while the call ran";
      hooks.onInvoke = stamp({
        last_health: { status: "expired", checkedAt: Date.now(), detail: newerDetail },
      }).pipe(Effect.asVoid);

      yield* executor.execute(ToolAddress.make("tools.vercel.org.main.deploy"), {});

      const row = yield* persisted();
      expect(row?.lastHealth).toMatchObject({ status: "expired", detail: newerDetail });
    }),
  );

  it.effect("does not resurrect a grant that died while the call was in flight", () =>
    Effect.gen(function* () {
      const { executor, stamp, persisted, hooks } = yield* makeHealthHarness();
      yield* stamp({
        last_health: { status: "expired", checkedAt: Date.now() - STALE_MS, detail: "HTTP 401" },
      });
      // A concurrent refresh discovers invalid_grant mid-call and records the
      // dead grant. The invocation still succeeded on the old access token's
      // remaining lifetime — healing from it would bury the reconnect.
      hooks.onInvoke = stamp({
        provider_state: { oauthReauthRequiredAt: Date.now() },
        last_health: { status: "expired", checkedAt: Date.now(), detail: "invalid_grant" },
      }).pipe(Effect.asVoid);

      yield* executor.execute(ToolAddress.make("tools.vercel.org.main.deploy"), {});

      const row = yield* persisted();
      expect(row?.lastHealth).toMatchObject({ status: "expired", detail: "invalid_grant" });
    }),
  );

  it.effect("a call whose credential no longer resolves is not healed", () =>
    Effect.gen(function* () {
      const { executor, stamp, persisted } = yield* makeHealthHarness();
      // The stored credential is gone from the provider. Rendering skips a
      // missing placement, so an upstream that answers unauthenticated still
      // succeeds — that success says nothing about a credential that no longer
      // exists, and healing from it would tell the user to stop reconnecting.
      yield* stamp({
        item_ids: { token: "vanished-item" },
        last_health: { status: "expired", checkedAt: Date.now() - STALE_MS, detail: "HTTP 401" },
      });

      yield* executor.execute(ToolAddress.make("tools.vercel.org.main.deploy"), {});

      const row = yield* persisted();
      expect(row?.lastHealth?.status).toBe("expired");
    }),
  );
});

describe("health probe gate key integrity", () => {
  // The in-flight probe gate is shared across every executor holding the same
  // root db handle, so the key must be collision-free across tenants. A
  // colon-join is not: tenant and subject are opaque strings that may contain
  // colons, so (tenant "a", subject "user:b") and (tenant "a:user", subject
  // "b") both read "a:user:user:b:<integration>:<name>" — and colliding keys
  // share one Deferred, serving one tenant's probe outcome (run with ITS
  // credentials) as the other tenant's health verdict.
  it.effect("colliding colon-join identities run two distinct probes, not one shared gate", () =>
    Effect.gen(function* () {
      const counters = { probes: 0 };
      const gate = yield* Deferred.make<void>();
      // Every probe increments the shared counter and then parks on the gate,
      // so both checks are provably in flight at once: nothing is persisted,
      // and a collided gate would let the second check join the first probe's
      // Deferred instead of starting its own.
      const probingPlugin = definePlugin(() => ({
        id: "healthgate" as const,
        credentialProviders: [memoryProvider()],
        storage: () => ({}),
        resolveTools: () =>
          Effect.succeed({ tools: [{ name: ToolName.make("deploy"), description: "deploy" }] }),
        invokeTool: ({ toolRow, credential }) =>
          Effect.succeed({ ran: toolRow.name, value: credential.value }),
        checkHealth: () =>
          Effect.suspend(() => {
            counters.probes += 1;
            return Deferred.await(gate).pipe(
              Effect.map(() => ({
                status: "healthy" as const,
                checkedAt: Date.now(),
                detail: "probe ok",
              })),
            );
          }),
        extension: (ctx) => ({
          seed: () =>
            ctx.core.integrations.register({ slug: INTEG, description: "Vercel", config: {} }),
        }),
      }));

      // Both executors share ONE root db handle — and therefore one gate map;
      // only the key separates their probes.
      const configA = makeTestConfig({
        plugins: [probingPlugin()] as const,
        tenant: "a",
        subject: "user:b",
      });
      const executorA = yield* createExecutor(configA);
      const executorB = yield* createExecutor({
        ...configA,
        tenant: Tenant.make("a:user"),
        subject: Subject.make("b"),
        plugins: [probingPlugin()] as const,
      });
      yield* executorA.healthgate.seed();
      yield* executorB.healthgate.seed();
      const ref = {
        owner: "user",
        name: ConnectionName.make("main"),
        integration: INTEG,
      } as const;
      yield* executorA.connections.create({ ...ref, template: TEMPLATE, value: "token-a" });
      yield* executorB.connections.create({ ...ref, template: TEMPLATE, value: "token-b" });

      const checkA = yield* Effect.forkChild(executorA.connections.checkHealth(ref));
      const checkB = yield* Effect.forkChild(executorB.connections.checkHealth(ref));
      // Give both fibers real time to reach the probe path while the gate
      // holds every probe open; the counter then says how many started.
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
      expect(counters.probes).toBe(2);

      yield* Deferred.succeed(gate, void 0);
      const resultA = yield* Fiber.join(checkA);
      const resultB = yield* Fiber.join(checkB);
      expect(resultA.status).toBe("healthy");
      expect(resultB.status).toBe("healthy");
      expect(counters.probes).toBe(2);
    }),
  );
});
