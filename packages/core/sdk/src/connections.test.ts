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
  Tracer,
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
import { ConnectionAlreadyExistsError } from "./errors";
import { createExecutor } from "./executor";
import { StorageError, type FumaDb } from "./fuma-runtime";
import { HealthCheckResult } from "./health-check";
import { definePlugin, type ResolveToolsResult } from "./plugin";
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
const COLLIDING_INTEG = IntegrationSlug.make("reserved-slug-collision");
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
  describeAuthMethods: (integration) =>
    String(integration.slug) === String(COLLIDING_INTEG)
      ? [
          {
            id: "none",
            label: "API key with a legacy colliding slug",
            kind: "apikey",
            template: "none",
            placements: [{ carrier: "header", name: "Authorization", prefix: "Bearer " }],
          },
        ]
      : [
          {
            id: String(TEMPLATE),
            label: "API key",
            kind: "apikey",
            template: String(TEMPLATE),
            placements: [{ carrier: "header", name: "Authorization", prefix: "Bearer " }],
          },
          { id: "none", label: "No authentication", kind: "none", template: "none" },
        ],
  extension: (ctx) => ({
    seed: () =>
      ctx.core.integrations.register({
        slug: INTEG,
        description: "Vercel",
        config: {},
      }),
    seedCollidingIntegration: () =>
      ctx.core.integrations.register({
        slug: COLLIDING_INTEG,
        description: "Legacy colliding auth method",
        config: {},
      }),
    resolveValue: (owner: "org" | "user", name: string) =>
      ctx.connections.resolveValue({
        owner,
        integration: INTEG,
        name: ConnectionName.make(name),
      }),
    resolveCollidingValue: (owner: "org" | "user", name: string) =>
      ctx.connections.resolveValue({
        owner,
        integration: COLLIDING_INTEG,
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

  it.effect("a post-commit gap is fail-closed and a later runtime retries the stranded row", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstWriteEntered = yield* Deferred.make<void>();
        const releaseFirstWrite = yield* Deferred.make<void>();
        const store = new Map<string, string>([
          ["connection:org:vercel:main:token", "orphaned-predecessor"],
        ]);
        let writes = 0;
        let failNextDelete = false;
        const provider: CredentialProvider = {
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
          delete: (id) =>
            failNextDelete
              ? Effect.sync(() => {
                  failNextDelete = false;
                }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new StorageError({ message: "old item cleanup refused", cause: undefined }),
                    ),
                  ),
                )
              : Effect.sync(() => void store.delete(String(id))),
        };
        const plugin = definePlugin(() => ({
          id: "recoverable" as const,
          credentialProviders: [provider],
          storage: () => ({}),
          resolveTools: () =>
            Effect.succeed({ tools: [{ name: ToolName.make("deploy"), description: "deploy" }] }),
          invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
          extension: (ctx) => ({
            seed: () =>
              ctx.core.integrations.register({ slug: INTEG, description: "Vercel", config: {} }),
            resolveValue: () =>
              ctx.connections.resolveValue({
                owner: "org",
                integration: INTEG,
                name: ConnectionName.make("main"),
              }),
          }),
        }))();
        const config = makeTestConfig({ plugins: [plugin] as const });
        const first = yield* createExecutor(config);
        yield* first.recoverable.seed();

        const infos: string[] = [];
        const warnings: string[] = [];
        const capture = Logger.make<unknown, void>((options) => {
          const message = Inspectable.toStringUnknown(options.message, 0);
          if (options.logLevel === "Info") infos.push(message);
          if (options.logLevel === "Warn") warnings.push(message);
        });
        const logger = Logger.layer([capture]);

        const firstFiber = yield* Effect.forkChild(
          first.connections
            .create({
              owner: "org",
              name: ConnectionName.make("main"),
              integration: INTEG,
              template: TEMPLATE,
              values: {
                token: "first-attempt",
                "extra:attempt:foreign": "collision-shaped-base",
              },
            })
            .pipe(Effect.provide(logger)),
        );
        yield* Deferred.await(firstWriteEntered);

        // The committed row points at its own missing attempt item. It must not
        // fall back to the deterministic predecessor key already in the store.
        const gapRead = yield* first.recoverable.resolveValue().pipe(Effect.result);
        expect(Result.isFailure(gapRead)).toBe(true);
        expect(
          Result.match(gapRead, {
            onFailure: (failure) => failure.message,
            onSuccess: () => "",
          }),
        ).toContain("is incomplete; retry");
        expect(store.get("connection:org:vercel:main:token")).toBe("orphaned-predecessor");

        // A fresh executor incarnation models restart after a crash that never
        // runs the first hook. It recognizes the foreign missing attempt,
        // atomically replaces the row with a new attempt, and succeeds.
        const restarted = yield* createExecutor(config);
        failNextDelete = true;
        yield* restarted.connections
          .create({
            owner: "org",
            name: ConnectionName.make("main"),
            integration: INTEG,
            template: TEMPLATE,
            values: {
              token: "retried-value",
              "extra:attempt:foreign": "collision-shaped-base",
            },
          })
          .pipe(Effect.provide(logger));
        expect(yield* restarted.recoverable.resolveValue()).toBe("retried-value");
        expect(infos.some((line) => line.includes("stranded row detected"))).toBe(true);
        expect(infos.some((line) => line.includes("stranded row replaced"))).toBe(true);
        expect(warnings.some((line) => line.includes("replaced row cleanup failed"))).toBe(true);

        // If the old process comes back, its unique write is inert and the row
        // identity check reports that the attempt was superseded.
        yield* Deferred.succeed(releaseFirstWrite, undefined);
        expect(Exit.isFailure(yield* Fiber.await(firstFiber))).toBe(true);
        expect(infos.some((line) => line.includes("credential write superseded"))).toBe(true);
        expect(yield* restarted.recoverable.resolveValue()).toBe("retried-value");
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

  it.effect("an external reference containing the old attempt marker is never replaced", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("byo"),
        integration: INTEG,
        template: TEMPLATE,
        from: {
          provider: ProviderKey.make("memory"),
          id: ProviderItemId.make("vault:attempt:foreign:item"),
        },
      });

      const duplicate = yield* Effect.result(
        executor.connections.create({
          owner: "org",
          name: ConnectionName.make("byo"),
          integration: INTEG,
          template: TEMPLATE,
          value: "must-not-replace",
        }),
      );

      expect(Result.isFailure(duplicate)).toBe(true);
      if (!Result.isFailure(duplicate)) return;
      expect(duplicate.failure).toBeInstanceOf(ConnectionAlreadyExistsError);
      expect(yield* executor.demo.resolveValue("org", "byo")).toBeNull();
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

  // A no-auth method needs no credential. SDK callers may submit `values: {}`;
  // the dashboard's legacy shape is `values: { token: "" }`. Both canonicalize
  // to an empty `item_ids` map (the shape of migrated no-auth connections), so
  // creation and refresh must keep the connection's tools.
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

  it.effect("normalizes a no-auth scalar placeholder to an empty credential binding", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("public-scalar"),
        integration: INTEG,
        template: AuthTemplateSlug.make("none"),
        value: "",
      });

      expect(yield* executor.demo.resolveValue("org", "public-scalar")).toBeNull();
    }),
  );

  it.effect("normalizes the dashboard's no-auth empty-value placeholder", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("public-dashboard"),
        integration: INTEG,
        template: AuthTemplateSlug.make("none"),
        values: { token: "" },
      });

      expect(yield* executor.demo.resolveValue("org", "public-dashboard")).toBeNull();
    }),
  );

  it.effect("rejects a real credential for a resolved no-auth method", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      const result = yield* Effect.result(
        executor.connections.create({
          owner: "org",
          name: ConnectionName.make("public-with-secret"),
          integration: INTEG,
          template: AuthTemplateSlug.make("none"),
          value: "must-not-be-dropped",
        }),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(result.failure).toMatchObject({
        _tag: "InvalidConnectionInputError",
        message: "A no-auth connection cannot accept credential inputs.",
      });
      expect(yield* executor.connections.list()).toEqual([]);
    }),
  );

  it.effect("preserves credentials for an API-key method with a colliding no-auth slug", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      yield* executor.demo.seedCollidingIntegration();
      const integration = yield* executor.integrations.get(COLLIDING_INTEG);
      expect(integration?.authMethods).toMatchObject([{ kind: "apikey", template: "none" }]);
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("legacy-api-key"),
        integration: COLLIDING_INTEG,
        template: AuthTemplateSlug.make("none"),
        value: "preserved-secret",
      });

      expect(yield* executor.demo.resolveCollidingValue("org", "legacyApiKey")).toBe(
        "preserved-secret",
      );
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
 *  survive loudly. A rejection during the delete statement is ambiguous on an
 *  auto-commit adapter (the statement may have executed first), so this
 *  failure is reported as unconfirmed, never as definitively stranded.
 *  Transactions hand out wrapped handles too, so the guarded delete inside
 *  the compensation transaction is covered. */
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

/** Wrap a test `FumaDb` so compensation fails strictly BEFORE its guarded
 *  delete statement is issued: the identity read that opens the compensation
 *  transaction rejects. Only a pre-attempt failure keeps the definitive
 *  stranded-row claim truthful — a rejection during the delete statement
 *  itself is reported as unconfirmed instead (see
 *  `failableConnectionDeletes`). The read is identified by sequence: the
 *  first `connection` read after this create's row insert. The conflict-check
 *  read runs before the insert and no other `connection` read happens in
 *  between, so that read is compensation's. Transactions hand out wrapped
 *  handles too. */
const failableCompensationRowDelete = (db: FumaDb, shouldFail: () => boolean): FumaDb => {
  let insertSeen = false;
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
            const row = await (target.create as (t: unknown, v: unknown) => Promise<unknown>)(
              table,
              values,
            );
            if (table === "connection") insertSeen = true;
            return row;
          };
        }
        if (prop === "findFirst") {
          return (table: unknown, query: unknown) =>
            shouldFail() && insertSeen && table === "connection"
              ? // oxlint-disable-next-line executor/no-promise-reject -- boundary: the proxy fakes a driver-level rejection from the raw FumaDb handle
                Promise.reject(
                  new StorageError({ message: "identity read refused", cause: undefined }),
                )
              : (target.findFirst as (t: unknown, q: unknown) => Promise<unknown>)(table, query);
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

/** Wrap a test `FumaDb` so the confirmation read AFTER the guarded delete
 *  fails at the driver. While armed, the first `connection` read that follows
 *  a `connection` delete rejects; every other statement passes through.
 *  Transactions hand out wrapped handles too, so the read inside the
 *  compensation transaction is covered. */
const failableConfirmationRead = (db: FumaDb, state: { armed: boolean }): FumaDb => {
  let deleteSeen = false;
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
          return (table: unknown, query: unknown) => {
            if (state.armed && table === "connection") deleteSeen = true;
            return (target.deleteMany as (t: unknown, q: unknown) => Promise<unknown>)(
              table,
              query,
            );
          };
        }
        if (prop === "findFirst") {
          return (table: unknown, query: unknown) => {
            if (state.armed && deleteSeen && table === "connection") {
              state.armed = false;
              deleteSeen = false;
              // oxlint-disable-next-line executor/no-promise-reject -- boundary: the proxy fakes a driver-level rejection from the raw FumaDb handle
              return Promise.reject(
                new StorageError({ message: "confirmation read refused", cause: undefined }),
              );
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

  // The compensating delete can fail before its guarded delete statement is
  // even issued (here: the identity read that opens the compensation
  // transaction rejects). Nothing can have been deleted, so the surviving
  // credential-less row is definitively stranded — and swallowing that
  // failure hides it behind an error that never mentions it. The create must
  // fail with an error that NAMES the stranded connection so an operator can
  // act on it.
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
        db: failableCompensationRowDelete(config.db, () => failRowDelete),
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
      // Pre-attempt failure: the stranded claim is definitive and stated.
      expect(failure.message).toContain("stranded");
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
        expect([...store.values()]).toContain("c-1");
        expect([...store.values()]).toContain("c-2");
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
        expect([...store.values()]).toContain("c-1");
        expect([...store.values()]).toContain("c-2");
        expect(infos.some((line) => line.includes("removed nothing"))).toBe(true);
      }),
    ),
  );

  // The confirmation read after the guarded delete can itself fail. On an
  // interactive adapter that failure rolls the delete back with the
  // transaction, so "stranded" would be truthful — but on an auto-commit
  // adapter (Cloudflare D1 runs `interactiveTransactions: false`) every
  // statement commits immediately: the delete has already removed the row
  // when the read fails, and a stranded-row claim would be false. The row
  // state is genuinely unknown at this layer, so the create must say exactly
  // that — skip ALL credential-item deletion and report the row as
  // unconfirmed, never as stranded.
  it.effect("a failed confirmation read skips item cleanup and reports the row unconfirmed", () =>
    Effect.gen(function* () {
      const store = new Map<string, string>();
      const provider = trackingProvider(store, {
        set: (id, value) =>
          String(id).endsWith(":second")
            ? Effect.fail(new StorageError({ message: "provider write refused", cause: undefined }))
            : Effect.sync(() => void store.set(String(id), value)),
      });
      const readState = { armed: false };
      const config = makeTestConfig({ plugins: [durabilityPlugin(provider)] as const });
      const executor = yield* createExecutor({
        ...config,
        db: failableConfirmationRead(config.db, readState),
      });
      yield* executor.durable.seed();
      readState.armed = true;

      const errors: string[] = [];
      const capture = Logger.make<unknown, void>((options) => {
        if (options.logLevel === "Error") {
          errors.push(Inspectable.toStringUnknown(options.message, 0));
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

      // Non-vacuous: the armed rejection fired, so the statement that failed
      // really was the confirmation read, after the guarded delete ran.
      expect(readState.armed).toBe(false);

      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      const failure = result.failure;
      expect(Predicate.isTagged("StorageError")(failure)).toBe(true);
      if (!Predicate.isTagged("StorageError")(failure)) return;
      // The error names the connection and reports the unconfirmed state; it
      // must NOT claim the row is stranded — on an auto-commit adapter the
      // delete already committed and the row is gone.
      expect(failure.message).toContain("main");
      expect(failure.message).toContain("vercel");
      expect(failure.message).toContain("could not be confirmed");
      expect(failure.message).not.toContain("stranded");
      // The original write failure is retained as the cause, not replaced.
      const isStorageError = (u: unknown): u is StorageError =>
        Predicate.isTagged("StorageError")(u);
      expect(isStorageError(failure.cause)).toBe(true);
      if (!isStorageError(failure.cause)) return;
      expect(failure.cause.message).toBe("provider write refused");

      // The unknown outcome skips ALL credential-item deletion: the item that
      // landed before the failed write is untouched.
      expect([...store.entries()].find(([id]) => id.endsWith(":first"))?.[1]).toBe("1");
      // The log reports the unconfirmed state, not a stranded-row claim.
      expect(errors.some((line) => line.includes("could not confirm"))).toBe(true);
      expect(errors.every((line) => !line.includes("stranded a connection row"))).toBe(true);
    }),
  );

  // The guarded delete STATEMENT can itself reject. On an interactive adapter
  // the rejection rolls the transaction back and the row survives — but on an
  // auto-commit adapter (Cloudflare D1) the statement may have executed
  // before the rejection surfaced, so a definitive stranded-row claim would
  // be false. Once the delete has been attempted, the row state is genuinely
  // unknown at this layer: the create must skip ALL credential-item deletion
  // and report the delete as unconfirmed, never as stranded.
  it.effect("a rejected delete statement skips item cleanup and reports the row unconfirmed", () =>
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

      const errors: string[] = [];
      const capture = Logger.make<unknown, void>((options) => {
        if (options.logLevel === "Error") {
          errors.push(Inspectable.toStringUnknown(options.message, 0));
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
      const failure = result.failure;
      expect(Predicate.isTagged("StorageError")(failure)).toBe(true);
      if (!Predicate.isTagged("StorageError")(failure)) return;
      // The error names the connection and reports the unconfirmed state; it
      // must NOT claim the row is stranded — on an auto-commit adapter the
      // delete may already have executed before the rejection surfaced.
      expect(failure.message).toContain("main");
      expect(failure.message).toContain("vercel");
      expect(failure.message).toContain("could not be confirmed");
      expect(failure.message).not.toContain("stranded");
      // The original write failure is retained as the cause, not replaced.
      const isStorageError = (u: unknown): u is StorageError =>
        Predicate.isTagged("StorageError")(u);
      expect(isStorageError(failure.cause)).toBe(true);
      if (!isStorageError(failure.cause)) return;
      expect(failure.cause.message).toBe("provider write refused");

      // The unknown outcome skips ALL credential-item deletion: the item that
      // landed before the failed write is untouched.
      expect([...store.entries()].find(([id]) => id.endsWith(":first"))?.[1]).toBe("1");
      // The log reports the unconfirmed state, not a stranded-row claim.
      expect(errors.some((line) => line.includes("could not confirm"))).toBe(true);
      expect(errors.every((line) => !line.includes("stranded a connection row"))).toBe(true);

      // Non-vacuous: the armed proxy rejected the delete statement without
      // running it, so on this interactive adapter the row survived.
      failRowDelete = false;
      const rows = yield* executor.connections.list();
      expect(rows.length).toBe(1);
      expect(String(rows[0]?.name)).toBe("main");
    }),
  );

  // A provider write can die with a defect instead of failing. The stranded-
  // row promise must hold there too: a defect followed by a compensating
  // delete that fails before its delete statement is issued surfaces the
  // same typed StorageError naming the stranded connection, not an anonymous
  // crash.
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
        db: failableCompensationRowDelete(config.db, () => failRowDelete),
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
  // — so when an interrupted create cannot delete its row (compensation
  // fails before the delete statement is issued, leaving the row
  // definitively stranded), the stranded row is reported through a loud
  // error log and the create stays an interruption. The items that landed
  // before the interrupt stay with the stranded row: credential teardown is
  // gated on the row delete succeeding.
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
          db: failableCompensationRowDelete(config.db, () => failRowDelete),
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

  it.effect("a failing sync does not bury a dead grant's expired verdict", () =>
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
                    incompleteReason: "upstream rejected the credential",
                  }
                : {
                    tools: [{ name: ToolName.make("deploy"), description: "deploy" }],
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

        // The refresh recorder's authoritative write: the sync's own
        // credential resolution discovered invalid_grant, so by the time the
        // sync fails, the row records the dead grant WITH its expired verdict.
        const expired = {
          status: "expired" as const,
          checkedAt: Date.now(),
          detail: "invalid_grant: Grant not found",
        };
        incomplete = true;
        yield* Effect.promise(() =>
          config.db.updateMany("connection", {
            where: (b) => b.and(b("integration", "=", String(INTEG)), b("name", "=", "main")),
            set: {
              tools_synced_at: null,
              last_health: expired,
              provider_state: {
                oauthReauthRequiredAt: Date.now(),
                oauthReauthRequiredDetail: "invalid_grant: Grant not found",
              },
            },
          }),
        );
        yield* executor.tools.list({ integration: INTEG });

        // "expired, reconnect" outranks "tool sync failing": nothing would
        // re-assert the dead grant's verdict (it is never probed), while the
        // reconnect that clears it re-syncs tools anyway.
        const connection = yield* executor.connections.get({
          owner: "org",
          integration: INTEG,
          name: ConnectionName.make("main"),
        });
        expect(connection?.lastHealth).toMatchObject(expired);

        // The sync time still stamps, so the failing catalog is not
        // re-attempted on every read.
        const row = yield* Effect.promise(() =>
          config.db.findFirst("connection", {
            where: (b) => b.and(b("integration", "=", String(INTEG)), b("name", "=", "main")),
          }),
        );
        expect(row?.tools_synced_at).not.toBeNull();
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
  readonly probe?: Effect.Effect<typeof HealthCheckResult.Type, unknown>;
}) => {
  const counters = { probes: 0, resolves: 0 };
  const hooks = {
    // Runs inside every invocation before it returns, so a test can interleave
    // a concurrent write (e.g. a refresh discovering invalid_grant) between the
    // row load and the heal-on-use decision.
    onInvoke: Effect.void as Effect.Effect<void>,
    // Runs inside every credential-provider read (counted in
    // `counters.resolves`), so a Deferred here holds the credential-only
    // health path open the way a Deferred probe holds the probing path open.
    onResolve: Effect.void as Effect.Effect<void>,
    // One-shot: runs immediately before a connection UPDATE that writes
    // `last_health` reaches the database — INSIDE a verdict guard's
    // check-to-write window, after its fresh read has already been taken.
    // Cleared before it runs, so the conflicting write it performs (through
    // the unwrapped `config.db`) is not intercepted again.
    beforeHealthPersist: null as Effect.Effect<void> | null,
    // Replaces the plugin's `resolveTools` outcome, so a test can drive the
    // incomplete-catalog path that persists a plugin-supplied health verdict
    // (`stampSyncedWithHealth`).
    resolveTools: null as Effect.Effect<ResolveToolsResult> | null,
  };
  // Wraps the executor's FumaDb handle so `beforeHealthPersist` can commit a
  // conflicting write in the exact window the write guards must close.
  // `withContext` re-wraps because `createExecutor` rebinds the handle to its
  // owner context; without that the interception would be dropped.
  const interceptHealthWrites = (db: FumaDb): FumaDb =>
    new Proxy(db as object, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === "withContext") {
          return (context: unknown) =>
            interceptHealthWrites((value as (context: unknown) => FumaDb).call(target, context));
        }
        if (prop === "updateMany") {
          return async (
            table: string,
            updateOptions: { readonly set?: Record<string, unknown> },
          ) => {
            const hook = hooks.beforeHealthPersist;
            if (
              hook !== null &&
              table === "connection" &&
              updateOptions.set !== undefined &&
              "last_health" in updateOptions.set
            ) {
              hooks.beforeHealthPersist = null;
              await Effect.runPromise(hook);
            }
            return (value as (...args: unknown[]) => Promise<void>).call(
              target,
              table,
              updateOptions,
            );
          };
        }
        return value;
      },
    }) as FumaDb;
  const baseProvider = memoryProvider();
  const countingProvider: CredentialProvider = {
    ...baseProvider,
    get: (id) =>
      Effect.suspend(() => {
        counters.resolves += 1;
        return hooks.onResolve.pipe(Effect.andThen(baseProvider.get(id)));
      }),
  };
  const plugin = definePlugin(() => ({
    id: "healthdemo" as const,
    credentialProviders: [countingProvider],
    storage: () => ({}),
    resolveTools: () =>
      Effect.suspend(
        () =>
          hooks.resolveTools ??
          Effect.succeed({ tools: [{ name: ToolName.make("deploy"), description: "deploy" }] }),
      ),
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
    const executor = yield* createExecutor({ ...config, db: interceptHealthWrites(config.db) });
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
    // The public connection shape omits `tools_synced_at`; read the raw row
    // for tests asserting a conflicting sync's stamp survived a guard.
    const rawRow = () =>
      Effect.promise(() =>
        config.db.findFirst("connection", {
          where: (b) => b.and(b("integration", "=", String(INTEG)), b("name", "=", "main")),
        }),
      );
    return { executor, counters, stamp, persisted, rawRow, hooks } as const;
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
      // Completed on probe entry, AFTER `counters.probes` has been bumped:
      // awaiting it is the explicit "a probe has started" ordering point (a
      // wall-clock sleep is a timing assumption that loses under suite load).
      const entered = yield* Deferred.make<void>();
      const { executor, counters, stamp, persisted } = yield* makeHealthHarness({
        probe: Deferred.succeed(entered, void 0).pipe(
          Effect.andThen(Deferred.await(gate)),
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
      // Wait until the first probe has provably started. The gate still holds
      // it open, so NOTHING has been persisted: every list that runs must pass
      // the freshness check into the probe path, and the in-flight gate must
      // keep the count at one — any duplicate a later list starts is caught by
      // the final count below.
      yield* Deferred.await(entered);
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

  it.effect("a buried dead-grant verdict presents expired on every read, without a write", () =>
    Effect.gen(function* () {
      const { executor, counters, stamp, persisted, rawRow } = yield* makeHealthHarness();
      const detail = "invalid_grant: Grant not found";
      // A racing writer's verdict landed after the recorder's: the row reads
      // "degraded" while provider_state still records the dead grant.
      yield* stamp({
        provider_state: { oauthReauthRequiredAt: Date.now(), oauthReauthRequiredDetail: detail },
        last_health: {
          status: "degraded",
          checkedAt: Date.now(),
          detail: "Tool sync failing: upstream rejected the credential",
        },
      });
      const before = yield* rawRow();

      // Check now: still no probe — the dead grant refuses those — and the
      // served verdict is the authoritative expired one, not the buried
      // degraded.
      const manual = yield* executor.connections.checkHealth({
        owner: "org",
        integration: INTEG,
        name: ConnectionName.make("main"),
      });
      expect(manual.status).toBe("expired");
      expect(manual.detail).toBe(detail);
      expect(counters.probes).toBe(0);

      // connections.get and the agent list present the same derivation.
      const row = yield* persisted();
      expect(row?.lastHealth).toMatchObject({ status: "expired", detail });
      const out = (yield* executor.execute(CORE_LIST, {})) as ListedConnections;
      const listed = out.connections.find((c) => c.name === "main");
      expect(listed?.lastHealth?.status).toBe("expired");
      expect(counters.probes).toBe(0);

      // Derivation, not repair: no read wrote anything back. A repair write
      // could race a concurrent reconnect and stamp the old grant's expired
      // verdict onto the fresh connection; presenting from `provider_state`
      // needs no write, so there is nothing to race.
      const after = yield* rawRow();
      expect(after?.updated_at).toEqual(before?.updated_at);
      expect(after?.last_health).toEqual(before?.last_health);
    }),
  );

  it.effect("reconnect clearing the dead grant ends the derivation on reads", () =>
    Effect.gen(function* () {
      const { executor, counters, stamp, persisted } = yield* makeHealthHarness();
      yield* stamp({
        provider_state: {
          oauthReauthRequiredAt: Date.now(),
          oauthReauthRequiredDetail: "invalid_grant",
        },
        last_health: {
          status: "degraded",
          checkedAt: Date.now(),
          detail: "Tool sync failing: upstream rejected the credential",
        },
      });
      const buried = yield* persisted();
      expect(buried?.lastHealth?.status).toBe("expired");

      // The reconnect mint rewrites `provider_state` wholesale and clears the
      // old grant's verdict. That alone must end the expired presentation —
      // no repair write exists to resurrect the old grant's verdict onto the
      // fresh connection.
      yield* stamp({ provider_state: null, last_health: null, updated_at: new Date() });

      const fresh = yield* persisted();
      expect(fresh?.lastHealth).toBeNull();

      // And probing is re-opened for the new grant.
      const check = yield* executor.connections.checkHealth({
        owner: "org",
        integration: INTEG,
        name: ConnectionName.make("main"),
      });
      expect(check.status).toBe("healthy");
      expect(counters.probes).toBe(1);
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
        credential_write: null,
        last_health: { status: "expired", checkedAt: Date.now() - STALE_MS, detail: "HTTP 401" },
      });

      yield* executor.execute(ToolAddress.make("tools.vercel.org.main.deploy"), {});

      const row = yield* persisted();
      expect(row?.lastHealth?.status).toBe("expired");
    }),
  );
});

// ---------------------------------------------------------------------------
// The guards above re-take their decision from a fresh row at write time, but
// a re-read alone leaves a window: a conflicting write can commit AFTER the
// fresh read and BEFORE the guard's own UPDATE. These tests commit the
// conflict inside that exact window (`hooks.beforeHealthPersist` fires after
// the guard's fresh read, immediately before its UPDATE reaches the
// database) and assert the guarded write loses: the UPDATE is
// compare-and-swapped on the `updated_at` stamp the fresh read observed, so
// the conflict's bump makes it match zero rows. Every initial stamp ages
// `updated_at` because SQLite stores the stamp at second granularity — the
// conflict's fresh stamp must land in a different granule than the observed
// one for the swap to see it.
// ---------------------------------------------------------------------------

describe("verdict write guards close the check-to-write window", () => {
  const REF = { owner: "org", integration: INTEG, name: ConnectionName.make("main") } as const;

  it.effect("probe persist: a dead grant recorded inside the window survives", () =>
    Effect.gen(function* () {
      const { executor, counters, stamp, persisted, hooks } = yield* makeHealthHarness();
      yield* stamp({
        last_health: { status: "expired", checkedAt: Date.now() - STALE_MS, detail: "HTTP 401" },
        updated_at: new Date(Date.now() - STALE_MS),
      });
      // The probe passes on the old access token's remaining lifetime while a
      // concurrent refresh discovers invalid_grant. The dead-grant write
      // commits after the guard's fresh read (which saw no dead grant) and
      // before its UPDATE — the window a re-read alone cannot close.
      hooks.beforeHealthPersist = stamp({
        provider_state: {
          oauthReauthRequiredAt: Date.now(),
          oauthReauthRequiredDetail: "invalid_grant",
        },
        last_health: { status: "expired", checkedAt: Date.now(), detail: "invalid_grant" },
        updated_at: new Date(),
      }).pipe(Effect.asVoid);

      const result = yield* executor.connections.checkHealth(REF);
      expect(result.status).toBe("healthy");
      expect(counters.probes).toBe(1);

      // The dead-grant verdict survived the probe's guarded write...
      const row = yield* persisted();
      expect(row?.lastHealth).toMatchObject({ status: "expired", detail: "invalid_grant" });

      // ...and the next check serves it without probing, as for any dead grant.
      const after = yield* executor.connections.checkHealth(REF);
      expect(after.status).toBe("expired");
      expect(counters.probes).toBe(1);
    }),
  );

  it.effect("heal-on-use: a dead grant recorded inside the window survives", () =>
    Effect.gen(function* () {
      const { executor, stamp, persisted, hooks } = yield* makeHealthHarness();
      yield* stamp({
        last_health: { status: "expired", checkedAt: Date.now() - STALE_MS, detail: "HTTP 401" },
        updated_at: new Date(Date.now() - STALE_MS),
      });
      // Heal-on-use re-reads, sees the stale verdict it observed at load and
      // no dead grant, and decides to heal — then the dead-grant write
      // commits before its UPDATE.
      hooks.beforeHealthPersist = stamp({
        provider_state: { oauthReauthRequiredAt: Date.now() },
        last_health: { status: "expired", checkedAt: Date.now(), detail: "invalid_grant" },
        updated_at: new Date(),
      }).pipe(Effect.asVoid);

      yield* executor.execute(ToolAddress.make("tools.vercel.org.main.deploy"), {});

      const row = yield* persisted();
      expect(row?.lastHealth).toMatchObject({ status: "expired", detail: "invalid_grant" });
    }),
  );

  it.effect("heal-on-use: a newer verdict written inside the window survives", () =>
    Effect.gen(function* () {
      const { executor, stamp, persisted, hooks } = yield* makeHealthHarness();
      yield* stamp({
        last_health: { status: "expired", checkedAt: Date.now() - STALE_MS, detail: "HTTP 401" },
        updated_at: new Date(Date.now() - STALE_MS),
      });
      const newerDetail = "revoked upstream while the heal was in flight";
      hooks.beforeHealthPersist = stamp({
        last_health: { status: "expired", checkedAt: Date.now(), detail: newerDetail },
        updated_at: new Date(),
      }).pipe(Effect.asVoid);

      yield* executor.execute(ToolAddress.make("tools.vercel.org.main.deploy"), {});

      const row = yield* persisted();
      expect(row?.lastHealth).toMatchObject({ status: "expired", detail: newerDetail });
    }),
  );

  // The three tests above age `updated_at` so the conflict's bump lands in a
  // different SQLite second granule. The three below do the opposite: the
  // conflict reuses the EXACT stamp the guard's fresh read observed — the
  // same-second collision `updated_at` alone cannot see — so only the
  // `tools_synced_at` leg of the swap can refuse the guarded write. The
  // conflict is the one collision that must never be buried: a failing tool
  // sync stores its degraded verdict TOGETHER with a fresh `tools_synced_at`,
  // so a guard overwriting it with "healthy" would also leave the catalog
  // looking just-synced and hide the failure for the full sync TTL.

  const SYNC_DETAIL = "Tool sync failing: plugin returned an incomplete tool catalog";

  it.effect("probe persist: a failing sync landing in the same second survives", () =>
    Effect.gen(function* () {
      const { executor, counters, stamp, persisted, rawRow, hooks } = yield* makeHealthHarness();
      const observedUpdatedAt = new Date();
      const observedSyncedAt = Date.now() - STALE_MS;
      yield* stamp({
        last_health: { status: "expired", checkedAt: Date.now() - STALE_MS, detail: "HTTP 401" },
        updated_at: observedUpdatedAt,
        tools_synced_at: observedSyncedAt,
      });
      const freshSyncedAt = Date.now();
      hooks.beforeHealthPersist = stamp({
        tools_synced_at: freshSyncedAt,
        last_health: { status: "degraded", checkedAt: Date.now(), detail: SYNC_DETAIL },
        updated_at: observedUpdatedAt,
      }).pipe(Effect.asVoid);

      const result = yield* executor.connections.checkHealth(REF);
      expect(result.status).toBe("healthy");
      expect(counters.probes).toBe(1);

      const row = yield* persisted();
      expect(row?.lastHealth).toMatchObject({ status: "degraded", detail: SYNC_DETAIL });
      const raw = yield* rawRow();
      expect(Number(raw?.tools_synced_at)).toBe(freshSyncedAt);
    }),
  );

  it.effect("heal-on-use: a failing sync landing in the same second survives", () =>
    Effect.gen(function* () {
      const { executor, stamp, persisted, rawRow, hooks } = yield* makeHealthHarness();
      const observedUpdatedAt = new Date();
      const observedSyncedAt = Date.now() - STALE_MS;
      yield* stamp({
        last_health: { status: "expired", checkedAt: Date.now() - STALE_MS, detail: "HTTP 401" },
        updated_at: observedUpdatedAt,
        tools_synced_at: observedSyncedAt,
      });
      // `+ 1` rather than `Date.now()`: the invocation itself may re-stamp
      // `tools_synced_at` before the heal's fresh read, and the conflicting
      // sync stamp must be guaranteed to differ from whatever that read
      // observed — an aged value + 1 can match neither it nor "now".
      const freshSyncedAt = observedSyncedAt + 1;
      hooks.beforeHealthPersist = stamp({
        tools_synced_at: freshSyncedAt,
        last_health: { status: "degraded", checkedAt: Date.now(), detail: SYNC_DETAIL },
        updated_at: observedUpdatedAt,
      }).pipe(Effect.asVoid);

      yield* executor.execute(ToolAddress.make("tools.vercel.org.main.deploy"), {});

      const row = yield* persisted();
      expect(row?.lastHealth).toMatchObject({ status: "degraded", detail: SYNC_DETAIL });
      const raw = yield* rawRow();
      expect(Number(raw?.tools_synced_at)).toBe(freshSyncedAt);
    }),
  );

  it.effect("probe persist: the sync leg guards a never-synced row (NULL stamp)", () =>
    Effect.gen(function* () {
      const { executor, stamp, persisted, hooks } = yield* makeHealthHarness();
      const observedUpdatedAt = new Date();
      yield* stamp({
        last_health: { status: "expired", checkedAt: Date.now() - STALE_MS, detail: "HTTP 401" },
        updated_at: observedUpdatedAt,
        tools_synced_at: null,
      });
      hooks.beforeHealthPersist = stamp({
        tools_synced_at: Date.now(),
        last_health: { status: "degraded", checkedAt: Date.now(), detail: SYNC_DETAIL },
        updated_at: observedUpdatedAt,
      }).pipe(Effect.asVoid);

      const result = yield* executor.connections.checkHealth(REF);
      expect(result.status).toBe("healthy");

      const row = yield* persisted();
      expect(row?.lastHealth).toMatchObject({ status: "degraded", detail: SYNC_DETAIL });
    }),
  );

  it.effect("tool-sync verdict persist: a reconnect landing inside the window wins", () =>
    Effect.gen(function* () {
      const { executor, stamp, persisted, hooks } = yield* makeHealthHarness();
      // Age the stamp so the reconnect's bump lands in a different granule.
      yield* stamp({ updated_at: new Date(Date.now() - STALE_MS) });
      // The refresh's discovery meets a reauthorization condition on the OLD
      // credential and reports an actionable expired verdict...
      hooks.resolveTools = Effect.succeed({
        tools: [],
        incomplete: true,
        incompleteReason: "MCP OAuth re-authorization required",
        health: {
          status: "expired" as const,
          checkedAt: Date.now(),
          detail: "MCP OAuth reauthorization required",
        },
      });
      // ...while a reconnect commits inside the check-to-write window: the
      // replacement grant clears the verdict and any dead-grant state and
      // bumps the stamp. The read-side dead-grant guard cannot refuse the
      // stale verdict — the reconnected row has nothing for it to observe —
      // so only the compare-and-swap can.
      hooks.beforeHealthPersist = stamp({
        provider_state: null,
        last_health: null,
        updated_at: new Date(),
      }).pipe(Effect.asVoid);

      yield* executor.connections.refresh(REF);

      const row = yield* persisted();
      expect(row?.lastHealth ?? null).toBeNull();
    }),
  );
});

describe("credential-only health path", () => {
  it.effect("concurrent checks collapse to one credential resolution", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      // Completed by the provider on entry, AFTER the resolve counter has
      // been bumped: awaiting it is the explicit "a resolution has started"
      // ordering point. A wall-clock sleep here is a timing assumption — under
      // parallel suite load the forked checks may not have finished their row
      // loads yet, and the counter reads 0.
      const entered = yield* Deferred.make<void>();
      const { executor, counters, stamp, persisted, hooks } = yield* makeHealthHarness();
      // No declared probe spec + an OAuth client on the row routes checkHealth
      // down the credential-only path: the verdict is "the credential
      // resolved", produced without invoking the plugin probe. That path runs
      // behind the same in-flight gate as probing, so concurrent checks must
      // collapse to ONE resolution.
      yield* stamp({ oauth_client: "acme", expires_at: null });
      hooks.onResolve = Deferred.succeed(entered, void 0).pipe(
        Effect.andThen(Deferred.await(gate)),
      );
      counters.resolves = 0;
      const ref = { owner: "org", integration: INTEG, name: ConnectionName.make("main") } as const;

      const checks = yield* Effect.forkChild(
        Effect.all([executor.connections.checkHealth(ref), executor.connections.checkHealth(ref)], {
          concurrency: "unbounded",
        }),
      );
      // Wait until the first resolution has provably entered the provider.
      // The gate still holds it open, so nothing has been persisted: while it
      // holds, the in-flight gate must keep the count at exactly one — and any
      // duplicate the second check ever starts is caught by the final count
      // below.
      yield* Deferred.await(entered);
      expect(counters.resolves).toBe(1);

      yield* Deferred.succeed(gate, void 0);
      const [first, second] = yield* Fiber.join(checks);
      expect(first.status).toBe("healthy");
      expect(second.status).toBe("healthy");
      expect(counters.resolves).toBe(1);
      expect(counters.probes).toBe(0);

      const row = yield* persisted();
      expect(row?.lastHealth?.status).toBe("healthy");
    }),
  );
});

describe("health probe gate lifecycle", () => {
  it.effect("a failed probe clears its gate entry for the next check", () =>
    Effect.gen(function* () {
      let firstProbe = true;
      const { executor, counters } = yield* makeHealthHarness({
        probe: Effect.suspend(() => {
          if (firstProbe) {
            firstProbe = false;
            return Effect.fail("probe exploded" as const);
          }
          return Effect.succeed({
            status: "healthy" as const,
            checkedAt: Date.now(),
            detail: "probe ok",
          });
        }),
      });
      const ref = { owner: "org", integration: INTEG, name: ConnectionName.make("main") } as const;

      const first = yield* executor.connections.checkHealth(ref).pipe(Effect.exit);
      expect(Exit.isFailure(first)).toBe(true);

      // A leaked gate entry would hand this check the first probe's settled
      // Deferred (failing again without probing); a second probe run proves
      // the failure removed the entry.
      const second = yield* executor.connections.checkHealth(ref);
      expect(second.status).toBe("healthy");
      expect(counters.probes).toBe(2);
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
      // Completed by the probe that brings the count to two: awaiting it is
      // the explicit "both probes started" ordering point. A collided gate
      // never completes it (the second check joins the first probe's Deferred
      // instead of starting its own), which fails the test by timeout.
      const bothEntered = yield* Deferred.make<void>();
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
            const arrived =
              counters.probes >= 2 ? Deferred.succeed(bothEntered, void 0) : Effect.void;
            return arrived.pipe(
              Effect.andThen(Deferred.await(gate)),
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
      // Wait until both probes have provably started; the gate holds every
      // probe open, so both checks are in flight at once and nothing has been
      // persisted.
      yield* Deferred.await(bothEntered);
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

// ---------------------------------------------------------------------------
// Flip telemetry on the health span. `previous_status` + `changed` record
// which verdict a check REPLACED, so flapping (healthy↔degraded oscillation)
// is a queryable dimension instead of a per-connection diff over consecutive
// spans; `reason` carries the enumerable failure mechanism where the free-text
// `detail` can never go. Asserted through the span because the span IS the
// deliverable: nothing else user-visible changes.
// ---------------------------------------------------------------------------

/** Records every span the program opens, so stamped attributes can be read
 *  back (same pattern as the MCP plugin's telemetry tests). */
const recordingTracer = (spans: Array<Tracer.NativeSpan>) =>
  Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
    context: (primitive, fiber) => primitive["~effect/Effect/evaluate"](fiber),
  });

describe("connections.checkHealth flip telemetry", () => {
  const REF = {
    owner: "org",
    integration: INTEG,
    name: ConnectionName.make("main"),
  } as const;

  const lastHealthSpan = (spans: ReadonlyArray<Tracer.NativeSpan>): Tracer.NativeSpan => {
    const matches = spans.filter((span) => span.name === "executor.connection.health.check");
    const last = matches[matches.length - 1];
    expect(last).toBeDefined();
    // SAFETY: the expect above fails the test before this narrows undefined.
    return last as Tracer.NativeSpan;
  };

  it.effect("stamps previous_status + changed=true when a probe replaces a verdict", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const { executor, stamp } = yield* makeHealthHarness();
      yield* stamp({
        last_health: { status: "degraded", checkedAt: Date.now() - STALE_MS, detail: "HTTP 502" },
      });

      const result = yield* executor.connections
        .checkHealth(REF)
        .pipe(Effect.provideService(Tracer.Tracer, recordingTracer(spans)));
      expect(result.status).toBe("healthy");

      const span = lastHealthSpan(spans);
      expect(span.attributes.get("executor.health.status")).toBe("healthy");
      expect(span.attributes.get("executor.health.previous_status")).toBe("degraded");
      expect(span.attributes.get("executor.health.changed")).toBe(true);
    }),
  );

  it.effect("stamps changed=false when a probe reconfirms the persisted verdict", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const { executor, stamp } = yield* makeHealthHarness();
      yield* stamp({
        last_health: { status: "healthy", checkedAt: Date.now() - STALE_MS, detail: "probe ok" },
      });

      yield* executor.connections
        .checkHealth(REF)
        .pipe(Effect.provideService(Tracer.Tracer, recordingTracer(spans)));

      const span = lastHealthSpan(spans);
      expect(span.attributes.get("executor.health.previous_status")).toBe("healthy");
      expect(span.attributes.get("executor.health.changed")).toBe(false);
    }),
  );

  it.effect("stamps neither flip key on a first-ever verdict", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const { executor } = yield* makeHealthHarness();

      yield* executor.connections
        .checkHealth(REF)
        .pipe(Effect.provideService(Tracer.Tracer, recordingTracer(spans)));

      // Never-checked is not a flip: a fleet-wide first probe must not read
      // as a wave of changes.
      const span = lastHealthSpan(spans);
      expect(span.attributes.has("executor.health.previous_status")).toBe(false);
      expect(span.attributes.has("executor.health.changed")).toBe(false);
    }),
  );

  it.effect("stamps the probe's reason on the span and persists it on the row", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const { executor, persisted } = yield* makeHealthHarness({
        probe: Effect.sync(() => ({
          status: "degraded" as const,
          checkedAt: Date.now(),
          detail: "upstream deadline exceeded",
          reason: "probe_timeout" as const,
        })),
      });

      const result = yield* executor.connections
        .checkHealth(REF)
        .pipe(Effect.provideService(Tracer.Tracer, recordingTracer(spans)));
      expect(result.reason).toBe("probe_timeout");

      const span = lastHealthSpan(spans);
      expect(span.attributes.get("executor.health.reason")).toBe("probe_timeout");

      const row = yield* persisted();
      expect(row?.lastHealth?.reason).toBe("probe_timeout");
    }),
  );
});
