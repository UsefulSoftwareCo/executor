import type { HostedApiDocument } from "../contracts/api.ts";
/** Supply shared catalog reads and source preparation to hosted handlers. */
import { createCatalog } from "@executor-js/catalog";
import { Effect, Layer, Option } from "effect";
import type { HostEgress } from "@executor-js/utils/url-policy";
import { HostedCatalog } from "../contracts/catalog.ts";
import { executorCatalogEntry } from "./executor-catalog-entry.ts";
import type { ClientMetadataSetting } from "./oauth-client-metadata.ts";

/**
 * Fetch the public integrations.sh feed on request. Layer construction performs no network I/O.
 * The API document and the Executor app source are only needed to prepare the Executor app, so
 * both load on that request instead of during server startup. The Executor app calls this
 * deployment's API, an OAuth resource, at `apiOrigin`.
 */
export const catalogLive = (
  document: Effect.Effect<HostedApiDocument>,
  egress: HostEgress,
  clientMetadata: Option.Option<ClientMetadataSetting>,
  apiOrigin: string,
) =>
  Layer.effect(
    HostedCatalog,
    Effect.gen(function* () {
      // Import checks report the client setup account setup uses: the validated document URL.
      const published = createCatalog({
        egress,
        clientMetadataUrl: Option.getOrUndefined(Option.map(clientMetadata, ({ url }) => url)),
      });
      const executor = executorCatalogEntry(apiOrigin);
      return HostedCatalog.of({
        list: published.list.pipe(
          Effect.map((entries) => [
            executor,
            ...entries.filter((entry) => entry.id !== executor.id),
          ]),
        ),
        custom: published.custom,
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
                    "catalog.entry.kind": executor.kind,
                  },
                }),
              )
            : published.prepare(input),
      });
    }),
  );
