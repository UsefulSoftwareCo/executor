/** Real adapter queries: object account selections and source-free array counts. */
import { it } from "@effect/vitest";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import { fumadb } from "../src/index.ts";
import { QueryError } from "../src/contracts/errors.ts";
import { sqlAdapter } from "../src/sql.ts";
import { pgliteLayer } from "../src/pglite.ts";
import { column, idColumn, schema, table } from "../src/schema.ts";

const model = schema({
  version: "1.0.0",
  tables: {
    rows: table("json_query_rows", {
      id: idColumn("id", Schema.String),
      accounts: column("accounts", Schema.Json),
      files: column("files", Schema.Json),
    }),
  },
  relations: { rows: ({ one }) => ({ related: one("rows", ["id", "id"]).foreignKey() }) },
});
const fixture = fumadb({ namespace: "json_query", schemas: [model] });

for (const { provider, layer } of [
  { provider: "sqlite", layer: SqliteClient.layer({ filename: ":memory:" }) },
  { provider: "postgresql", layer: pgliteLayer() },
] as const) {
  it.effect(`${provider}: exact JSON selections and metadata projections`, () =>
    Effect.gen(function* () {
      const client = fixture.client(sqlAdapter({ provider }));
      yield* (yield* client.createMigrator)
        .migrateToLatest()
        .pipe(Effect.flatMap((plan) => plan.execute));
      const db = client.orm("1.0.0");
      yield* db.createMany("rows", [
        { id: "scalar", accounts: { service: "acc_example" }, files: [{ path: "a" }] },
        { id: "array", accounts: { service: ["acc_example", "other"] }, files: [1, 2] },
        { id: "nested-array", accounts: { service: [["acc_example"]] }, files: {} },
        { id: "nested-object", accounts: { service: { nested: "acc_example" } }, files: false },
        { id: "unrelated", accounts: { service: "acc_other" }, files: [] },
        { id: "empty", accounts: { service: [] }, files: "wrong" },
      ]);
      const matched = yield* db.findMany("rows", {
        where: (b) => b("accounts", "json contains", "acc_example"),
        orderBy: ["id", "asc"],
      });
      expect(matched.map((row) => row.id)).toEqual(["array", "scalar"]);
      const counts = yield* db.findMany("rows", {
        select: ["id"],
        computed: [{ kind: "jsonArrayLength", column: "files", alias: "fileCount" }],
        orderBy: ["id", "asc"],
      });
      expect(counts).toEqual([
        { id: "array", fileCount: 2 },
        { id: "empty", fileCount: null },
        { id: "nested-array", fileCount: null },
        { id: "nested-object", fileCount: null },
        { id: "scalar", fileCount: 1 },
        { id: "unrelated", fileCount: 0 },
      ]);
      const first = yield* db.findFirst("rows", {
        select: [],
        where: (b) => b("id", "=", "array"),
        computed: [
          { kind: "jsonArrayLength", column: "files", alias: "first" },
          { kind: "jsonArrayLength", column: "files", alias: "second" },
        ],
      });
      expect(first).toEqual({ first: 2, second: 2 });
      for (const alias of ["", "id", "related", "related:count"]) {
        const failure = yield* db
          .findMany("rows", {
            computed: [{ kind: "jsonArrayLength", column: "files", alias }],
          })
          .pipe(Effect.flip);
        expect(Schema.is(QueryError)(failure)).toBe(true);
        expect(failure).toMatchObject({ reason: "InvalidInput" });
      }
      const duplicate = yield* db
        .findMany("rows", {
          computed: [
            { kind: "jsonArrayLength", column: "files", alias: "count" },
            { kind: "jsonArrayLength", column: "files", alias: "count" },
          ],
        })
        .pipe(Effect.flip);
      expect(duplicate).toMatchObject({ reason: "InvalidInput" });
      const wrongColumn = yield* db
        .findMany("rows", { computed: [{ kind: "jsonArrayLength", column: "id", alias: "count" }] })
        .pipe(Effect.flip);
      expect(wrongColumn).toMatchObject({ reason: "InvalidInput" });
      const joined = yield* db
        .findMany("rows", {
          join: (b) =>
            b.related({
              // @ts-expect-error JavaScript callers must receive the same root-only restriction.
              computed: [{ kind: "jsonArrayLength", column: "files", alias: "count" }],
            }),
        })
        .pipe(Effect.flip);
      expect(joined).toMatchObject({ reason: "InvalidInput" });
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
}
