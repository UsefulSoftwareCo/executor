import { createCatalog } from "@executor-js/catalog";
import { httpsOnlyUrlPolicy } from "@executor-js/utils/url-policy";
import { Config, Console, Effect } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

const egress = {
  policy: httpsOnlyUrlPolicy,
  client: Effect.runSync(HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer))),
};

await Effect.runPromise(
  Effect.gen(function* () {
    const feedUrl = yield* Config.String("EXECUTOR_CATALOG_URL");
    const catalog = createCatalog({ egress, feedUrl });
    const { apps: entries, feed } = yield* catalog.list;
    if (feed.status === "unavailable") return yield* feed.error;
    yield* Console.log(`${entries.length} apps`);
    const entry = process.argv[2] ?? entries[0]?.id;
    if (entry === undefined) return;
    const prepared = yield* catalog.prepare({ entry });
    yield* Console.log(
      prepared.origin,
      prepared.files.map((file) => file.path),
    );
  }),
);
