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
  ToolAddress,
  ToolName,
} from "./ids";
import { ConnectionAlreadyExistsError } from "./errors";
import { createExecutor } from "./executor";
import { StorageError, type FumaDb } from "./fuma-runtime";
import { HealthCheckResult } from "./health-check";
import { definePlugin } from "./plugin";
import type { CredentialProvider } from "./provider";
import { makeTestConfig, makeTestExecutor } from "./testing";

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

  // Create is never a replace: a second create with the same (owner,
  // integration, name) must fail with ConnectionAlreadyExistsError and leave
  // the first connection fully intact — including its stored secret, which a
  // silent upsert would overwrite (the pasted value's item id is derived from
  // the name, so the provider write alone clobbers it).
  it.effect("rejects a duplicate (owner, integration, name) and keeps the original intact", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: INTEG,
        template: TEMPLATE,
        value: "original-token",
        description: "original",
      });

      const result = yield* Effect.result(
        executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
          value: "clobbered-token",
          description: "clobbered",
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("ConnectionAlreadyExistsError")(result.failure)).toBe(true);

      // The original row and its secret both survived.
      const connections = yield* executor.connections.list();
      expect(connections.length).toBe(1);
      expect(connections[0]?.description).toBe("original");
      const value = yield* executor.demo.resolveValue("org", "main");
      expect(value).toBe("original-token");
    }),
  );

  // Names collide AFTER identifier normalization: "my-api-key" and "my api key"
  // both normalize to myApiKey, so the second must be rejected even though the
  // raw inputs differ.
  it.effect("rejects a duplicate that only collides after name normalization", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("my-api-key"),
        integration: INTEG,
        template: TEMPLATE,
        value: "v1",
      });
      const result = yield* Effect.result(
        executor.connections.create({
          owner: "org",
          name: ConnectionName.make("my api key"),
          integration: INTEG,
          template: TEMPLATE,
          value: "v2",
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("ConnectionAlreadyExistsError")(result.failure)).toBe(true);
      const value = yield* executor.demo.resolveValue("org", "myApiKey");
      expect(value).toBe("v1");
    }),
  );

  // The race the early duplicate check cannot answer: two creates for the same
  // (owner, integration, name) in flight at once. The row insert picks the
  // winner and the loser gets the typed 409 — and, the load-bearing part, the
  // provider write is winner-only. A pasted value's item id is deterministic,
  // so a pre-insert write from the LOSING create would silently replace the
  // winner's stored secret while the winner's row keeps resolving through it.
  // The gate parks the first create inside its provider write, so the second
  // create runs its full duplicate handling while the first is mid-flight.
  it.effect("concurrent creates: one winner, a typed 409, and the winner's secret intact", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstWriteEntered = yield* Deferred.make<void>();
        const releaseFirstWrite = yield* Deferred.make<void>();
        const store = new Map<string, string>();
        let writes = 0;
        const gatedProvider: CredentialProvider = {
          key: ProviderKey.make("memory"),
          writable: true,
          get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
          set: (id, value) =>
            Effect.gen(function* () {
              writes += 1;
              if (writes === 1) {
                yield* Deferred.succeed(firstWriteEntered, undefined);
                yield* Deferred.await(releaseFirstWrite);
              }
              store.set(String(id), value);
            }),
        };
        const gatedPlugin = definePlugin(() => ({
          id: "gated" as const,
          credentialProviders: [gatedProvider],
          storage: () => ({}),
          resolveTools: () =>
            Effect.succeed({
              tools: [{ name: ToolName.make("deploy"), description: "deploy" }],
            }),
          invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
          extension: (ctx) => ({
            seed: () =>
              ctx.core.integrations.register({
                slug: INTEG,
                description: "Vercel",
                config: {},
              }),
            resolveValue: (name: string) =>
              ctx.connections.resolveValue({
                owner: "org",
                integration: INTEG,
                name: ConnectionName.make(name),
              }),
          }),
        }))();
        const config = makeTestConfig({ plugins: [gatedPlugin] as const });
        const executor = yield* createExecutor(config);
        yield* executor.gated.seed();

        const createWith = (value: string) =>
          Effect.result(
            executor.connections.create({
              owner: "org",
              name: ConnectionName.make("main"),
              integration: INTEG,
              template: TEMPLATE,
              value,
            }),
          );

        const firstFiber = yield* Effect.forkChild(createWith("first-value"));
        yield* Deferred.await(firstWriteEntered);
        const second = yield* createWith("second-value");
        yield* Deferred.succeed(releaseFirstWrite, undefined);
        const first = yield* Fiber.join(firstFiber);

        const attempts = [
          { result: first, value: "first-value" },
          { result: second, value: "second-value" },
        ];
        const winners = attempts.filter((attempt) => Result.isSuccess(attempt.result));
        const losers = attempts.filter((attempt) => Result.isFailure(attempt.result));
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);
        const loser = losers[0];
        if (!loser || !Result.isFailure(loser.result)) return;
        expect(loser.result.failure).toBeInstanceOf(ConnectionAlreadyExistsError);

        // Exactly one connection survived, and it resolves to the WINNER's
        // value — the losing create never reached the provider.
        const connections = yield* executor.connections.list();
        expect(connections).toHaveLength(1);
        const value = yield* executor.gated.resolveValue("main");
        expect(value).toBe(winners[0]?.value);
      }),
    ),
  );

  // When both creates observe absence, both reach the insert and the primary
  // key breaks the tie — the loser must still get the typed 409, not a raw
  // unique-constraint storage failure. The proxy blinds every connection-table
  // read for the second create, so its early and transactional checks both
  // miss the existing row and its insert genuinely collides in the database.
  it.effect("maps a lost insert race to the typed 409, not a storage failure", () =>
    Effect.gen(function* () {
      let blind = false;
      const blindfoldConnectionReads = (db: FumaDb): FumaDb => {
        const wrap = (inner: FumaDb): FumaDb =>
          new Proxy(inner, {
            get(target, prop) {
              if (prop === "withContext") {
                return (context: unknown) =>
                  wrap((target.withContext as (c: unknown) => FumaDb)(context));
              }
              if (prop === "transaction") {
                return (run: (tx: FumaDb) => Promise<unknown>) =>
                  (target.transaction as (r: (tx: FumaDb) => Promise<unknown>) => Promise<unknown>)(
                    (tx) => run(wrap(tx)),
                  );
              }
              if (prop === "findFirst") {
                return (table: unknown, query: unknown) =>
                  blind && table === "connection"
                    ? Promise.resolve(null)
                    : (target.findFirst as (t: unknown, q: unknown) => Promise<unknown>)(
                        table,
                        query,
                      );
              }
              return Reflect.get(target, prop);
            },
          });
        return wrap(db);
      };

      const config = makeTestConfig({ plugins: [demoPlugin] as const });
      const executor = yield* createExecutor({
        ...config,
        db: blindfoldConnectionReads(config.db),
      });
      yield* executor.demo.seed();
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: INTEG,
        template: TEMPLATE,
        value: "first-value",
      });

      blind = true;
      const result = yield* Effect.result(
        executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
          value: "second-value",
        }),
      );
      blind = false;

      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(result.failure).toBeInstanceOf(ConnectionAlreadyExistsError);

      // The losing insert wrote nothing: the original secret is untouched.
      const connections = yield* executor.connections.list();
      expect(connections).toHaveLength(1);
      const value = yield* executor.demo.resolveValue("org", "main");
      expect(value).toBe("first-value");
    }),
  );

  it.effect("allows the same name under a different owner", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: INTEG,
        template: TEMPLATE,
        value: "org-token",
      });
      const personal = yield* executor.connections.create({
        owner: "user",
        name: ConnectionName.make("main"),
        integration: INTEG,
        template: TEMPLATE,
        value: "user-token",
      });
      expect(String(personal.address)).toBe("tools.vercel.user.main");
      expect((yield* executor.connections.list()).length).toBe(2);
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
