import { Context, Data, Effect, Layer, ManagedRuntime } from "effect";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";

import { Subject, Tenant, createExecutor, type AnyPlugin, type Executor } from "@executor-js/sdk";
import { runSqliteAuthConfigMigration } from "@executor-js/sdk/http-auth";
import { collectTables } from "@executor-js/api/server";
import { loadPluginsFromJsonc } from "@executor-js/config";

import executorConfig from "../executor.config";
import { authConfigTransforms } from "./db/auth-config-migration";
import { createSqliteFumaDb } from "./db/sqlite-fumadb";
import { migrateLocalV1ToV2IfNeeded } from "./db/v1-v2-migration";

interface ResolvedStorage {
  readonly dataDir: string;
  readonly sqlitePath: string;
}

const localNamespace = "executor_local";

// The single local subject. Local is single-user; the executor binds one
// tenant (the cwd-derived workspace) plus this subject so it can own both
// `owner: "org"` (workspace-shared) and `owner: "user"` connections.
const LOCAL_SUBJECT = "local";

const resolveStorage = (): ResolvedStorage => {
  const dataDir = process.env.EXECUTOR_DATA_DIR ?? join(homedir(), ".executor");
  fs.mkdirSync(dataDir, { recursive: true });
  return {
    dataDir,
    sqlitePath: join(dataDir, "data.db"),
  };
};

// Hash suffix disambiguates same-basename folders so two projects with
// identical directory names cannot collide on the same tenant id.
const makeTenantId = (cwd: string): string => {
  const folder = basename(cwd) || cwd;
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  return `${folder}-${hash}`;
};

const resolvePluginConfigPath = (scopeDir: string): string => join(scopeDir, "executor.jsonc");

// Plugins reach the host through two doors that compose:
//   - `executor.config.ts`'s static tuple
//   - `executor.jsonc#plugins` loaded at boot
// Static config wins on conflict, matching the Vite plugin.
type LocalPlugins = readonly AnyPlugin[];

const loadLocalPlugins = Effect.gen(function* () {
  const cwd = process.env.EXECUTOR_SCOPE_DIR || process.cwd();
  const staticPlugins = executorConfig.plugins();
  const dynamicPlugins =
    (yield* Effect.promise(() => loadPluginsFromJsonc({ path: resolvePluginConfigPath(cwd) }))) ??
    [];

  const staticPackageNames = new Set(
    staticPlugins.map((plugin) => plugin.packageName).filter((name): name is string => !!name),
  );
  const dedupedDynamic = dynamicPlugins.filter((plugin) => {
    if (plugin.packageName && staticPackageNames.has(plugin.packageName)) {
      console.warn(
        `[executor] plugin "${plugin.packageName}" appears in both ` +
          `executor.config.ts and executor.jsonc#plugins. The static ` +
          `entry wins; the jsonc entry is ignored.`,
      );
      return false;
    }
    return true;
  });

  return {
    cwd,
    plugins: [...staticPlugins, ...dedupedDynamic] as LocalPlugins,
  };
});

interface LocalExecutorBundle {
  readonly executor: Executor<LocalPlugins>;
  readonly plugins: LocalPlugins;
}

class LocalExecutorTag extends Context.Service<LocalExecutorTag, LocalExecutorBundle>()(
  "@executor-js/local/Executor",
) {}

export type LocalExecutor = LocalExecutorBundle["executor"];

class LocalExecutorCreateError extends Data.TaggedError("LocalExecutorCreateError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

class LocalExecutorDisposeError extends Data.TaggedError("LocalExecutorDisposeError")<{
  readonly operation: "createHandle" | "disposeExecutor" | "disposeRuntime";
  readonly cause: unknown;
}> {}

const CREATE_SQLITE_ERROR_MESSAGE =
  "Failed to open local SQLite data. Close other Executor processes and retry, or run with --log-level debug for details.";

const ignorePromiseFailure = (
  operation: LocalExecutorDisposeError["operation"],
  try_: () => Promise<unknown>,
) =>
  Effect.runPromise(
    Effect.ignore(
      Effect.tryPromise({
        try: try_,
        catch: (cause) => new LocalExecutorDisposeError({ operation, cause }),
      }),
    ),
  );

const handleOrNull = (promise: ReturnType<typeof createExecutorHandle>) =>
  Effect.runPromise(
    Effect.tryPromise({
      try: () => promise,
      catch: (cause) => new LocalExecutorDisposeError({ operation: "createHandle", cause }),
    }).pipe(
      Effect.catch(() =>
        Effect.succeed<Awaited<ReturnType<typeof createExecutorHandle>> | null>(null),
      ),
    ),
  );

const createLocalExecutorLayer = () => {
  const storage = resolveStorage();

  return Layer.effect(LocalExecutorTag)(
    Effect.gen(function* () {
      const { cwd, plugins } = yield* loadLocalPlugins;
      const tenantId = makeTenantId(cwd);
      const tables = collectTables();

      const migration = yield* Effect.tryPromise({
        try: () =>
          migrateLocalV1ToV2IfNeeded({
            sqlitePath: storage.sqlitePath,
            tables,
            namespace: localNamespace,
            tenantId,
          }),
        catch: (cause) =>
          new LocalExecutorCreateError({
            message: CREATE_SQLITE_ERROR_MESSAGE,
            cause,
          }),
      });

      const sqlite = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            createSqliteFumaDb({
              tables,
              namespace: localNamespace,
              path: storage.sqlitePath,
            }),
          catch: (cause) =>
            new LocalExecutorCreateError({
              message: CREATE_SQLITE_ERROR_MESSAGE,
              cause,
            }),
        }),
        (db) => Effect.promise(() => db.close()).pipe(Effect.ignore),
      );

      // One-off data migration: rewrite pre-canonical integration auth
      // configs (incl. v1→v2 outputs) into the shared placements model.
      // Idempotent — a no-op once every row is canonical.
      yield* Effect.tryPromise({
        try: () => runSqliteAuthConfigMigration(sqlite.client, authConfigTransforms),
        catch: (cause) =>
          new LocalExecutorCreateError({ message: CREATE_SQLITE_ERROR_MESSAGE, cause }),
      });

      // webBaseUrl is where the executor's web UI listens — same port as the
      // daemon API since the daemon serves both. Mirrors serve.ts's port
      // resolution so a custom $PORT flows through. EXECUTOR_WEB_BASE_URL
      // overrides entirely for deployments where the UI is on a different host.
      const webBaseUrl =
        process.env.EXECUTOR_WEB_BASE_URL ?? `http://localhost:${process.env.PORT ?? "4788"}`;

      const executor = yield* createExecutor({
        tenant: Tenant.make(tenantId),
        subject: Subject.make(LOCAL_SUBJECT),
        db: sqlite.db,
        plugins,
        onElicitation: "accept-all",
        oauthEndpointUrlPolicy: { allowHttp: true },
        // EXPLICIT OAuth callback — the daemon serves the v2 `/api/oauth/callback`
        // route on the same origin as the web UI. Derived from `webBaseUrl`
        // (loopback localhost is correct + intended for the local CLI, but it
        // is wired explicitly here rather than relying on a hidden default).
        redirectUri: new URL("/api/oauth/callback", webBaseUrl).toString(),
        // Built-in agent-facing tools (integrations / connections / policies).
        coreTools: {
          webBaseUrl,
        },
      });

      if (migration.migrated) {
        console.warn(
          `[executor] Migrated local Executor data to v2; moved old DB to ${migration.backupPath}.`,
        );
        for (const warning of migration.warnings) {
          console.warn(`[executor] local v2 migration: ${warning}`);
        }
      }

      return { executor, plugins };
    }),
  );
};

export const createExecutorHandle = async () => {
  const layer = createLocalExecutorLayer();
  const runtime = ManagedRuntime.make(layer);
  const bundle = await runtime.runPromise(LocalExecutorTag.asEffect());

  return {
    executor: bundle.executor,
    plugins: bundle.plugins,
    dispose: async () => {
      await Effect.runPromise(Effect.ignore(bundle.executor.close()));
      await ignorePromiseFailure("disposeRuntime", () => runtime.dispose());
    },
  };
};

export type ExecutorHandle = Awaited<ReturnType<typeof createExecutorHandle>>;

let sharedHandlePromise: ReturnType<typeof createExecutorHandle> | null = null;

const loadSharedHandle = () => {
  if (!sharedHandlePromise) {
    sharedHandlePromise = createExecutorHandle();
  }
  return sharedHandlePromise;
};

export const getExecutor = () => loadSharedHandle().then((handle) => handle.executor);
export const getExecutorBundle = () => loadSharedHandle();

export const disposeExecutor = async (): Promise<void> => {
  const currentHandlePromise = sharedHandlePromise;
  sharedHandlePromise = null;

  const handle = currentHandlePromise ? await handleOrNull(currentHandlePromise) : null;
  if (handle) {
    await ignorePromiseFailure("disposeExecutor", () => handle.dispose());
  }
};

export const reloadExecutor = () => {
  disposeExecutor();
  return getExecutor();
};
