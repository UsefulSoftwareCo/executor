/** Native workerd SQLite capability; used only by the generated data facet, never browser bundles. */
import * as Sqlite from "@effect/sql-sqlite-do/SqliteClient";
import { Effect, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { makeSqliteDatabase } from "@executor-js/app-data";
import type { AppStorage } from "./contracts/storage.ts";

/** Bind one facet's raw storage at the runtime edge. Each operation owns its native SQL scope. */
export const facetStorage = (
  storage: NonNullable<Sqlite.SqliteClientConfig["storage"]>,
): AppStorage => {
  const transactions = Semaphore.makeUnsafe(1);
  const run: (write: boolean) => AppStorage["read"] = (write) => (schema, work) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const database = yield* makeSqliteDatabase({ sql, schema, crypto });
      return yield* database[write ? "mutate" : "read"](work);
    }).pipe(Effect.provide(Sqlite.layer({ storage })), transactions.withPermits(1));
  return { read: run(false), mutate: run(true) };
};
