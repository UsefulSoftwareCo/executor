/** Product defaults overlay registry entries without adding competing catalog rows. */
import { Effect } from "effect";
import { CatalogUnavailable, type CatalogEntry } from "../contracts/catalog.ts";

/** Expose PostHog's individual tools; preserve every other query option and its OAuth discovery target. */
export const applyCatalogOverride = (
  entry: CatalogEntry,
): Effect.Effect<CatalogEntry, CatalogUnavailable> => {
  if (
    entry.id !== "curated/posthog-com-mcp" ||
    entry.kind !== "mcp" ||
    entry.connectUrl === undefined
  )
    return Effect.succeed(entry);
  const original = entry.connectUrl;
  return Effect.try({
    try: () => {
      const url = new URL(original);
      url.searchParams.set("mode", "tools");
      return {
        ...entry,
        connectUrl: url.href,
        oauthDiscoveryUrl: entry.oauthDiscoveryUrl ?? original,
      };
    },
    catch: () => new CatalogUnavailable(),
  });
};
