import { Context, Effect, Layer } from "effect";
import { withQueryContext } from "@executor-js/fumadb/query";
import { collectTables, createExecutor, type Executor, type ExecutorConfig } from "./executor";
import type { FumaDb } from "./fuma-runtime";
import { ProviderItemId, ProviderKey, Subject, Tenant } from "./ids";
import { definePlugin, type AnyPlugin } from "./plugin";
import type { ExecutorOwnerPolicyContext } from "./owner-policy";
import type { CredentialProvider } from "./provider";
import type { SqliteTestFumaDb } from "./sqlite-test-db";

// ---------------------------------------------------------------------------
// makeTestConfig — build an ExecutorConfig backed by an in-memory FumaDB.
// For unit tests, plugin authors validating their plugin, REPL experimentation.
//
// Defaults to a single tenant ("test-tenant") with a bound subject
// ("test-subject"). Tests that need a pure-org executor can pass `subject:
// null` via a spread override.
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

  const makeDb = (context?: ExecutorOwnerPolicyContext): FumaDb =>
    new Proxy(
      { internal: context === undefined ? internal : { ...internal, context } },
      {
        get(target, prop) {
          if (prop === "internal") return target.internal;
          if (prop === "withContext") {
            return (nextContext: ExecutorOwnerPolicyContext) => makeDb(nextContext);
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

/** The OAuth callback the in-memory test executor advertises. The OAuth flow
 *  tests exercise `start` (authorization_code), which now REQUIRES an explicit
 *  `redirectUri` — there is no localhost default. The test authorization server
 *  accepts any redirect_uri for an unregistered client, so this stable value is
 *  what the test AS echoes back. Tests asserting the "missing redirectUri fails
 *  loudly" path override this with `redirectUri: null`. */
export const TEST_OAUTH_REDIRECT_URI = "http://localhost/oauth/callback";

export type TestConfigOptions<TPlugins extends readonly AnyPlugin[] = readonly []> = {
  readonly tenant?: string;
  readonly subject?: string | null;
  readonly plugins?: TPlugins;
  readonly backend?: TestDatabaseBackend;
  readonly dataDir?: string;
  readonly coreTools?: ExecutorConfig<TPlugins>["coreTools"];
  /** Override the OAuth callback URL. Pass `null` to construct an executor with
   *  no OAuth callback (exercises the fail-loud redirect path). */
  readonly redirectUri?: string | null;
};

export const makeTestConfig = <const TPlugins extends readonly AnyPlugin[] = readonly []>(
  options?: TestConfigOptions<TPlugins>,
): Omit<ExecutorConfig<TPlugins>, "db"> & {
  readonly db: FumaDb;
  readonly testDb: TestFumaDb;
} => {
  const tenant = options?.tenant ?? "test-tenant";
  const subject = options?.subject === undefined ? "test-subject" : options.subject;

  const tables = collectTables();
  const testDb = makeLazyTestFumaDb({
    tables,
    backend: options?.backend ?? "sqlite",
    dataDir: options?.dataDir,
  });
  const db = withQueryContext(testDb.db, {
    tenant,
    subject,
  } satisfies ExecutorOwnerPolicyContext);

  // EXPLICIT OAuth callback: default to a stable test URL so the redirect flow
  // tests work without the removed localhost default; `redirectUri: null` omits
  // it so a test can exercise the fail-loud "no callback configured" path.
  const redirectUri =
    options?.redirectUri === undefined ? TEST_OAUTH_REDIRECT_URI : options.redirectUri;

  return {
    tenant: Tenant.make(tenant),
    ...(subject != null ? { subject: Subject.make(subject) } : {}),
    db,
    plugins: options?.plugins,
    coreTools: options?.coreTools,
    testDb,
    // Tests default to auto-accepting elicitation prompts.
    onElicitation: "accept-all",
    ...(redirectUri != null ? { redirectUri } : {}),
  };
};

export interface TestWorkspaceHarness<
  TPlugins extends readonly AnyPlugin[] = readonly AnyPlugin[],
> {
  readonly config: ExecutorConfig<TPlugins> & { readonly testDb: TestFumaDb };
  readonly executor: Executor<TPlugins>;
  readonly testDb: TestFumaDb;
  readonly tenant: string;
  readonly subject: string | null;
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
        tenant: String(config.tenant),
        subject: config.subject != null ? String(config.subject) : null,
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

/** Built-in in-memory writable credential provider, contributed as a plugin
 *  so tests always have a default writable store for inline connection values. */
export const memoryCredentialsPlugin = definePlugin(() => {
  const store = new Map<string, string>();

  const provider: CredentialProvider = {
    key: ProviderKey.make("memory"),
    writable: true,
    get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
    set: (id, value) =>
      Effect.sync(() => {
        store.set(String(id), value);
      }),
    delete: (id) =>
      Effect.sync(() => {
        store.delete(String(id));
      }),
    list: () =>
      Effect.sync(() =>
        Array.from(store.keys()).map((key) => ({
          id: ProviderItemId.make(key),
          name: key,
        })),
      ),
  };

  return {
    id: "memory-credentials" as const,
    storage: () => ({}),
    credentialProviders: [provider],
  };
});

// Back-compat alias removed: v1 `memorySecretsPlugin` is gone (no secrets).
