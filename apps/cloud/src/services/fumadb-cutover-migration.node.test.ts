import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

const scopedTables = [
  "connection",
  "credential_binding",
  "definition",
  "graphql_operation",
  "graphql_source",
  "graphql_source_header",
  "graphql_source_query_param",
  "mcp_binding",
  "mcp_source",
  "mcp_source_header",
  "mcp_source_query_param",
  "oauth2_session",
  "openapi_operation",
  "openapi_source",
  "openapi_source_header",
  "openapi_source_query_param",
  "openapi_source_spec_fetch_header",
  "openapi_source_spec_fetch_query_param",
  "secret",
  "source",
  "tool",
  "tool_policy",
  "workos_vault_metadata",
] as const;

const migrationPath = new URL("../../drizzle/0016_fumadb_cutover.sql", import.meta.url);

const statements = readFileSync(migrationPath, "utf8")
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0);

const quoteIdent = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const createLegacySchema = async (db: PGlite) => {
  await db.exec(`
    CREATE TABLE "blob" (
      "namespace" text NOT NULL,
      "key" text NOT NULL,
      "value" text NOT NULL,
      CONSTRAINT "blob_namespace_key_pk" PRIMARY KEY ("namespace", "key")
    );
    INSERT INTO "blob" ("namespace", "key", "value") VALUES ('scope/plugin', 'spec', '{}');
  `);

  for (const tableName of scopedTables) {
    await db.exec(`
      CREATE TABLE ${quoteIdent(tableName)} (
        "scope_id" text NOT NULL,
        "id" text NOT NULL,
        CONSTRAINT ${quoteIdent(`${tableName}_scope_id_id_pk`)} PRIMARY KEY ("scope_id", "id")
      );
      INSERT INTO ${quoteIdent(tableName)} ("scope_id", "id") VALUES ('scope-a', 'row-a');
    `);
  }
};

const applyCutoverMigration = async (db: PGlite) => {
  for (const statement of statements) {
    await db.exec(statement);
  }
};

describe("FumaDB cutover migration", () => {
  it.effect(
    "converts legacy primary keys to row_id primary keys while preserving scoped uniqueness",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => PGlite.create("memory://")),
        (db) =>
          Effect.promise(async () => {
            await createLegacySchema(db);
            await applyCutoverMigration(db);

            const blobRows = await db.query<{
              id: string;
              row_id: string;
            }>(`SELECT "id", "row_id" FROM "blob"`);
            expect(blobRows.rows).toEqual([
              {
                id: '["scope/plugin","spec"]',
                row_id: expect.stringMatching(/^legacy_/),
              },
            ]);

            const blobConstraints = await db.query<{ conname: string }>(
              `SELECT conname FROM pg_constraint WHERE conrelid = 'public.blob'::regclass ORDER BY conname`,
            );
            expect(blobConstraints.rows.map((row) => row.conname)).toContain("blob_pkey");
            expect(blobConstraints.rows.map((row) => row.conname)).not.toContain(
              "blob_namespace_key_pk",
            );

            for (const tableName of scopedTables) {
              const rows = await db.query<{ row_id: string }>(
                `SELECT "row_id" FROM ${quoteIdent(tableName)}`,
              );
              expect(rows.rows).toEqual([{ row_id: expect.stringMatching(/^legacy_/) }]);

              const constraints = await db.query<{ conname: string }>(
                `SELECT conname FROM pg_constraint WHERE conrelid = ${`'public.${tableName}'`}::regclass ORDER BY conname`,
              );
              expect(constraints.rows.map((row) => row.conname)).toContain(`${tableName}_pkey`);
              expect(constraints.rows.map((row) => row.conname)).not.toContain(
                `${tableName}_scope_id_id_pk`,
              );

              const indexes = await db.query<{ indexname: string }>(
                `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = '${tableName}' ORDER BY indexname`,
              );
              expect(indexes.rows.map((row) => row.indexname)).toContain(
                `${tableName}_scope_id_id_uidx`,
              );
            }
          }),
        (db) => Effect.promise(() => db.close()),
      ),
    15_000,
  );
});
