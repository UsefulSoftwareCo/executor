import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Evaluated declarations and tool listings a self-hosted server keeps across restarts. */
export const migrateEvaluatedDeclarations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table hosted_evaluated (
    app text not null,
    key text not null,
    at bigint not null,
    until bigint not null,
    json text not null,
    primary key (app, key)
  )`;
});
