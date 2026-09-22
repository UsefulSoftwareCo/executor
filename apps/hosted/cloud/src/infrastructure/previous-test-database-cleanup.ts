/** Delete-only support for previews deployed before the isolated-branch cutover. */
import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import { Stage } from "alchemy/Stage";
import { Effect, Redacted } from "effect";
import { Client } from "pg";

const PreviousDatabase = Resource<
  Resource<
    "Executor.LogicalDatabase",
    {
      readonly adminUrl: Redacted.Redacted<string>;
      readonly name: string;
      readonly owner: string;
    },
    { readonly name: string; readonly owner: string }
  >
>("Executor.LogicalDatabase");

/** No new resource uses this provider. Keep interrupted deletion of pre-cutover state retryable. */
export const PreviousTestDatabaseCleanup = () =>
  Provider.succeed(PreviousDatabase, {
    read: ({ output }) => Effect.succeed(output),
    reconcile: () => Effect.die(new Error("Shared preview databases can only be deleted.")),
    delete: ({ olds, output }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const stage = yield* Stage;
          if (
            !stage.startsWith("test-") ||
            output.name !== `executor_${stage.slice(5).replaceAll("-", "_")}`
          )
            return yield* Effect.die(
              new Error("The old database does not belong to this test stage."),
            );
          const client = yield* Effect.acquireRelease(
            Effect.sync(
              () =>
                new Client({
                  connectionString: Redacted.value(olds.adminUrl),
                  connectionTimeoutMillis: 15000,
                }),
            ),
            (client) => Effect.promise(() => client.end()).pipe(Effect.ignore),
          );
          yield* Effect.tryPromise({
            try: async () => {
              await client.connect();
              await client.query(
                `drop database if exists "${output.name.replaceAll('"', '""')}" with (force)`,
              );
            },
            catch: () => new Error("Could not remove the pre-cutover test database."),
          });
        }),
      ),
  });
