/** Prepare source without a product server, account, database or workspace. */
import { createCatalog } from "@executor-js/catalog";
import { httpsOnlyUrlPolicy } from "@executor-js/utils/url-policy";
import { Console, Effect } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

// A host normally passes a client that also checks the address a destination resolves to.
const egress = {
  policy: httpsOnlyUrlPolicy,
  client: Effect.runSync(HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer))),
};
// Supply a one-entry feed. Preparing an MCP entry checks the server over the network to confirm
// that it needs no sign-in or supports OAuth; it never lists or calls tools.
const catalog = createCatalog(egress, {
  list: Effect.succeed([
    {
      id: "example/deepwiki",
      kind: "mcp",
      name: "DeepWiki",
      description: "Public documentation MCP server",
      domain: "deepwiki.com",
      connectUrl: "https://mcp.deepwiki.com/mcp",
    },
  ]),
});

await Effect.runPromise(
  Effect.gen(function* () {
    const prepared = yield* catalog.prepare({ entry: "example/deepwiki" });
    yield* Console.log(prepared.files.map((file) => file.path));

    // Stop at files. A local or hosted product decides how to install them.
  }),
);
