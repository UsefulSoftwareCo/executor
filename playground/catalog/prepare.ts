/** Prepare source without a product server, account, database or workspace. No network calls. */
import { createCatalog } from "@executor-js/catalog";
import { httpsOnlyUrlPolicy } from "@executor-js/utils/url-policy";
import { Console, Effect } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

// Supply a small feed so this example works offline. A host normally passes a client that also
// checks the address a destination resolves to; nothing here reaches the network.
const egress = {
  policy: httpsOnlyUrlPolicy,
  client: Effect.runSync(HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer))),
};
const catalog = createCatalog(egress, {
  list: Effect.succeed([
    {
      id: "example/notes",
      kind: "openapi",
      name: "Notes",
      description: "Example notes API",
      domain: "example.test",
      connectUrl: "https://example.test/openapi.json",
    },
  ]),
  document: () =>
    Effect.succeed({
      openapi: "3.1.0",
      servers: [{ url: "https://example.test" }],
      paths: { "/notes": { get: { operationId: "listNotes", summary: "List notes" } } },
    }),
});

await Effect.runPromise(
  Effect.gen(function* () {
    const prepared = yield* catalog.prepare({ entry: "example/notes" });
    yield* Console.log(prepared.files.map((file) => file.path));

    // Stop at files. A local or hosted product decides how to install them.
  }),
);
