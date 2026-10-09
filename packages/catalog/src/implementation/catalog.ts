/** Resolve catalog choices into ordinary app source; installation belongs to the caller. */
import { catalogStage } from "./diagnostics.ts";
import { Effect } from "effect";
import type { Catalog, CatalogHost, CatalogSource } from "../contracts/catalog.ts";
import { applyCatalogOverride } from "./overrides.ts";
import { catalogSource } from "./source.ts";

/**
 * Use integrations.sh by default, or supply a source. Construction performs no I/O. The host
 * supplies the egress it fetches with and its OAuth client settings. Source generators load with
 * the first preparation, which keeps them out of hosted startup.
 */
export const createCatalog = (
  host: CatalogHost,
  source: CatalogSource = catalogSource(host.egress.client),
): Catalog => {
  const list = source.list.pipe(
    Effect.map((entries) => entries.map(applyCatalogOverride)),
    catalogStage("lookup"),
  );
  return {
    list,
    custom: (input) =>
      Effect.promise(() => import("./prepare.ts")).pipe(
        Effect.flatMap(({ generateCustomApp }) => generateCustomApp(input, host)),
      ),
    prepare: (input) =>
      Effect.promise(() => import("./prepare.ts")).pipe(
        Effect.flatMap(({ prepareEntry }) => prepareEntry(list, host, input)),
        catalogStage("prepare"),
      ),
  };
};
