import type { HostedApiDocument } from "../contracts/api.ts";
/** Supply shared catalog reads and source preparation to hosted handlers. */
import { createCatalog } from "@executor-js/catalog";
import { Effect, Layer, Option } from "effect";
import type { HostEgress } from "@executor-js/utils/url-policy";
import { HostedCatalog } from "../contracts/catalog.ts";
import { executorCatalogEntry } from "./executor-catalog-entry.ts";
import type { ClientMetadataSetting } from "./oauth-client-metadata.ts";

/**
 * Read the official app feed at `feedUrl` on request, after this installation's built-in Executor
 * app. Layer construction performs no network I/O. The API document and the Executor app source are
 * only needed to prepare the Executor app, so both load on that request instead of during server
 * startup. The Executor app calls this deployment's API, an OAuth resource, at `apiOrigin`.
 */
export const catalogLive = (
  document: Effect.Effect<HostedApiDocument>,
  egress: HostEgress,
  clientMetadata: Option.Option<ClientMetadataSetting>,
  apiOrigin: string,
  feedUrl?: string,
) =>
  Layer.effect(
    HostedCatalog,
    Effect.gen(function* () {
      // Import checks report the client setup account setup uses: the validated document URL.
      const official = createCatalog({
        egress,
        clientMetadataUrl: Option.getOrUndefined(Option.map(clientMetadata, ({ url }) => url)),
        feedUrl,
      });
      const executor = executorCatalogEntry(apiOrigin);
      return HostedCatalog.of({
        list: official.list.pipe(
          Effect.map((entries) => [
            executor,
            ...entries.filter((entry) => entry.id !== executor.id),
          ]),
        ),
        custom: official.custom,
        prepare: (input) =>
          input.entry === executor.id
            ? Effect.all([Effect.promise(() => import("./executor-app.ts")), document]).pipe(
                Effect.flatMap(([{ executorAppSource }, document]) =>
                  executorAppSource(apiOrigin, document),
                ),
                Effect.map(({ files }) => ({ files })),
                Effect.withSpan("catalog.generate", {
                  attributes: {
                    "catalog.stage": "generate",
                    "catalog.entry.id": executor.id,
                  },
                }),
              )
            : official.prepare(input),
      });
    }),
  );
