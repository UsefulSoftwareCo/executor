/** Resolve catalog choices into ordinary app source; installation belongs to the caller. */
import { catalogStage } from "./diagnostics.ts";
import { Effect } from "effect";
import {
  CatalogFeedUnavailable,
  catalogTurnedOff,
  type Catalog,
  type CatalogHost,
  type CatalogListing,
  type CatalogSource,
} from "../contracts/catalog.ts";
import { catalogSource, turnedOffPrepare } from "./source.ts";

/**
 * Read the host's official app feed, or a supplied source. Without either, the catalog is turned
 * off. Construction performs no I/O. The host supplies the egress it fetches with and its OAuth
 * client settings. A feed that cannot be read gives a listing that says so instead of failing, so
 * the host's built-in apps stay listed. The MCP source generator for custom URLs loads with the
 * first such import, which keeps it out of hosted startup.
 */
export const createCatalog = (
  host: CatalogHost,
  source: CatalogSource | undefined = host.feedUrl === undefined
    ? undefined
    : catalogSource(host.egress.client, host.feedUrl),
): Catalog => ({
  list:
    source === undefined
      ? Effect.succeed<CatalogListing>({
          apps: [],
          feed: { status: "off", message: catalogTurnedOff },
        })
      : source.list.pipe(
          catalogStage("lookup"),
          Effect.map((apps): CatalogListing => ({ apps, feed: { status: "listed" } })),
          Effect.catchTag("CatalogUnavailable", () =>
            Effect.succeed<CatalogListing>({
              apps: [],
              feed: { status: "unavailable", error: new CatalogFeedUnavailable() },
            }),
          ),
        ),
  prepare: (input) =>
    (source === undefined ? turnedOffPrepare(input.entry) : source.prepare(input.entry)).pipe(
      catalogStage("prepare"),
    ),
  custom: (input) =>
    Effect.promise(() => import("./custom.ts")).pipe(
      Effect.flatMap(({ generateCustomApp }) => generateCustomApp(input, host)),
    ),
});
