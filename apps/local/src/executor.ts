import { Context, Data, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  Scope,
  ScopeId,
  createExecutor,
  type AnyPlugin,
  type Executor,
  type FumaTables,
} from "@executor-js/sdk";
import { collectTables } from "@executor-js/api/server";
import { withQueryContext } from "fumadb/query";
import { loadPluginsFromJsonc } from "@executor-js/config";

import executorConfig from "../executor.config";
import embeddedMigrations from "./db/embedded-migrations.gen";
import {
  importLegacySecrets,
  moveAsidePreScopeDb,
  readLegacySecrets,
  type LegacySecret,
} from "./db/db-upgrade";
import * as legacyExecutorSchema from "./db/executor-schema";
import {
  importSqliteDataToFuma,
  readLegacySqliteScopeIds,
  type LocalSqliteImportResult,
} from "./db/sqlite-import";
import { createSqliteFumaDb } from "./db/sqlite-fumadb";
import { openLegacyLibsql, queryFirst, queryRows } from "./db/libsql";
import { oneShotMigrateGoogleDiscoveryToOpenApi } from "./db/google-discovery-openapi-migration";

interface ResolvedStorage {
  readonly dataDir: string;
  readonly sqlitePath: string;
  readonly importMarkerPath: string;
}

const localNamespace = "executor_local";

// In dev mode the drizzle folder sits next to the source tree. In a compiled
// binary the files are inlined by apps/cli/src/build.ts and extracted to a
// temp folder because drizzle's migrator accepts a folder path.
const resolveMigrationsFolder = (): string => {
  if (!embeddedMigrations) {
    return join(import.meta.dirname, "../drizzle");
  }

  const dir = fs.mkdtempSync(join(tmpdir(), "executor-migrations-"));
  for (const [rel, content] of Object.entries(embeddedMigrations)) {
    const target = join(dir, rel);
    fs.mkdirSync(dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
};

const MIGRATIONS_FOLDER = resolveMigrationsFolder();

const resolveStorage = (): ResolvedStorage => {
  const dataDir = process.env.EXECUTOR_DATA_DIR ?? join(homedir(), ".executor");
  fs.mkdirSync(dataDir, { recursive: true });
  return {
    dataDir,
    sqlitePath: join(dataDir, "data.db"),
    importMarkerPath: join(dataDir, "fumadb-sqlite-imported"),
  };
};

// Hash suffix disambiguates same-basename folders so two projects with
// identical directory names cannot collide on the same scope id.
const makeScopeId = (cwd: string): string => {
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
  readonly operation: "createSqlite" | "importSqlite";
  readonly message: string;
  readonly cause: unknown;
}> {}

class LocalExecutorDisposeError extends Data.TaggedError("LocalExecutorDisposeError")<{
  readonly operation: "createHandle" | "disposeExecutor" | "disposeRuntime";
  readonly cause: unknown;
}> {}

class LocalSqliteCheckpointError extends Data.TaggedError("LocalSqliteCheckpointError")<{
  readonly path: string;
  readonly busy: number;
}> {}

const localExecutorCreateError = (
  operation: LocalExecutorCreateError["operation"],
  cause: unknown,
) =>
  new LocalExecutorCreateError({
    operation,
    cause,
    message:
      operation === "importSqlite"
        ? "Failed to prepare local SQLite data. Close other Executor processes and retry, or run with --log-level debug for details."
        : "Failed to open local SQLite data. Close other Executor processes and retry, or run with --log-level debug for details.",
  });

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

const sqliteTableHasColumn = async (
  client: Client,
  table: string,
  column: string,
): Promise<boolean> => {
  const rows = await queryRows<{ name: string }>(
    client,
    `PRAGMA table_info('${table.replaceAll("'", "''")}')`,
  );
  return rows.some((row) => row.name === column);
};

export const drizzleMigrationsTableExists = async (client: Client): Promise<boolean> => {
  const row = await queryFirst(
    client,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    ["__drizzle_migrations"],
  );

  return row != null;
};

export const readAppliedDrizzleMigrationHashes = async (
  client: Client,
): Promise<ReadonlyArray<string>> => {
  if (!(await drizzleMigrationsTableExists(client))) return [];

  return (
    await queryRows<{ hash: string }>(
      client,
      "SELECT hash FROM __drizzle_migrations ORDER BY id ASC",
    )
  ).map((row) => row.hash);
};

const DrizzleJournal = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      idx: Schema.Number,
      tag: Schema.String,
    }),
  ),
});

const decodeDrizzleJournal = Schema.decodeUnknownSync(Schema.fromJsonString(DrizzleJournal));

export const readBundledDrizzleMigrationHashes = (
  migrationsFolder: string,
): ReadonlyArray<string> => {
  const journal = decodeDrizzleJournal(
    fs.readFileSync(join(migrationsFolder, "meta", "_journal.json")).toString(),
  );

  return [...journal.entries]
    .sort((left, right) => left.idx - right.idx)
    .map((entry) => {
      const query = fs.readFileSync(join(migrationsFolder, `${entry.tag}.sql`)).toString();
      return createHash("sha256").update(query).digest("hex");
    });
};

const hasBundledDrizzleMigrationPrefix = async (input: {
  readonly client: Client;
  readonly migrationsFolder: string;
}): Promise<boolean> => {
  if (!(await drizzleMigrationsTableExists(input.client))) return true;

  const applied = await readAppliedDrizzleMigrationHashes(input.client);
  const bundled = readBundledDrizzleMigrationHashes(input.migrationsFolder);
  return (
    applied.length <= bundled.length && applied.every((hash, index) => hash === bundled[index])
  );
};

const isFumaSqliteDatabase = async (path: string): Promise<boolean> => {
  if (!fs.existsSync(path)) return false;

  let client: Client | null = null;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: native SQLite probe treats unreadable legacy files as non-FumaDB databases
  try {
    client = openLegacyLibsql(path);
    const settings = await queryFirst(
      client,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [`private_${localNamespace}_settings`],
    );
    return settings != null || (await sqliteTableHasColumn(client, "source", "row_id"));
  } catch {
    return false;
  } finally {
    client?.close();
  }
};

const removeSqliteFileSet = (path: string) => {
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${path}${suffix}`, { force: true });
  }
};

const removeSqliteSidecars = (path: string) => {
  for (const suffix of ["-wal", "-shm"]) {
    fs.rmSync(`${path}${suffix}`, { force: true });
  }
};

const moveSqliteFileSet = (source: string, target: string) => {
  fs.renameSync(source, target);
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(`${source}${suffix}`)) {
      fs.renameSync(`${source}${suffix}`, `${target}${suffix}`);
    }
  }
};

const moveSqliteFileSetToBackup = (path: string): string => {
  const backupPath = `${path}.imported-${Date.now()}-${randomBytes(4).toString("hex")}`;
  moveSqliteFileSet(path, backupPath);
  return backupPath;
};

const checkpointSqliteForFileMove = async (input: {
  readonly client: Client;
  readonly path: string;
}): Promise<void> => {
  const checkpoint = await queryFirst<{ busy: number; log: number; checkpointed: number }>(
    input.client,
    "PRAGMA wal_checkpoint(TRUNCATE)",
  );

  if (checkpoint && checkpoint.busy !== 0) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: callers wrap this checkpoint-busy failure into LocalExecutorCreateError before a file move
    throw new LocalSqliteCheckpointError({ path: input.path, busy: checkpoint.busy });
  }

  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: DELETE mode is best-effort after a successful checkpoint; an open read handle can reject the mode switch without making the file set unsafe to move
  try {
    await input.client.execute("PRAGMA journal_mode = DELETE");
  } catch (cause) {
    console.warn(
      `[executor] Checkpointed SQLite WAL for ${input.path}, but could not switch journal mode to DELETE before import. Continuing with the checkpointed file set.`,
      cause,
    );
  }
};

const writeSqliteImportMarker = (
  markerPath: string,
  input: {
    readonly importedRows: number;
    readonly importedTables: readonly string[];
    readonly backupPath?: string;
    readonly recovered?: boolean;
  },
) => {
  fs.mkdirSync(dirname(markerPath), { recursive: true });
  fs.writeFileSync(
    markerPath,
    `${JSON.stringify({
      importedAt: new Date().toISOString(),
      importedRows: input.importedRows,
      importedTables: input.importedTables,
      backupPath: input.backupPath,
      recovered: input.recovered === true ? true : undefined,
    })}\n`,
    { flag: "w" },
  );
};

const SqliteImportMarkerSchema = Schema.Struct({
  importedTables: Schema.optional(Schema.Array(Schema.String)),
  importedRows: Schema.optional(Schema.Number),
  backupPath: Schema.optional(Schema.String),
  recovered: Schema.optional(Schema.Boolean),
});

const decodeSqliteImportMarker = Schema.decodeUnknownSync(
  Schema.fromJsonString(SqliteImportMarkerSchema),
);

const normalizeSqliteImportMarker = (decoded: typeof SqliteImportMarkerSchema.Type) => ({
  importedRows: decoded.importedRows ?? 0,
  importedTables: decoded.importedTables ?? [],
  backupPath: decoded.backupPath,
  recovered: decoded.recovered,
});

type SqliteImportMarker = ReturnType<typeof normalizeSqliteImportMarker>;

const readSqliteImportMarker = (markerPath: string): SqliteImportMarker | null => {
  if (!fs.existsSync(markerPath)) return null;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: malformed import markers are treated as incomplete so startup can re-check the database
  try {
    return normalizeSqliteImportMarker(
      decodeSqliteImportMarker(fs.readFileSync(markerPath).toString()),
    );
  } catch {
    return null;
  }
};

const pickFumaTables = (tables: FumaTables, names: ReadonlySet<string>): FumaTables => {
  const picked: FumaTables = {};
  for (const [name, table] of Object.entries(tables)) {
    if (names.has(name)) picked[name] = table;
  }
  return picked;
};

const replaceSqliteFileSetWithRollback = (input: {
  readonly sourcePath: string;
  readonly targetPath: string;
}): string => {
  const backupPath = moveSqliteFileSetToBackup(input.sourcePath);
  removeSqliteSidecars(backupPath);
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: local DB replacement must restore the original file set if the swap fails halfway
  try {
    moveSqliteFileSet(input.targetPath, input.sourcePath);
    return backupPath;
  } catch (cause) {
    removeSqliteFileSet(input.sourcePath);
    if (fs.existsSync(backupPath)) {
      moveSqliteFileSet(backupPath, input.sourcePath);
    }
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: preserve the original replacement failure after rollback
    throw cause;
  }
};

const createLegacySecretRows = (scopeId: string, secrets: readonly LegacySecret[]) =>
  secrets.map((secret) => ({
    id: secret.id,
    scope_id: scopeId,
    name: secret.name,
    provider: secret.provider,
    owned_by_connection_id: null,
    created_at: new Date(secret.createdAt),
  }));

interface PreparedLegacySqlite {
  readonly legacySecrets: readonly LegacySecret[];
  readonly preScopeBackup?: string;
}

const prepareLegacySqliteForFumaImport = async (input: {
  readonly storage: ResolvedStorage;
  readonly scopeId: string;
}): Promise<PreparedLegacySqlite> => {
  if (
    !fs.existsSync(input.storage.sqlitePath) ||
    (await isFumaSqliteDatabase(input.storage.sqlitePath))
  ) {
    return { legacySecrets: [] };
  }

  const legacySecrets = await readLegacySecrets(input.storage.sqlitePath);
  const preScopeBackup = await moveAsidePreScopeDb(input.storage.sqlitePath);
  if (preScopeBackup) {
    console.warn(
      `[executor] Pre-scope database detected; moved to ${preScopeBackup}. ` +
        `Sources and tool catalogs will need to be re-added` +
        (legacySecrets.length > 0
          ? ` (${legacySecrets.length} secret routing row(s) preserved).`
          : "."),
    );
    return { legacySecrets, preScopeBackup };
  }

  const client = openLegacyLibsql(input.storage.sqlitePath);
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: legacy migration preflight must close SQLite before the FumaDB import re-opens the file
  try {
    if (await hasBundledDrizzleMigrationPrefix({ client, migrationsFolder: MIGRATIONS_FOLDER })) {
      await client.execute("PRAGMA journal_mode = WAL");
      await migrate(drizzle({ client, schema: legacyExecutorSchema }), {
        migrationsFolder: MIGRATIONS_FOLDER,
      });
      await importLegacySecrets(client, input.scopeId, legacySecrets);
    } else {
      console.warn(
        `[executor] Local SQLite migration history in ${input.storage.dataDir} ` +
          `does not match this build's bundled legacy migrations. ` +
          `Skipping legacy Drizzle replay and importing the existing schema as-is.`,
      );
    }
    await checkpointSqliteForFileMove({ client, path: input.storage.sqlitePath });
    return { legacySecrets: [] };
  } finally {
    client.close();
  }
};

const importMissingMarkedTables = async (input: {
  readonly storage: ResolvedStorage;
  readonly marker: SqliteImportMarker;
  readonly tables: FumaTables;
  readonly scopeId: string;
}): Promise<LocalSqliteImportResult> => {
  const alreadyImported = new Set(input.marker.importedTables);
  const missingTables = Object.keys(input.tables).filter((table) => !alreadyImported.has(table));
  if (
    !input.marker.backupPath ||
    missingTables.length === 0 ||
    !fs.existsSync(input.marker.backupPath)
  ) {
    return { imported: false, importedRows: 0, importedTables: [] };
  }

  const missingTableSet = new Set(missingTables);
  const target = await createSqliteFumaDb({
    tables: input.tables,
    namespace: localNamespace,
    path: input.storage.sqlitePath,
  });

  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: late plugin-table imports must close the active SQLite handle on failure
  try {
    const pickedTables = pickFumaTables(input.tables, missingTableSet);
    const legacyScopeIds = await readLegacySqliteScopeIds({
      sqlitePath: input.marker.backupPath,
      tables: pickedTables,
      scopeId: input.scopeId,
    });
    const result = await importSqliteDataToFuma({
      sqlitePath: input.marker.backupPath,
      target: withQueryContext(target.db, {
        allowedScopeIds: legacyScopeIds,
      }),
      tables: pickedTables,
      scopeId: input.scopeId,
    });
    await checkpointSqliteForFileMove({ client: target.client, path: input.storage.sqlitePath });
    await target.close();
    removeSqliteSidecars(input.storage.sqlitePath);

    const importedTables = [...new Set([...input.marker.importedTables, ...missingTables])];
    writeSqliteImportMarker(input.storage.importMarkerPath, {
      importedRows: input.marker.importedRows + result.importedRows,
      importedTables,
      backupPath: input.marker.backupPath,
      recovered: input.marker.recovered,
    });

    return result.importedRows > 0 || result.importedTables.length > 0
      ? result
      : { imported: false, importedRows: 0, importedTables: [] };
  } catch (cause) {
    await target.close();
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: preserve late plugin-table import failure after closing SQLite
    throw cause;
  }
};

export const importLegacySqliteIfNeeded = async (options: {
  readonly storage: ResolvedStorage;
  readonly tables: ReturnType<typeof collectTables>;
  readonly scopeId: string;
}) => {
  const { storage, tables, scopeId } = options;
  const targetPath = `${storage.sqlitePath}.fumadb-next`;
  const marker = readSqliteImportMarker(storage.importMarkerPath);

  if (marker) {
    return importMissingMarkedTables({
      storage,
      marker,
      tables,
      scopeId,
    });
  }
  if (fs.existsSync(storage.importMarkerPath)) {
    fs.rmSync(storage.importMarkerPath, { force: true });
  }

  if (!fs.existsSync(storage.importMarkerPath) && fs.existsSync(storage.sqlitePath)) {
    if (await isFumaSqliteDatabase(storage.sqlitePath)) {
      writeSqliteImportMarker(storage.importMarkerPath, {
        importedRows: 0,
        importedTables: [],
        recovered: true,
      });
    } else {
      const prepared = await prepareLegacySqliteForFumaImport({ storage, scopeId });
      if (prepared.preScopeBackup) {
        if (prepared.legacySecrets.length > 0) {
          const target = await createSqliteFumaDb({
            tables,
            namespace: localNamespace,
            path: storage.sqlitePath,
          });
          // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: pre-scope secret import must close the fresh FumaDB handle on failure
          try {
            await withQueryContext(target.db, {
              allowedScopeIds: new Set([scopeId]),
            }).createMany("secret", createLegacySecretRows(scopeId, prepared.legacySecrets));
            await checkpointSqliteForFileMove({ client: target.client, path: storage.sqlitePath });
          } finally {
            await target.close();
            removeSqliteSidecars(storage.sqlitePath);
          }
        }
        writeSqliteImportMarker(storage.importMarkerPath, {
          importedRows: prepared.legacySecrets.length,
          importedTables: prepared.legacySecrets.length > 0 ? ["secret"] : [],
          backupPath: prepared.preScopeBackup,
        });
        return {
          imported: prepared.legacySecrets.length > 0,
          importedRows: prepared.legacySecrets.length,
          importedTables: prepared.legacySecrets.length > 0 ? ["secret"] : [],
          backupPath: prepared.preScopeBackup,
        };
      }
    }
  }

  if (
    !fs.existsSync(storage.importMarkerPath) &&
    !fs.existsSync(storage.sqlitePath) &&
    fs.existsSync(targetPath) &&
    (await isFumaSqliteDatabase(targetPath))
  ) {
    moveSqliteFileSet(targetPath, storage.sqlitePath);
    writeSqliteImportMarker(storage.importMarkerPath, {
      importedRows: 0,
      importedTables: [],
      recovered: true,
    });
  }

  if (
    !fs.existsSync(storage.sqlitePath) ||
    fs.existsSync(storage.importMarkerPath) ||
    (await isFumaSqliteDatabase(storage.sqlitePath))
  ) {
    return { imported: false, importedRows: 0, importedTables: [] };
  }

  removeSqliteFileSet(targetPath);

  const target = await createSqliteFumaDb({
    tables,
    namespace: localNamespace,
    path: targetPath,
  });

  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: local SQLite cutover must close and remove the temporary target database on import failure
  try {
    const legacyScopeIds = await readLegacySqliteScopeIds({
      sqlitePath: storage.sqlitePath,
      tables,
      scopeId,
    });
    const result = await importSqliteDataToFuma({
      sqlitePath: storage.sqlitePath,
      target: withQueryContext(target.db, {
        allowedScopeIds: legacyScopeIds,
      }),
      tables,
      scopeId,
    });
    await checkpointSqliteForFileMove({ client: target.client, path: targetPath });
    await target.close();
    removeSqliteSidecars(targetPath);

    if (result.imported) {
      const backupPath = replaceSqliteFileSetWithRollback({
        sourcePath: storage.sqlitePath,
        targetPath,
      });
      writeSqliteImportMarker(storage.importMarkerPath, {
        importedRows: result.importedRows,
        importedTables: result.importedTables,
        backupPath,
      });
      return { ...result, backupPath };
    } else {
      removeSqliteFileSet(targetPath);
    }
    return result;
  } catch (cause) {
    await target.close();
    removeSqliteFileSet(targetPath);
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: preserve the original import failure after temp-file cleanup
    throw cause;
  }
};

const createLocalExecutorLayer = () => {
  const storage = resolveStorage();

  return Layer.effect(LocalExecutorTag)(
    Effect.gen(function* () {
      const { cwd, plugins } = yield* loadLocalPlugins;
      const scopeId = makeScopeId(cwd);
      const tables = collectTables();

      const importResult = yield* Effect.tryPromise({
        try: () =>
          importLegacySqliteIfNeeded({
            storage,
            tables,
            scopeId,
          }),
        catch: (cause) => localExecutorCreateError("importSqlite", cause),
      });

      const sqlite = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            createSqliteFumaDb({
              tables,
              namespace: localNamespace,
              path: storage.sqlitePath,
            }),
          catch: (cause) => localExecutorCreateError("createSqlite", cause),
        }),
        (db) => Effect.promise(() => db.close()).pipe(Effect.ignore),
      );

      const migratedGoogleDiscoverySources = yield* Effect.promise(() =>
        oneShotMigrateGoogleDiscoveryToOpenApi(sqlite.client),
      );

      if (importResult.imported) {
        console.warn(
          `[executor] Imported ${importResult.importedRows} row(s) into FumaDB SQLite storage` +
            (importResult.backupPath ? `; moved old DB to ${importResult.backupPath}.` : "."),
        );
      }
      if (migratedGoogleDiscoverySources > 0) {
        console.warn(
          `[executor] Migrated ${migratedGoogleDiscoverySources} Google Discovery source(s) to OpenAPI storage.`,
        );
      }

      const scope = Scope.make({
        id: ScopeId.make(scopeId),
        name: cwd,
        createdAt: new Date(),
      });

      const executor = yield* createExecutor({
        scopes: [scope],
        db: sqlite.db,
        plugins,
        onElicitation: "accept-all",
        oauthEndpointUrlPolicy: { allowHttp: true },
        // Built-in agent-facing tools (scopes.list, secrets.list,
        // secrets.create). webBaseUrl is where the executor's web UI
        // listens — same port as the daemon API since the daemon serves
        // both. Mirrors serve.ts's port resolution so a custom $PORT
        // flows through. EXECUTOR_WEB_BASE_URL overrides entirely for
        // deployments where the UI is on a different host.
        coreTools: {
          webBaseUrl:
            process.env.EXECUTOR_WEB_BASE_URL ?? `http://localhost:${process.env.PORT ?? "4788"}`,
        },
      });

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
