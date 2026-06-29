/* oxlint-disable executor/no-error-constructor, executor/no-try-catch-or-throw -- boundary: migration CLI runner uses thrown failures for process exit */

export interface CodeMigrationSql {
  unsafe<T extends readonly object[] = readonly Record<string, unknown>[]>(
    query: string,
    params?: readonly unknown[],
  ): Promise<T>;
}

export interface CodeMigrationContext {
  readonly sql: CodeMigrationSql;
  readonly dryRun: boolean;
  readonly log: (message: string) => void;
}

export interface CodeMigrationResult {
  readonly summary: string;
}

export interface CodeMigration {
  readonly name: string;
  readonly run: (context: CodeMigrationContext) => Promise<CodeMigrationResult>;
}

export interface RunCodeMigrationsOptions {
  readonly dryRun?: boolean;
  readonly log?: (message: string) => void;
}

const LEDGER_TABLE = "cloud_code_migration";
const ADVISORY_LOCK_KEY = "executor_cloud_code_migration";

const createLedgerSql = `
  CREATE TABLE IF NOT EXISTS "${LEDGER_TABLE}" (
    "name" text PRIMARY KEY,
    "time_completed" bigint NOT NULL
  )
`;

const readCompletedMigrations = async (
  sql: CodeMigrationSql,
  dryRun: boolean,
): Promise<Set<string>> => {
  if (dryRun) {
    const [table] = await sql.unsafe<{ ledger_table: string | null }[]>(
      `SELECT to_regclass('public.${LEDGER_TABLE}')::text AS "ledger_table"`,
    );
    if (!table?.ledger_table) return new Set();
  } else {
    await sql.unsafe(createLedgerSql);
  }

  const stamped = await sql.unsafe<{ name: string }[]>(
    `SELECT "name" FROM "${LEDGER_TABLE}" ORDER BY "name"`,
  );
  return new Set(stamped.map((row) => row.name));
};

const assertUniqueNames = (migrations: readonly CodeMigration[]): void => {
  const names = new Set<string>();
  for (const migration of migrations) {
    if (names.has(migration.name)) {
      throw new Error(`Duplicate code migration name: ${migration.name}`);
    }
    names.add(migration.name);
  }
};

const withMigrationLock = async <T>(
  sql: CodeMigrationSql,
  dryRun: boolean,
  body: () => Promise<T>,
): Promise<T> => {
  if (dryRun) return body();

  await sql.unsafe(`SELECT pg_advisory_lock(hashtext('${ADVISORY_LOCK_KEY}'))`);
  try {
    return await body();
  } finally {
    await sql.unsafe(`SELECT pg_advisory_unlock(hashtext('${ADVISORY_LOCK_KEY}'))`);
  }
};

export const runCodeMigrations = async (
  sql: CodeMigrationSql,
  migrations: readonly CodeMigration[],
  options: RunCodeMigrationsOptions = {},
): Promise<readonly string[]> => {
  const dryRun = options.dryRun ?? false;
  const log = options.log ?? console.log;
  assertUniqueNames(migrations);

  return withMigrationLock(sql, dryRun, async () => {
    const completed = await readCompletedMigrations(sql, dryRun);
    const applied: string[] = [];

    for (const migration of migrations) {
      if (completed.has(migration.name)) {
        log(`[code-migrate] skip ${migration.name}`);
        continue;
      }

      log(`[code-migrate] ${dryRun ? "plan" : "run"} ${migration.name}`);
      const result = await migration.run({ sql, dryRun, log });
      log(`[code-migrate] ${result.summary}`);

      if (!dryRun) {
        await sql.unsafe(
          `INSERT INTO "${LEDGER_TABLE}" ("name", "time_completed") VALUES ($1, $2)`,
          [migration.name, Date.now()],
        );
      }
      applied.push(migration.name);
    }

    return applied;
  });
};
