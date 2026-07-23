import { describe, expect, it } from "@effect/vitest";
import type { D1Database } from "@cloudflare/workers-types";

import { collectTables, type SqliteDataMigrationClient } from "@executor-js/sdk";
import { createSqliteTestFumaDb } from "@executor-js/sdk/testing";

import { createD1ExecutorDb } from "./d1";

const makeRecordingD1 = (
  client: SqliteDataMigrationClient,
): {
  readonly db: D1Database;
  readonly statements: string[];
  readonly failWhen: (predicate: ((sql: string) => boolean) | null) => void;
} => {
  const statements: string[] = [];
  let failurePredicate: ((sql: string) => boolean) | null = null;
  const record = (sql: string): void => {
    statements.push(sql);
    if (failurePredicate?.(sql)) {
      // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- test boundary: the fake D1 adapter must reject exactly where the real D1 query would reject
      throw new Error("forced D1 failure");
    }
  };
  const prepare = (sql: string) => {
    const statement = (args: readonly unknown[]): Record<string, unknown> => ({
      bind: (...values: readonly unknown[]) => statement([...args, ...values]),
      all: async () => {
        record(sql);
        const result = await client.execute({ sql, args });
        return { success: true, meta: {}, results: result.rows };
      },
      run: async () => {
        record(sql);
        await client.execute({ sql, args });
        return { success: true, meta: {}, results: [] };
      },
    });
    return statement([]);
  };

  // oxlint-disable-next-line executor/no-double-cast -- test double: only the D1 methods used by schema preparation and migrations are implemented
  const db = {
    prepare,
    withSession: () => ({ prepare }),
  } as unknown as D1Database;
  return {
    db,
    statements,
    failWhen: (predicate) => {
      failurePredicate = predicate;
    },
  };
};

const isRuntimeSchemaStatement = (sql: string): boolean => {
  const normalized = sql.trim().toUpperCase();
  if (normalized.startsWith("CREATE UNIQUE INDEX IF NOT EXISTS")) return true;
  if (normalized.startsWith("ALTER TABLE") && normalized.includes(" ADD COLUMN ")) return true;
  if (!normalized.startsWith("CREATE TABLE IF NOT EXISTS")) return false;
  return !normalized.includes("DATA_MIGRATION");
};

describe("createD1ExecutorDb", () => {
  it("does not repeat runtime schema DDL after the current schema was prepared", async () => {
    const sqlite = await createSqliteTestFumaDb({ tables: collectTables() });
    const { db, statements } = makeRecordingD1(sqlite.client);

    const first = await createD1ExecutorDb(db, undefined);
    await first.close();
    const firstSchemaStatements = statements.filter(isRuntimeSchemaStatement);
    expect(firstSchemaStatements.length).toBeGreaterThan(0);

    const secondStart = statements.length;
    const second = await createD1ExecutorDb(db, undefined);
    await second.close();
    const secondStatements = statements.slice(secondStart);

    expect(secondStatements.filter(isRuntimeSchemaStatement)).toEqual([]);
    expect(secondStatements.some((sql) => sql.includes("SELECT name FROM data_migration"))).toBe(
      true,
    );

    await sqlite.close();
  });

  it("runs the schema ensure again when the generated fingerprint is stale", async () => {
    const sqlite = await createSqliteTestFumaDb({ tables: collectTables() });
    const { db, statements } = makeRecordingD1(sqlite.client);

    const first = await createD1ExecutorDb(db, undefined);
    await first.close();
    await sqlite.client.execute(
      `UPDATE private_executor_cloudflare_schema_fingerprint
       SET fingerprint = 'stale'
       WHERE id = 'runtime-schema'`,
    );

    const secondStart = statements.length;
    const second = await createD1ExecutorDb(db, undefined);
    await second.close();
    const secondStatements = statements.slice(secondStart);

    expect(
      secondStatements.some((sql) => sql.startsWith('CREATE TABLE IF NOT EXISTS "integration"')),
    ).toBe(true);

    await sqlite.close();
  });

  it("converges safely when concurrent opens see the same stale fingerprint", async () => {
    const sqlite = await createSqliteTestFumaDb({ tables: collectTables() });
    const { db } = makeRecordingD1(sqlite.client);
    const prepared = await createD1ExecutorDb(db, undefined);
    await prepared.close();
    await sqlite.client.execute(
      `UPDATE private_executor_cloudflare_schema_fingerprint
       SET fingerprint = 'stale'
       WHERE id = 'runtime-schema'`,
    );

    const handles = await Promise.all([
      createD1ExecutorDb(db, undefined),
      createD1ExecutorDb(db, undefined),
    ]);
    await Promise.all(handles.map((handle) => handle.close()));

    const fingerprints = await sqlite.client.execute(
      `SELECT fingerprint
       FROM private_executor_cloudflare_schema_fingerprint
       WHERE id = 'runtime-schema'`,
    );
    expect(fingerprints.rows).toHaveLength(1);
    expect(fingerprints.rows[0]?.fingerprint).not.toBe("stale");

    await sqlite.close();
  });

  it("stamps only after compatibility migrations leave the final schema current", async () => {
    const sqlite = await createSqliteTestFumaDb({ tables: collectTables() });
    await sqlite.client.execute("DROP TABLE connection");
    await sqlite.client.execute(`
      CREATE TABLE connection (
        integration text NOT NULL,
        name text NOT NULL,
        template text NOT NULL,
        provider text NOT NULL,
        item_id text NOT NULL,
        identity_label text,
        description text,
        tools_synced_at integer,
        oauth_client text,
        oauth_client_owner text,
        refresh_item_id text,
        expires_at integer,
        oauth_scope text,
        oauth_token_url text,
        provider_state text,
        created_at integer NOT NULL,
        updated_at integer NOT NULL,
        row_id text PRIMARY KEY NOT NULL,
        tenant text NOT NULL,
        owner text NOT NULL,
        subject text NOT NULL
      )
    `);
    const { db } = makeRecordingD1(sqlite.client);

    const handle = await createD1ExecutorDb(db, undefined);
    await handle.close();

    const columns = await sqlite.client.execute("PRAGMA table_info('connection')");
    const columnNames = columns.rows.map((row) => row.name);
    expect(columnNames).toContain("item_ids");
    expect(columnNames).toContain("last_health");
    expect(columnNames).not.toContain("item_id");
    const indexes = await sqlite.client.execute(
      `SELECT name FROM sqlite_master
       WHERE type = 'index'
         AND name = 'connection_uidx'`,
    );
    expect(indexes.rows).toEqual([{ name: "connection_uidx" }]);

    await sqlite.close();
  });

  it("does not stamp a fingerprint when schema preparation fails", async () => {
    const sqlite = await createSqliteTestFumaDb({ tables: collectTables() });
    const { db, failWhen } = makeRecordingD1(sqlite.client);
    failWhen((sql) => sql.startsWith('CREATE TABLE IF NOT EXISTS "integration"'));

    await expect(createD1ExecutorDb(db, undefined)).rejects.toBeDefined();

    const marker = await sqlite.client.execute(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name = 'private_executor_cloudflare_schema_fingerprint'`,
    );
    expect(marker.rows).toEqual([]);

    failWhen(null);
    const recovered = await createD1ExecutorDb(db, undefined);
    await recovered.close();

    await sqlite.close();
  });
});
