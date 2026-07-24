import { Context, Data, Effect, Layer, ManagedRuntime } from "effect";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";

import {
  Subject,
  Tenant,
  createExecutor,
  runSqliteDataMigrations,
  type AnyPlugin,
  type Executor,
} from "@executor-js/sdk";
import { collectTables } from "@executor-js/api/server";
import { loadPluginsFromJsonc } from "@executor-js/config";
import type { McpPluginExtension } from "@executor-js/plugin-mcp";

import executorConfig from "../executor.config";
import { localDataMigrations } from "./db/data-migrations";
import { openOwnedLocalDatabase } from "./db/owned-database";

interface ResolvedStorage {
  readonly dataDir: string;
}

const localNamespace = "executor_local";

// The single local subject. Local is single-user; the executor binds one
// tenant (the cwd-derived workspace) plus this subject so it can own both
// `owner: "org"` (workspace-shared) and `owner: "user"` connections.
const LOCAL_SUBJECT = "local";

const resolveStorage = (): ResolvedStorage => {
  const dataDir = process.env.EXECUTOR_DATA_DIR ?? join(homedir(), ".executor");
  fs.mkdirSync(dataDir, { recursive: true });
  return { dataDir };
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

export interface LocalExecutorOptions {
  readonly activeToolkitSlug?: string;
}

const loadLocalPlugins = (options: LocalExecutorOptions = {}) =>
  Effect.gen(function* () {
    const cwd = process.env.EXECUTOR_SCOPE_DIR || process.cwd();
    const staticPlugins = executorConfig.plugins({
      activeToolkitSlug: options.activeToolkitSlug,
    });
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

/**
 * An executor over an ALREADY-OPEN local database, differing from the bundle's
 * own executor only in its plugin set (the `activeToolkitSlug` seam). Disposing
 * one closes just that executor's plugins: the SQLite handle and the data-dir
 * ownership lock belong to the bundle that derived it.
 */
export interface ScopedExecutorHandle {
  readonly executor: Executor<LocalPlugins>;
  readonly plugins: LocalPlugins;
  readonly dispose: () => Promise<void>;
}

interface LocalExecutorBundle {
  readonly executor: Executor<LocalPlugins>;
  readonly plugins: LocalPlugins;
  /**
   * Derive an executor with a different plugin scope over this bundle's open
   * database. The bundle holds the data dir's ownership lock (a `BEGIN
   * EXCLUSIVE` on `data.db.owner-lock`) for its whole lifetime, so anything
   * needing a differently-scoped executor IN THIS PROCESS must come through
   * here. Opening a second owned database instead deadlocks against that lock
   * and can never succeed while the daemon runs.
   */
  readonly createScopedExecutor: (options: LocalExecutorOptions) => Promise<ScopedExecutorHandle>;
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

const closeExecutorOnly = (executor: Executor<LocalPlugins>) => (): Promise<void> =>
  Effect.runPromise(Effect.ignore(executor.close()));

/**
 * Builds a bundle's `createScopedExecutor` from the seam that makes an executor
 * over its already-open database. Lives at module scope so the deferred
 * `Effect.runPromise` is not nested inside the layer's own Effect.
 */
const makeScopedExecutorFactory =
  <E>(makeExecutor: (plugins: LocalPlugins) => Effect.Effect<Executor<LocalPlugins>, E>) =>
  (scopedOptions: LocalExecutorOptions): Promise<ScopedExecutorHandle> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const scoped = yield* loadLocalPlugins(scopedOptions);
        const scopedExecutor = yield* makeExecutor(scoped.plugins);
        return {
          executor: scopedExecutor,
          plugins: scoped.plugins,
          // Closes this executor's plugins only. The database handle and the
          // data-dir ownership lock belong to the bundle that derived this.
          dispose: closeExecutorOnly(scopedExecutor),
        };
      }),
    );

const createLocalExecutorLayer = (options: LocalExecutorOptions = {}) => {
  const storage = resolveStorage();

  return Layer.effect(LocalExecutorTag)(
    Effect.gen(function* () {
      const { cwd, plugins } = yield* loadLocalPlugins(options);
      const tenantId = makeTenantId(cwd);
      const tables = collectTables();

      const owned = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            openOwnedLocalDatabase({
              dataDir: storage.dataDir,
              tables,
              namespace: localNamespace,
              tenantId,
            }),
          catch: (cause) =>
            new LocalExecutorCreateError({
              message: CREATE_SQLITE_ERROR_MESSAGE,
              cause,
            }),
        }),
        (database) => Effect.promise(() => database.close()).pipe(Effect.ignore),
      );
      const sqlite = owned.db;
      const migration = owned.migration;

      // Boot-time data migrations: each registry entry runs once and is
      // stamped in the `data_migration` ledger; stamped entries are skipped
      // without touching the data.
      yield* runSqliteDataMigrations(sqlite.client, localDataMigrations).pipe(
        Effect.mapError(
          (cause) =>
            new LocalExecutorCreateError({
              message: CREATE_SQLITE_ERROR_MESSAGE,
              cause,
            }),
        ),
      );

      // webBaseUrl is where the executor's web UI listens — same port as the
      // daemon API since the daemon serves both. Mirrors serve.ts's port
      // resolution so a custom $PORT flows through. EXECUTOR_WEB_BASE_URL
      // overrides entirely for deployments where the UI is on a different host.
      const webBaseUrl =
        process.env.EXECUTOR_WEB_BASE_URL ?? `http://localhost:${process.env.PORT ?? "4788"}`;

      // Only `plugins` varies between the boot executor and a scoped one: the
      // data dir, tenant, and subject are fixed for the process. `makeExecutor`
      // is that seam, and it closes over the open `sqlite.db` so deriving an
      // executor never re-opens (and so never re-locks) the data dir.
      //
      // `db` is the FumaDB handle, NOT the owning `sqlite` wrapper: an executor
      // built over a `{ db, close }` wrapper would close the SHARED database on
      // its own close(). Passing the handle keeps disposal to plugins alone.
      const makeExecutor = (executorPlugins: LocalPlugins) =>
        createExecutor({
          tenant: Tenant.make(tenantId),
          subject: Subject.make(LOCAL_SUBJECT),
          db: sqlite.db,
          plugins: executorPlugins,
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

      const executor = yield* makeExecutor(plugins);

      const createScopedExecutor = makeScopedExecutorFactory(makeExecutor);

      if (migration.migrated) {
        console.warn(
          `[executor] Migrated local Executor data to v2; moved old DB to ${migration.backupPath}.`,
        );
        for (const warning of migration.warnings) {
          console.warn(`[executor] local v2 migration: ${warning}`);
        }
      }

      // Heal stdio MCP integrations added before auto-connect existed (they
      // landed with zero connections ⇒ zero tools) and move any legacy inline
      // env into the secret store. No-op on a fresh install; never fails boot.
      // Local is the only app that enables stdio, so this only runs here.
      // oxlint-disable-next-line executor/no-double-cast -- typed boundary: the executor IS its own plugin-extension map (executor[pluginId]) but LocalExecutor doesn't surface per-plugin extensions statically
      const mcpExtension = (executor as unknown as { readonly mcp?: McpPluginExtension }).mcp;
      if (mcpExtension) {
        yield* mcpExtension
          .reconcileStdioConnections()
          .pipe(
            Effect.catch(() =>
              Effect.sync(() =>
                console.warn(
                  "[executor] stdio connection reconcile failed; existing stdio servers may show no tools until re-added",
                ),
              ),
            ),
          );
      }

      return { executor, plugins, createScopedExecutor };
    }),
  );
};

export const createExecutorHandle = async (options: LocalExecutorOptions = {}) => {
  const layer = createLocalExecutorLayer(options);
  const runtime = ManagedRuntime.make(layer);
  const bundle = await runtime.runPromise(LocalExecutorTag.asEffect());

  return {
    executor: bundle.executor,
    plugins: bundle.plugins,
    createScopedExecutor: bundle.createScopedExecutor,
    dispose: async () => {
      await Effect.runPromise(Effect.ignore(bundle.executor.close()));
      await ignorePromiseFailure("disposeRuntime", () => runtime.dispose());
    },
  };
};

class SharedHandleCreateError extends Data.TaggedError("SharedHandleCreateError")<{
  readonly cause: unknown;
}> {}

export type ExecutorHandle = Awaited<ReturnType<typeof createExecutorHandle>>;

let sharedHandlePromise: ReturnType<typeof createExecutorHandle> | null = null;
let sharedHandleLifecycle: Promise<void> = Promise.resolve();

const loadSharedHandle = (): Promise<ExecutorHandle> => {
  if (sharedHandlePromise) {
    return sharedHandlePromise;
  }

  // Capture the lifecycle tail at call time so creation stays ordered behind
  // in-flight dispose
  const lifecycle = sharedHandleLifecycle;

  // Identity token the heal closure compares against. Using a `let` declared
  // up front avoids any reference-before-init ambiguity in the closure.
  let slot: Promise<ExecutorHandle>;

  const acquire = Effect.tryPromise({
    try: () => lifecycle.then(() => createExecutorHandle()),
    catch: (cause) => new SharedHandleCreateError({ cause }),
  }).pipe(
    // Self-heal: a failed creation must not poison the memo. Clear the slot on
    // any non-success outcome so the next getExecutor() retries, but only if a
    // dispose/reload hasn't already swapped in a newer promise (identity guard).
    Effect.onError(() =>
      Effect.sync(() => {
        if (sharedHandlePromise === slot) {
          sharedHandlePromise = null;
        }
      }),
    ),
  );

  slot = Effect.runPromise(acquire);
  sharedHandlePromise = slot;
  return slot;
};

export const getExecutor = () => loadSharedHandle().then((handle) => handle.executor);
export const getExecutorBundle = () => loadSharedHandle();

export const disposeExecutor = async (): Promise<void> => {
  const currentHandlePromise = sharedHandlePromise;
  sharedHandlePromise = null;

  const disposeCurrent = async (): Promise<void> => {
    const handle = currentHandlePromise ? await handleOrNull(currentHandlePromise) : null;
    if (handle) {
      await ignorePromiseFailure("disposeExecutor", () => handle.dispose());
    }
  };

  const nextLifecycle = sharedHandleLifecycle.then(disposeCurrent, disposeCurrent);
  sharedHandleLifecycle = nextLifecycle.then(
    () => undefined,
    () => undefined,
  );
  await nextLifecycle;
};

export const reloadExecutor = async () => {
  await disposeExecutor();
  return getExecutor();
};
