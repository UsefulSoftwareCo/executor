// Regression: every cloud drizzle instance must be constructed with the
// merge of cloud + executor schemas. If ANY call site builds its own
// `{ schema }` without spreading both, `db._.fullSchema` comes back
// missing tables and the drizzle adapter throws
// `unknown model "source"` at the first request that touches scoped data.
//
// We hit this in prod (MCP endpoint) when `mcp-session.ts` built
// `combinedSchema = { ...cloudSchema }` and forgot to spread the executor
// schema — web-app requests worked because they went through
// `DbService.Live`, but the MCP Durable Object constructed its own.
//
// This test asserts the only sanctioned constant (`combinedSchema` from
// `./db`) actually contains every executor-schema export AND that drizzle
// surfaces them all under `db._.fullSchema`.

import { describe, expect, it } from "@effect/vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { Effect } from "effect";
import postgres from "postgres";

import { collectTables } from "@executor-js/sdk";

import executorConfig from "../../executor.config";
import * as cloudSchema from "./schema";
import * as executorSchema from "./executor-schema";
import { combinedSchema } from "./db";
import { createDrizzleFumaDb } from "./fuma";

interface GeneratedFumaTable {
  readonly names: {
    readonly drizzle: string;
  };
  readonly columns: Record<
    string,
    {
      readonly ormName: string;
      readonly names: {
        readonly drizzle: string;
      };
    }
  >;
}

const fumaDbInternals = (
  value: unknown,
): { internal: { tables: Record<string, GeneratedFumaTable> } } =>
  value as { internal: { tables: Record<string, GeneratedFumaTable> } };

const drizzleTableColumns = (value: unknown): Record<string, unknown> =>
  value as Record<string, unknown>;

describe("combinedSchema", () => {
  it("spreads every cloud + executor schema export", () => {
    const expected = new Set([...Object.keys(cloudSchema), ...Object.keys(executorSchema)]);
    for (const key of expected) {
      expect(combinedSchema, `combinedSchema missing "${key}"`).toHaveProperty(key);
    }
  });

  // Executor-schema drives the scope-sharded tables (source/tool/etc). If
  // any of these go missing the drizzle adapter's `getTable` lookup throws.
  it("includes scope-sharded executor tables", () => {
    for (const key of Object.keys(executorSchema)) {
      expect(combinedSchema, `combinedSchema missing "${key}"`).toHaveProperty(key);
    }
  });

  // The prod bug was actually at the drizzle layer: spread + __exportAll
  // getters could theoretically drop tables if evaluated before their
  // declarations. Construct a drizzle instance and walk its fullSchema
  // to catch that class of bug too.
  it.effect("drizzle(combinedSchema) exposes every table under _.fullSchema", () =>
    // postgres() lazily connects — safe to build with a dummy url, we
    // never .query() so no socket is opened.
    Effect.acquireRelease(
      Effect.sync(() => postgres("postgres://u:p@127.0.0.1:1/x", { max: 1 })),
      (sql) => Effect.promise(() => sql.end({ timeout: 0 })),
    ).pipe(
      Effect.flatMap((sql) =>
        Effect.sync(() => {
          const db = drizzle(sql, { schema: combinedSchema });
          const drizzleInternals = (
            value: unknown,
          ): { _: { fullSchema: Record<string, unknown> } } =>
            value as { _: { fullSchema: Record<string, unknown> } };
          const fullSchema = drizzleInternals(db)._.fullSchema;
          for (const key of Object.keys(executorSchema)) {
            expect(fullSchema, `fullSchema missing "${key}"`).toHaveProperty(key);
          }
        }),
      ),
    ),
  );

  it.effect("generated drizzle tables expose every executor Fuma column", () =>
    Effect.acquireRelease(
      Effect.sync(() => postgres("postgres://u:p@127.0.0.1:1/x", { max: 1 })),
      (sql) => Effect.promise(() => sql.end({ timeout: 0 })),
    ).pipe(
      Effect.flatMap((sql) =>
        Effect.sync(() => {
          const db = drizzle(sql, { schema: combinedSchema });
          const fuma = createDrizzleFumaDb({
            db,
            tables: collectTables(executorConfig.plugins({})),
            namespace: "executor_cloud",
            provider: "postgresql",
          });
          const schemaTables = drizzleTableColumns(combinedSchema);
          const missingColumns: string[] = [];

          for (const table of Object.values(fumaDbInternals(fuma.db).internal.tables)) {
            const drizzleTable = drizzleTableColumns(schemaTables[table.names.drizzle]);
            for (const column of Object.values(table.columns)) {
              if (drizzleTable[column.names.drizzle] === undefined) {
                missingColumns.push(
                  `${table.names.drizzle}.${column.ormName} -> ${column.names.drizzle}`,
                );
              }
            }
          }

          expect(missingColumns).toEqual([]);
        }),
      ),
    ),
  );
});
