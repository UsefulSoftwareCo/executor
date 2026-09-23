/** Exercise journal transactions against real SQL, including failed deployment work. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Result, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { pgliteLayer } from "fumadb-effect/pglite";
import { HostedMigrationFailed, migrateProductSteps } from "@executor-js/hosted-server/migrations";

test("hosted and Cloud journals roll back together and retry each step only once", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`create table migration_fixture (owner text primary key)`;
        const hosted = migrateProductSteps("private_hosted_migrations", {
          "1_baseline": sql`insert into migration_fixture values ('hosted')`.pipe(Effect.asVoid),
        });
        const cloud = migrateProductSteps("private_cloud_migrations", {
          "1_baseline": sql`insert into migration_fixture values ('cloud')`.pipe(Effect.asVoid),
        });
        const failedCloud = migrateProductSteps("private_cloud_migrations", {
          "1_baseline": Effect.gen(function* () {
            yield* sql`insert into migration_fixture values ('cloud')`;
            yield* sql`insert into migration_fixture values ('cloud')`;
          }),
        });
        const failed = yield* Effect.result(
          sql.withTransaction(hosted.pipe(Effect.andThen(failedCloud))),
        );
        assert.ok(Result.isFailure(failed));
        assert.ok(Schema.is(HostedMigrationFailed)(failed.failure));
        assert.deepEqual(yield* sql`select * from migration_fixture`, []);
        assert.deepEqual(
          yield* sql`select tablename from pg_tables where tablename in ('private_hosted_migrations', 'private_cloud_migrations')`,
          [],
        );
        const migrate = sql.withTransaction(hosted.pipe(Effect.andThen(cloud)));
        yield* migrate;
        yield* migrate;
        assert.deepEqual(yield* sql`select owner from migration_fixture order by owner`, [
          { owner: "cloud" },
          { owner: "hosted" },
        ]);
        for (const journal of ["private_hosted_migrations", "private_cloud_migrations"])
          assert.deepEqual(yield* sql`select migration_id, name from ${sql(journal)}`, [
            { migration_id: 1, name: "baseline" },
          ]);
      }),
    ).pipe(Effect.provide(pgliteLayer())),
  ));
