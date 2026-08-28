import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
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

// ---------------------------------------------------------------------------
// Credential-write compensation. The row insert and the provider write cannot
// be atomic — the provider may live outside the database — so the create
// sequences them: the provider is touched only after this create wins the row
// insert, and a write that does not complete must tear down everything it
// already stored. The worst outcome is a committed row whose credentials were
// never written: it 409s every retry while resolving nothing.
// ---------------------------------------------------------------------------

const trackingProvider = (
  store: Map<string, string>,
  overrides?: Partial<Pick<CredentialProvider, "set" | "delete">>,
): CredentialProvider => ({
  key: ProviderKey.make("memory"),
  writable: true,
  get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
  set: (id, value) => Effect.sync(() => void store.set(String(id), value)),
  delete: (id) => Effect.sync(() => void store.delete(String(id))),
  ...overrides,
});

const durabilityPlugin = (provider: CredentialProvider) =>
  definePlugin(() => ({
    id: "durable" as const,
    credentialProviders: [provider],
    storage: () => ({}),
    resolveTools: () =>
      Effect.succeed({ tools: [{ name: ToolName.make("deploy"), description: "deploy" }] }),
    invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
    extension: (ctx) => ({
      seed: () =>
        ctx.core.integrations.register({ slug: INTEG, description: "Vercel", config: {} }),
    }),
  }))();

/** Wrap a test `FumaDb` so deletes on the `connection` table can be made to
 *  fail on demand — the raw driver-level failure the compensating delete must
 *  survive loudly. Transactions hand out wrapped handles too, so the guarded
 *  delete inside the compensation transaction is covered. */
const failableConnectionDeletes = (db: FumaDb, shouldFail: () => boolean): FumaDb => {
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
        if (prop === "deleteMany") {
          return (table: unknown, query: unknown) =>
            shouldFail() && table === "connection"
              ? // oxlint-disable-next-line executor/no-promise-reject -- boundary: the proxy fakes a driver-level rejection from the raw FumaDb handle
                Promise.reject(new StorageError({ message: "delete refused", cause: undefined }))
              : (target.deleteMany as (t: unknown, q: unknown) => Promise<unknown>)(table, query);
        }
        return Reflect.get(target, prop);
      },
    });
  return wrap(db);
};

/** Wrap a test `FumaDb` so one armed `connection` read observes a stale row.
 *  This models the read/delete race inside the compensation transaction: under
 *  read-committed isolation the pre-delete identity read can see this create's
 *  row while a concurrent remove/recreate has already replaced it by the time
 *  the guarded delete runs. SQLite serializes the whole transaction, so that
 *  interleaving cannot be produced with real concurrency here — the wrapper
 *  reproduces the exact observation order instead: the armed read returns the
 *  create's own (captured) row while the table already holds the successor;
 *  every other read, including the confirmation read after the guarded
 *  delete, sees the real table. */
const staleCompensationRead = (db: FumaDb, state: { armed: boolean }): FumaDb => {
  let captured: Record<string, unknown> | null = null;
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
        if (prop === "create") {
          return async (table: unknown, values: unknown) => {
            const row = await (
              target.create as (t: unknown, v: unknown) => Promise<Record<string, unknown>>
            )(table, values);
            // Keep the FIRST inserted connection row — the raced create's own.
            if (table === "connection" && captured === null) captured = row;
            return row;
          };
        }
        if (prop === "findFirst") {
          return (table: unknown, query: unknown) => {
            if (table === "connection" && state.armed && captured !== null) {
              state.armed = false;
              return Promise.resolve(captured);
            }
            return (target.findFirst as (t: unknown, q: unknown) => Promise<unknown>)(table, query);
          };
        }
        return Reflect.get(target, prop);
      },
    });
  return wrap(db);
};

describe("connections.create credential-write compensation", () => {
  // Interruption is not an error: error-channel compensation never sees it. A
  // create interrupted mid-write must still tear down what it already did —
  // the committed row and every item that landed before the interrupt.
  it.effect("an interrupted create removes the row and the items it already wrote", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const secondWriteEntered = yield* Deferred.make<void>();
        const store = new Map<string, string>();
        const provider = trackingProvider(store, {
          set: (id, value) =>
            String(id).endsWith(":second")
              ? Deferred.succeed(secondWriteEntered, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.sync(() => void store.set(String(id), value)),
        });
        const executor = yield* makeTestExecutor({
          plugins: [durabilityPlugin(provider)] as const,
        });
        yield* executor.durable.seed();

        const fiber = yield* Effect.forkChild(
          executor.connections.create({
            owner: "org",
            name: ConnectionName.make("main"),
            integration: INTEG,
            template: TEMPLATE,
            values: { first: "1", second: "2" },
          }),
        );
        yield* Deferred.await(secondWriteEntered);
        yield* Fiber.interrupt(fiber);

        // The first item had landed before the interrupt; compensation removed
        // it together with the row it belonged to.
        expect(store.size).toBe(0);
        expect(yield* executor.connections.list()).toEqual([]);
      }),
    ),
  );

  // One provider.set can succeed and a later one fail. Deleting only the row
  // leaves the earlier secret at its deterministic item id, waiting to be
  // adopted by the next create of the same name. Compensation must remove the
  // items already written, not just the row.
  it.effect("a failed later variable write cleans up the earlier items and the row", () =>
    Effect.gen(function* () {
      const store = new Map<string, string>();
      const provider = trackingProvider(store, {
        set: (id, value) =>
          String(id).endsWith(":second")
            ? Effect.fail(new StorageError({ message: "provider write refused", cause: undefined }))
            : Effect.sync(() => void store.set(String(id), value)),
      });
      const executor = yield* makeTestExecutor({ plugins: [durabilityPlugin(provider)] as const });
      yield* executor.durable.seed();

      const result = yield* Effect.result(
        executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
          values: { first: "1", second: "2" },
        }),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("StorageError")(result.failure)).toBe(true);
      // Neither half survives: the first item is gone with the row.
      expect(store.size).toBe(0);
      expect(yield* executor.connections.list()).toEqual([]);
    }),
  );

  // A provider can expose `set` without `delete`. Compensation then cannot
  // undo the items already written — that is acceptable only if it is loud:
  // a warning must name the item that may be stranded, never a silent skip.
  it.effect("warns about possibly stranded items when the provider has no delete", () =>
    Effect.gen(function* () {
      const store = new Map<string, string>();
      const provider = trackingProvider(store, {
        set: (id, value) =>
          String(id).endsWith(":second")
            ? Effect.fail(new StorageError({ message: "provider write refused", cause: undefined }))
            : Effect.sync(() => void store.set(String(id), value)),
        delete: undefined,
      });
      const executor = yield* makeTestExecutor({ plugins: [durabilityPlugin(provider)] as const });
      yield* executor.durable.seed();

      const warnings: string[] = [];
      const capture = Logger.make<unknown, void>((options) => {
        if (options.logLevel === "Warn") {
          warnings.push(Inspectable.toStringUnknown(options.message, 0));
        }
      });
      const result = yield* Effect.result(
        executor.connections
          .create({
            owner: "org",
            name: ConnectionName.make("main"),
            integration: INTEG,
            template: TEMPLATE,
            values: { first: "1", second: "2" },
          })
          .pipe(Effect.provide(Logger.layer([capture]))),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("StorageError")(result.failure)).toBe(true);
      // The row is gone, but the first item cannot be undone without a
      // provider delete ...
      expect(yield* executor.connections.list()).toEqual([]);
      expect(store.size).toBe(1);
      // ... and the create said so, naming the item.
      expect(warnings.some((line) => line.includes("stranded"))).toBe(true);
      expect(warnings.some((line) => line.includes("first"))).toBe(true);
    }),
  );

  // The compensating delete can itself fail. Swallowing that failure strands
  // a visible credential-less row behind an error that never mentions it. The
  // create must fail with an error that NAMES the stranded connection so an
  // operator can act on it.
  it.effect("names the stranded connection when the compensating delete fails", () =>
    Effect.gen(function* () {
      let failRowDelete = false;
      const store = new Map<string, string>();
      const provider = trackingProvider(store, {
        set: (id, value) =>
          String(id).endsWith(":second")
            ? Effect.fail(new StorageError({ message: "provider write refused", cause: undefined }))
            : Effect.sync(() => void store.set(String(id), value)),
      });
      const config = makeTestConfig({ plugins: [durabilityPlugin(provider)] as const });
      const executor = yield* createExecutor({
        ...config,
        db: failableConnectionDeletes(config.db, () => failRowDelete),
      });
      yield* executor.durable.seed();
      failRowDelete = true;

      const result = yield* Effect.result(
        executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
          values: { first: "1", second: "2" },
        }),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      const failure = result.failure;
      expect(Predicate.isTagged("StorageError")(failure)).toBe(true);
      if (!Predicate.isTagged("StorageError")(failure)) return;
      expect(failure.message).toContain("main");
      expect(failure.message).toContain("vercel");
      // The original write failure is retained as the cause, not replaced.
      const isStorageError = (u: unknown): u is StorageError =>
        Predicate.isTagged("StorageError")(u);
      expect(isStorageError(failure.cause)).toBe(true);
      if (!isStorageError(failure.cause)) return;
      expect(failure.cause.message).toBe("provider write refused");

      // Non-vacuous: the compensating delete really did fail, so the
      // row the error names is still there.
      failRowDelete = false;
      const rows = yield* executor.connections.list();
      expect(rows.length).toBe(1);
      expect(String(rows[0]?.name)).toBe("main");
    }),
  );

  // Compensation can be slow (provider calls). In that window a concurrent
  // remove can free the name and a new create can take it, writing fresh
  // secrets at the SAME deterministic item ids. Late compensation must then
  // recognize that the row is no longer the one it inserted — identified by
  // the storage surrogate row id — and touch neither the replacement row nor
  // its credentials. Losing compensation to a concurrent remove is correct:
  // the remover already cleaned up.
  it.effect("late compensation leaves a concurrent replacement untouched", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const secondWriteEntered = yield* Deferred.make<void>();
        const releaseSecondWrite = yield* Deferred.make<void>();
        const store = new Map<string, string>();
        let parkNextSecondWrite = true;
        const provider = trackingProvider(store, {
          set: (id, value) => {
            if (String(id).endsWith(":second") && parkNextSecondWrite) {
              parkNextSecondWrite = false;
              return Deferred.succeed(secondWriteEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseSecondWrite)),
                Effect.andThen(
                  Effect.fail(
                    new StorageError({ message: "provider write refused", cause: undefined }),
                  ),
                ),
              );
            }
            return Effect.sync(() => void store.set(String(id), value));
          },
        });
        const executor = yield* makeTestExecutor({
          plugins: [durabilityPlugin(provider)] as const,
        });
        yield* executor.durable.seed();

        const fiber = yield* Effect.forkChild(
          executor.connections.create({
            owner: "org",
            name: ConnectionName.make("main"),
            integration: INTEG,
            template: TEMPLATE,
            values: { first: "a-1", second: "a-2" },
          }),
        );
        yield* Deferred.await(secondWriteEntered);

        // While the first create is parked in its provider write, the user
        // removes the connection and recreates it with different secrets.
        yield* executor.connections.remove({
          owner: "org",
          integration: INTEG,
          name: ConnectionName.make("main"),
        });
        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
          values: { first: "c-1", second: "c-2" },
        });

        // Release the parked write: the first create fails and compensates
        // late, against a name it no longer owns.
        yield* Deferred.succeed(releaseSecondWrite, undefined);
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit)).toBe(true);

        // The replacement row AND its credentials survive.
        const rows = yield* executor.connections.list();
        expect(rows.length).toBe(1);
        expect(String(rows[0]?.name)).toBe("main");
        expect(store.get("connection:org:vercel:main:first")).toBe("c-1");
        expect(store.get("connection:org:vercel:main:second")).toBe("c-2");
      }),
    ),
  );

  // fumadb's `deleteMany` returns void, so the guarded delete cannot report
  // whether it removed anything. Under read-committed isolation the identity
  // read and the delete can straddle a concurrent remove/recreate: the read
  // sees this create's row, then the delete matches ZERO rows because a
  // successor already holds the name. Treating that zero-row delete as "our
  // row is gone, the items are ours to undo" destroys the successor's freshly
  // written secrets at the same deterministic item ids. The confirmation read
  // after the guarded delete, in the same transaction, must observe the
  // surviving row, skip ALL item deletion, and say so.
  it.effect("a zero-row guarded delete never touches a successor's credentials", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const secondWriteEntered = yield* Deferred.make<void>();
        const releaseSecondWrite = yield* Deferred.make<void>();
        const store = new Map<string, string>();
        let parkNextSecondWrite = true;
        const provider = trackingProvider(store, {
          set: (id, value) => {
            if (String(id).endsWith(":second") && parkNextSecondWrite) {
              parkNextSecondWrite = false;
              return Deferred.succeed(secondWriteEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseSecondWrite)),
                Effect.andThen(
                  Effect.fail(
                    new StorageError({ message: "provider write refused", cause: undefined }),
                  ),
                ),
              );
            }
            return Effect.sync(() => void store.set(String(id), value));
          },
        });
        const raceState = { armed: false };
        const config = makeTestConfig({ plugins: [durabilityPlugin(provider)] as const });
        const executor = yield* createExecutor({
          ...config,
          db: staleCompensationRead(config.db, raceState),
        });
        yield* executor.durable.seed();

        const infos: string[] = [];
        const capture = Logger.make<unknown, void>((options) => {
          if (options.logLevel === "Info") {
            infos.push(Inspectable.toStringUnknown(options.message, 0));
          }
        });
        const fiber = yield* Effect.forkChild(
          executor.connections
            .create({
              owner: "org",
              name: ConnectionName.make("main"),
              integration: INTEG,
              template: TEMPLATE,
              values: { first: "a-1", second: "a-2" },
            })
            .pipe(Effect.provide(Logger.layer([capture]))),
        );
        yield* Deferred.await(secondWriteEntered);

        // While the first create is parked in its provider write, the user
        // removes the connection and recreates it with different secrets.
        yield* executor.connections.remove({
          owner: "org",
          integration: INTEG,
          name: ConnectionName.make("main"),
        });
        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
          values: { first: "c-1", second: "c-2" },
        });

        // Arm the stale read and release the parked write: compensation's
        // identity read sees the raced create's own row (the race), its
        // guarded delete then removes zero rows.
        raceState.armed = true;
        yield* Deferred.succeed(releaseSecondWrite, undefined);
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit)).toBe(true);

        // The successor row AND its credentials survive untouched, and the
        // skip was reported, not silent.
        const rows = yield* executor.connections.list();
        expect(rows.length).toBe(1);
        expect(String(rows[0]?.name)).toBe("main");
        expect(store.get("connection:org:vercel:main:first")).toBe("c-1");
        expect(store.get("connection:org:vercel:main:second")).toBe("c-2");
        expect(infos.some((line) => line.includes("removed nothing"))).toBe(true);
      }),
    ),
  );

  // A provider write can die with a defect instead of failing. The stranded-
  // row promise must hold there too: a defect followed by a failed
  // compensating delete surfaces the same typed StorageError naming the
  // stranded connection, not an anonymous crash.
  it.effect("a defect followed by a failed row delete still names the stranded connection", () =>
    Effect.gen(function* () {
      let failRowDelete = false;
      const store = new Map<string, string>();
      const provider = trackingProvider(store, {
        set: (id, value) =>
          String(id).endsWith(":second")
            ? Effect.die("provider crashed")
            : Effect.sync(() => void store.set(String(id), value)),
      });
      const config = makeTestConfig({ plugins: [durabilityPlugin(provider)] as const });
      const executor = yield* createExecutor({
        ...config,
        db: failableConnectionDeletes(config.db, () => failRowDelete),
      });
      yield* executor.durable.seed();
      failRowDelete = true;

      const exit = yield* Effect.exit(
        executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
          values: { first: "1", second: "2" },
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      // Not an anonymous defect: the typed error is on the failure channel.
      expect(Cause.hasFails(exit.cause)).toBe(true);
      const failure = Cause.squash(exit.cause);
      const isStorageError = (u: unknown): u is StorageError =>
        Predicate.isTagged("StorageError")(u);
      expect(isStorageError(failure)).toBe(true);
      if (!isStorageError(failure)) return;
      expect(failure.message).toContain("main");
      expect(failure.message).toContain("vercel");
      expect(failure.message).toContain("stranded");
      // The original defect is retained as the cause, not replaced.
      expect(failure.cause).toBe("provider crashed");

      // Non-vacuous: the row the error names is still there.
      failRowDelete = false;
      const rows = yield* executor.connections.list();
      expect(rows.length).toBe(1);
      expect(String(rows[0]?.name)).toBe("main");
    }),
  );

  // Interruption cannot carry a typed error — interrupting wins over failing
  // — so when an interrupted create cannot delete its row, the stranded row
  // is reported through a loud error log and the create stays an
  // interruption. The items that landed before the interrupt stay with the
  // stranded row: credential teardown is gated on the row delete succeeding.
  it.effect("an interrupted create with a failed row delete logs the stranded row", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let failRowDelete = false;
        const secondWriteEntered = yield* Deferred.make<void>();
        const store = new Map<string, string>();
        const provider = trackingProvider(store, {
          set: (id, value) =>
            String(id).endsWith(":second")
              ? Deferred.succeed(secondWriteEntered, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.sync(() => void store.set(String(id), value)),
        });
        const config = makeTestConfig({ plugins: [durabilityPlugin(provider)] as const });
        const executor = yield* createExecutor({
          ...config,
          db: failableConnectionDeletes(config.db, () => failRowDelete),
        });
        yield* executor.durable.seed();

        const errors: string[] = [];
        const capture = Logger.make<unknown, void>((options) => {
          if (options.logLevel === "Error") {
            errors.push(Inspectable.toStringUnknown(options.message, 0));
          }
        });
        const fiber = yield* Effect.forkChild(
          executor.connections
            .create({
              owner: "org",
              name: ConnectionName.make("main"),
              integration: INTEG,
              template: TEMPLATE,
              values: { first: "1", second: "2" },
            })
            .pipe(Effect.provide(Logger.layer([capture]))),
        );
        yield* Deferred.await(secondWriteEntered);
        failRowDelete = true;
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);

        // Still an interruption — and the stranded row was reported loudly.
        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) return;
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        expect(errors.some((line) => line.includes("stranded"))).toBe(true);

        // Non-vacuous: the row survived the failed delete, and the item that
        // landed before the interrupt stayed with it.
        failRowDelete = false;
        const rows = yield* executor.connections.list();
        expect(rows.length).toBe(1);
        expect(String(rows[0]?.name)).toBe("main");
        expect(store.size).toBe(1);
      }),
    ),
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
