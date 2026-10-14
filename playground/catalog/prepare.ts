/**
 * Prepare an official app's source without a product server, account, database or workspace.
 * Usage: EXECUTOR_CATALOG_URL=<feed>/index.json node prepare.ts [entry]
 */
import { createCatalog } from "@executor-js/catalog";
import { httpsOnlyUrlPolicy } from "@executor-js/utils/url-policy";
import { Config, Console, Effect } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

// A host normally passes a client that also checks the address a destination resolves to.
const egress = {
  policy: httpsOnlyUrlPolicy,
  client: Effect.runSync(HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer))),
};

await Effect.runPromise(
  Effect.gen(function* () {
    const feedUrl = yield* Config.String("EXECUTOR_CATALOG_URL");
    const catalog = createCatalog({ egress, feedUrl });
    const entries = yield* catalog.list;
    yield* Console.log(`${entries.length} apps`);
    const entry = process.argv[2] ?? entries[0]?.id;
    if (entry === undefined) return;
    const prepared = yield* catalog.prepare({ entry });
    yield* Console.log(
      prepared.origin,
      prepared.files.map((file) => file.path),
    );

    // Stop at files. A local or hosted product decides how to install them.
  }),
);
