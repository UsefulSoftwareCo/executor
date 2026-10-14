/** Resolve catalog choices into ordinary app source; installation belongs to the caller. */
import { catalogStage } from "./diagnostics.ts";
import { Effect } from "effect";
import type { Catalog, CatalogHost, CatalogSource } from "../contracts/catalog.ts";
import { catalogSource, emptySource } from "./source.ts";

/**
 * Read the host's official app feed, or a supplied source. Construction performs no I/O. The host
 * supplies the egress it fetches with and its OAuth client settings. The MCP source generator for
 * custom URLs loads with the first such import, which keeps it out of hosted startup.
 */
export const createCatalog = (
  host: CatalogHost,
  source: CatalogSource = host.feedUrl === undefined
    ? emptySource
    : catalogSource(host.egress.client, host.feedUrl),
): Catalog => ({
  list: source.list.pipe(catalogStage("lookup")),
  prepare: (input) => source.prepare(input.entry).pipe(catalogStage("prepare")),
  custom: (input) =>
    Effect.promise(() => import("./custom.ts")).pipe(
      Effect.flatMap(({ generateCustomApp }) => generateCustomApp(input, host)),
    ),
});
