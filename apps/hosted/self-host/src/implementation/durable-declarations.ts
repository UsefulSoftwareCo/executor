/**
 * Evaluated declarations and tool listings kept in the self-host's product database, so a restart
 * serves the listings it already evaluated instead of loading every app Worker to evaluate them
 * again. Cloud keeps the same results in each app's data supervisor.
 *
 * Results can include text derived from credentials. They stay in the product database, which
 * already holds the encrypted account state and is owned by the same operator.
 */
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { DeclarationCache, DurableDeclarations } from "@executor-js/sdk/core";

/** Results larger than this are not kept; a cold evaluation is cheaper than storing them. */
const entryChars = 4 * 1024 * 1024;

export const selfHostDurableDeclarations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const durable: DurableDeclarations = {
    get: (app, key) =>
      sql<{ at: string | number; json: string }>`select at, json from hosted_evaluated
        where app = ${app} and key = ${key} and until > ${Date.now()}`.pipe(
        Effect.map((rows) => {
          const row = rows[0];
          return row === undefined ? undefined : { at: Number(row.at), json: row.json };
        }),
        Effect.catchCause(() => Effect.succeed(undefined)),
        Effect.withSpan("storage.evaluated.read"),
      ),
    set: (app, key, entry) =>
      entry.json.length > entryChars
        ? Effect.void
        : sql`insert into hosted_evaluated (app, key, at, until, json)
            values (${app}, ${key}, ${entry.at}, ${entry.until}, ${entry.json})
            on conflict (app, key) do update
              set at = excluded.at, until = excluded.until, json = excluded.json
              where hosted_evaluated.at <= excluded.at`.pipe(
            Effect.asVoid,
            Effect.catchCause(() => Effect.logWarning("Evaluated result was not kept")),
            Effect.withSpan("storage.evaluated.write"),
          ),
  };
  /** The app's durable results are forgotten with its in-process ones when its cache changes. */
  const forgetting = (cache: DeclarationCache): DeclarationCache => ({
    ...cache,
    changed: (app, at) => {
      cache.changed(app, at);
      Effect.runFork(
        sql`delete from hosted_evaluated where app = ${app} and at <= ${at}`.pipe(
          Effect.catchCause(() => Effect.logWarning("Evaluated results were not forgotten")),
        ),
      );
    },
  });
  return { durable, forgetting };
});
