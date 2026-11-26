import type { HostedApiDocument } from "../contracts/api.ts";
import { createCatalog } from "@executor-js/catalog";
import { Effect, Layer, Option } from "effect";
import type { HostEgress } from "@executor-js/utils/url-policy";
import { HostedCatalog } from "../contracts/catalog.ts";
import { executorCatalogEntry, executorCopyOrigin } from "./executor-catalog-entry.ts";
import type { ClientMetadataSetting } from "./oauth-client-metadata.ts";

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
      const official = createCatalog({
        egress,
        clientMetadataUrl: Option.getOrUndefined(Option.map(clientMetadata, ({ url }) => url)),
        feedUrl,
      });
      const executor = executorCatalogEntry(apiOrigin);
      return HostedCatalog.of({
        list: official.list.pipe(
          Effect.map((listing) => ({
            ...listing,
            apps: [executor, ...listing.apps.filter((entry) => entry.id !== executor.id)],
          })),
        ),
        custom: official.custom,
        prepare: (input) =>
          input.entry === executor.id
            ? Effect.all([Effect.promise(() => import("./executor-app.ts")), document]).pipe(
                Effect.flatMap(([{ executorAppSource }, document]) =>
                  executorAppSource(apiOrigin, document),
                ),
                Effect.map(({ files }) => ({ files, origin: executorCopyOrigin(apiOrigin) })),
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
