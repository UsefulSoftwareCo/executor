import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { collectTables, type SqliteDataMigrationClient } from "@executor-js/sdk";
import { createSqliteTestFumaDb } from "@executor-js/sdk/testing";

import { runSqliteEncryptedSecretsRepartition } from "./repartition-migration";

// The real plugin_storage schema (unique on tenant/owner/subject/plugin_id/
// collection/key), so the insert-or-ignore + delete choreography is exercised
// against the production shape.
const makeDb = () => Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() }));

type Row = {
  readonly rowId: string;
  readonly owner: string;
  readonly subject: string;
  readonly key: string;
  readonly data?: string;
  readonly pluginId?: string;
  readonly collection?: string;
};

const insertRow = (client: SqliteDataMigrationClient, row: Row) =>
  Effect.promise(() =>
    client.execute({
      sql: `INSERT INTO plugin_storage
              (row_id, tenant, owner, subject, plugin_id, collection, key, data, created_at, updated_at)
            VALUES (?, 'tenant-a', ?, ?, ?, ?, ?, ?, 1, 1)`,
      args: [
        row.rowId,
        row.owner,
        row.subject,
        row.pluginId ?? "encryptedSecrets",
        row.collection ?? "secrets",
        row.key,
        JSON.stringify(row.data ?? "v1.iv.tag.ct"),
      ],
    }),
  );

const partitions = (client: SqliteDataMigrationClient) =>
  Effect.promise(() =>
    client.execute("SELECT owner, subject, key, data FROM plugin_storage ORDER BY key"),
  ).pipe(
    Effect.map((result) =>
      // `data` is a json column; compare its raw stored text.
      result.rows.map((row) => ({
        owner: row.owner,
        subject: row.subject,
        key: row.key,
        data: String(row.data),
      })),
    ),
  );

describe("runSqliteEncryptedSecretsRepartition", () => {
  it.effect("moves org-embedded rows out of a user partition, ciphertext intact", () =>
    Effect.gen(function* () {
      const db = yield* makeDb();
      yield* insertRow(db.client, {
        rowId: "r1",
        owner: "user",
        subject: "user-123",
        key: "oauth:org:linear:main",
      });
      yield* insertRow(db.client, {
        rowId: "r2",
        owner: "user",
        subject: "user-123",
        key: "oauth:org:linear:main:refresh",
      });
      const moved = yield* runSqliteEncryptedSecretsRepartition(db.client);
      expect(moved).toBe(2);
      expect(yield* partitions(db.client)).toEqual([
        { owner: "org", subject: "", key: "oauth:org:linear:main", data: '"v1.iv.tag.ct"' },
        { owner: "org", subject: "", key: "oauth:org:linear:main:refresh", data: '"v1.iv.tag.ct"' },
      ]);
    }),
  );

  it.effect("leaves correctly filed rows, user-embedded ids, and unscoped ids alone", () =>
    Effect.gen(function* () {
      const db = yield* makeDb();
      yield* insertRow(db.client, {
        rowId: "r1",
        owner: "org",
        subject: "",
        key: "oauth:org:linear:main",
      });
      yield* insertRow(db.client, {
        rowId: "r2",
        owner: "user",
        subject: "user-123",
        key: "connection:user:notion:p:token",
      });
      yield* insertRow(db.client, {
        rowId: "r3",
        owner: "user",
        subject: "user-123",
        key: "legacy-random-id",
      });
      const moved = yield* runSqliteEncryptedSecretsRepartition(db.client);
      expect(moved).toBe(0);
      expect((yield* partitions(db.client)).map((row) => `${row.owner}/${row.key}`)).toEqual([
        "user/connection:user:notion:p:token",
        "user/legacy-random-id",
        "org/oauth:org:linear:main",
      ]);
    }),
  );

  it.effect("a post-fix org row wins over the mis-filed duplicate", () =>
    Effect.gen(function* () {
      const db = yield* makeDb();
      yield* insertRow(db.client, {
        rowId: "old",
        owner: "user",
        subject: "user-123",
        key: "oauth:org:linear:main",
        data: "v1.old",
      });
      yield* insertRow(db.client, {
        rowId: "new",
        owner: "org",
        subject: "",
        key: "oauth:org:linear:main",
        data: "v1.new",
      });
      const moved = yield* runSqliteEncryptedSecretsRepartition(db.client);
      expect(moved).toBe(1);
      expect(yield* partitions(db.client)).toEqual([
        { owner: "org", subject: "", key: "oauth:org:linear:main", data: '"v1.new"' },
      ]);
    }),
  );

  it.effect("does not touch other plugins' rows", () =>
    Effect.gen(function* () {
      const db = yield* makeDb();
      yield* insertRow(db.client, {
        rowId: "r1",
        owner: "user",
        subject: "user-123",
        key: "oauth:org:slack:main",
        pluginId: "workosVault",
        collection: "metadata",
      });
      const moved = yield* runSqliteEncryptedSecretsRepartition(db.client);
      expect(moved).toBe(0);
      expect((yield* partitions(db.client))[0]).toMatchObject({
        owner: "user",
        subject: "user-123",
      });
    }),
  );

  it.effect("fails loudly on an unreadable row instead of skipping it", () =>
    Effect.gen(function* () {
      const db = yield* makeDb();
      yield* insertRow(db.client, {
        rowId: "r1",
        owner: "user",
        subject: "user-123",
        key: "oauth:org:linear:main",
      });
      const scripted: SqliteDataMigrationClient = {
        execute: (stmt) => {
          const sql = typeof stmt === "string" ? stmt : stmt.sql;
          if (sql.includes("SELECT row_id")) {
            return Promise.resolve({ rows: [{ row_id: null, owner: "user", key: null }] });
          }
          return db.client.execute(stmt as never) as never;
        },
      };
      const exit = yield* Effect.exit(runSqliteEncryptedSecretsRepartition(scripted));
      expect(Exit.isFailure(exit), "an unreadable row fails the migration").toBe(true);
    }),
  );

  it.effect("is a no-op on a database without the table", () =>
    Effect.gen(function* () {
      const empty: SqliteDataMigrationClient = {
        execute: (stmt) => {
          const sql = typeof stmt === "string" ? stmt : stmt.sql;
          if (sql.includes("sqlite_master")) return Promise.resolve({ rows: [] });
          // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: scripted fake for a promise-shaped client interface
          return Promise.reject(new Error(`unexpected statement: ${sql}`));
        },
      };
      const moved = yield* runSqliteEncryptedSecretsRepartition(empty);
      expect(moved).toBe(0);
    }),
  );

  it.effect("is idempotent", () =>
    Effect.gen(function* () {
      const db = yield* makeDb();
      yield* insertRow(db.client, {
        rowId: "r1",
        owner: "user",
        subject: "user-123",
        key: "oauth:org:linear:main",
      });
      expect(yield* runSqliteEncryptedSecretsRepartition(db.client)).toBe(1);
      expect(yield* runSqliteEncryptedSecretsRepartition(db.client)).toBe(0);
    }),
  );
});
