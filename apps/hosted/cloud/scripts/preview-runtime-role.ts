/** Give preview Workers data access without branch administration or schema ownership. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Config, Effect, Redacted, Schema } from "effect";
import { Client } from "pg";

class RoleFailed extends Schema.TaggedError<RoleFailed>()("RoleFailed", {
  message: Schema.String,
}) {}
NodeRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const url = yield* Config.Redacted("DATABASE_URL");
      const password = yield* Config.Redacted("RUNTIME_PASSWORD");
      const client = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new Client({ connectionString: Redacted.value(url), connectionTimeoutMillis: 15000 }),
        ),
        (client) => Effect.promise(() => client.end()).pipe(Effect.ignore),
      );
      yield* Effect.tryPromise({
        try: async () => {
          await client.connect();
          await client.query("begin");
          await client.query("select pg_advisory_xact_lock(1163412818, 1)");
          const result = await client.query(
            "select 1 from pg_roles where rolname = 'executor_runtime'",
          );
          if (result.rowCount === 0) await client.query("create role executor_runtime login");
          await client.query(
            `alter role executor_runtime password ${client.escapeLiteral(Redacted.value(password))}`,
          );
          await client.query("grant pg_read_all_data, pg_write_all_data to executor_runtime");
          await client.query("commit");
        },
        catch: () => new RoleFailed({ message: "Could not provision the preview runtime role." }),
      });
    }),
  ),
);
