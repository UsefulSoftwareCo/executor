import { Context, Effect, Layer } from "effect";
import { withQueryContext } from "fumadb/query";
import { collectTables, createExecutor, type Executor, type ExecutorConfig } from "./executor";
import type { FumaDb } from "./fuma-runtime";
import { ScopeId } from "./ids";
import { definePlugin, type AnyPlugin } from "./plugin";
import { Scope } from "./scope";
import type { ExecutorScopePolicyContext } from "./scope-policy";
import type { SecretProvider } from "./secrets";
import type { SqliteTestFumaDb } from "./sqlite-test-db";

// ---------------------------------------------------------------------------
// makeTestConfig — build an ExecutorConfig backed by an in-memory FumaDB.
// For unit tests, plugin authors validating their plugin, REPL experimentation.
// No persistence unless a caller supplies `dataDir`.
//
// Defaults to a single-element scope stack ("test-scope") — tests that
// need multi-scope behavior can pass `scopes` explicitly.
// ---------------------------------------------------------------------------

export type TestDatabaseBackend = "sqlite";

export type TestFumaDb = Pick<SqliteTestFumaDb, "db" | "close"> & {
  readonly warm: () => Promise<void>;
};

const makeLazyTestFumaDb = (options: {
  readonly tables: ReturnType<typeof collectTables>;
  readonly backend: TestDatabaseBackend;
  readonly dataDir?: string;
}): TestFumaDb => {
  let started: Promise<SqliteTestFumaDb> | undefined;
  const start = () => {
    if (!started) {
      started = import("./sqlite-test-db").then(({ createSqliteTestFumaDb }) =>
        createSqliteTestFumaDb({
          tables: options.tables,
          namespace: "executor_test",
          path: options.dataDir ? `${options.dataDir}/test.db` : undefined,
        }),
      );
    }
    return started;
  };

  const internal: FumaDb["internal"] = {
    tables: options.tables,
    count: async (table, value) => (await start()).db.internal.count(table, value),
    create: async (table, values) => (await start()).db.internal.create(table, values),
    createMany: async (table, values) => (await start()).db.internal.createMany(table, values),
    deleteMany: async (table, value) => (await start()).db.internal.deleteMany(table, value),
    findFirst: async (table, value) => (await start()).db.internal.findFirst(table, value),
    findMany: async (table, value) => (await start()).db.internal.findMany(table, value),
    transaction: async (run) => (await start()).db.internal.transaction(run),
    updateMany: async (table, value) => (await start()).db.internal.updateMany(table, value),
    upsert: async (table, value) => (await start()).db.internal.upsert(table, value),
  };

  const queryMethods = new Set<PropertyKey>([
    "count",
    "create",
    "createMany",
    "deleteMany",
    "findFirst",
    "findMany",
    "transaction",
    "updateMany",
    "upsert",
  ]);

  const makeDb = (context?: ExecutorScopePolicyContext): FumaDb =>
    new Proxy(
      { internal: context === undefined ? internal : { ...internal, context } },
      {
        get(target, prop) {
          if (prop === "internal") return target.internal;
          if (prop === "withContext") {
            return (nextContext: ExecutorScopePolicyContext) => makeDb(nextContext);
          }
          if (!queryMethods.has(prop)) return undefined;

          return async (...args: unknown[]) => {
            const actual = await start();
            const actualDb =
              context === undefined ? actual.db : withQueryContext(actual.db, context);
            const method = Reflect.get(actualDb, prop) as (...innerArgs: unknown[]) => unknown;
            return method.apply(actualDb, args);
          };
        },
      },
    ) as FumaDb;

  const db = makeDb();

  return {
    db,
    warm: async () => {
      await start();
    },
    close: async () => {
      if (!started) return;
      await (await started).close();
    },
  };
};

export type TestConfigOptions<TPlugins extends readonly AnyPlugin[] = readonly []> = {
  readonly scopeName?: string;
  readonly scopes?: readonly Scope[];
  readonly plugins?: TPlugins;
  readonly backend?: TestDatabaseBackend;
  readonly dataDir?: string;
};

export const makeTestConfig = <const TPlugins extends readonly AnyPlugin[] = readonly []>(
  options?: TestConfigOptions<TPlugins>,
): Omit<ExecutorConfig<TPlugins>, "db"> & {
  readonly db: FumaDb;
  readonly testDb: TestFumaDb;
} => {
  const scopes = options?.scopes ?? [
    Scope.make({
      id: ScopeId.make("test-scope"),
      name: options?.scopeName ?? "test",
      createdAt: new Date(),
    }),
  ];

  const tables = collectTables(options?.plugins ?? []);
  const testDb = makeLazyTestFumaDb({
    tables,
    backend: options?.backend ?? "sqlite",
    dataDir: options?.dataDir,
  });
  const db = withQueryContext(testDb.db, {
    allowedScopeIds: new Set(scopes.map((scope) => String(scope.id))),
  } satisfies ExecutorScopePolicyContext);

  return {
    scopes,
    db,
    plugins: options?.plugins,
    testDb,
    // Tests default to auto-accepting elicitation prompts. Override via
    // a wrapping spread if a test exercises a real handler:
    //   { ...makeTestConfig(...), onElicitation: customHandler }
    onElicitation: "accept-all",
  };
};

export interface TestWorkspaceHarness<
  TPlugins extends readonly AnyPlugin[] = readonly AnyPlugin[],
> {
  readonly config: ExecutorConfig<TPlugins> & { readonly testDb: TestFumaDb };
  readonly executor: Executor<TPlugins>;
  readonly testDb: TestFumaDb;
  readonly scopes: readonly Scope[];
}

export class TestWorkspace extends Context.Service<TestWorkspace, TestWorkspaceHarness>()(
  "executor-sdk/TestWorkspace",
) {
  static readonly current = <
    const TPlugins extends readonly AnyPlugin[] = readonly AnyPlugin[],
  >() =>
    Effect.gen(function* () {
      const workspace = yield* TestWorkspace;
      return workspace as TestWorkspaceHarness<TPlugins>;
    });
}

export const makeTestWorkspaceHarness = <const TPlugins extends readonly AnyPlugin[] = readonly []>(
  options?: TestConfigOptions<TPlugins>,
) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const config = makeTestConfig(options);
      const executor = yield* createExecutor(config);
      return {
        config,
        executor,
        testDb: config.testDb,
        scopes: config.scopes,
      } as const;
    }),
    ({ executor, testDb }) =>
      executor
        .close()
        .pipe(
          Effect.ignore,
          Effect.andThen(Effect.promise(() => testDb.close()).pipe(Effect.ignore)),
        ),
  );

export const makeTestWorkspaceLayer = <const TPlugins extends readonly AnyPlugin[] = readonly []>(
  options?: TestConfigOptions<TPlugins>,
) =>
  Layer.effect(TestWorkspace)(
    makeTestWorkspaceHarness(options).pipe(
      Effect.tap(({ testDb }) => Effect.promise(() => testDb.warm())),
    ),
  );

export const makeTestExecutor = <const TPlugins extends readonly AnyPlugin[] = readonly []>(
  options?: TestConfigOptions<TPlugins>,
) => makeTestWorkspaceHarness(options).pipe(Effect.map(({ executor }) => executor));

export const memorySecretsPlugin = definePlugin(() => {
  const store = new Map<string, string>();

  const provider: SecretProvider = {
    key: "memory",
    writable: true,
    get: (id, scope) => Effect.sync(() => store.get(`${scope}\u0000${id}`) ?? null),
    set: (id, value, scope) =>
      Effect.sync(() => {
        store.set(`${scope}\u0000${id}`, value);
      }),
    delete: (id, scope) => Effect.sync(() => store.delete(`${scope}\u0000${id}`)),
    list: () =>
      Effect.sync(() =>
        Array.from(store.keys()).map((key) => {
          const name = key.split("\u0000", 2)[1] ?? key;
          return { id: name, name };
        }),
      ),
  };

  return {
    id: "memory-secrets" as const,
    storage: () => ({}),
    secretProviders: [provider],
  };
});
