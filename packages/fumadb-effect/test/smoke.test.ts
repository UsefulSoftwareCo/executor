import { it } from "@effect/vitest";
import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { SqlClient } from "effect/unstable/sql";
import { expect } from "vitest";

it.layer(SqliteClient.layer({ filename: ":memory:" }))("smoke", (it) => {
  it.effect("runs a query under node:sqlite", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ one: number }>`select 1 as one`;
      expect(rows[0]?.one).toBe(1);
    }),
  );
});
