/** Resolve catalog choices into ordinary app source; installation belongs to the caller. */
import { catalogStage } from "./diagnostics.ts";
import { Effect } from "effect";
import type { Catalog, CatalogSource } from "../contracts/catalog.ts";
import { applyCatalogOverride } from "./overrides.ts";
import { catalogSource } from "./source.ts";
import type { HostEgress } from "@executor-js/utils/url-policy";

/**
 * Use integrations.sh by default, or supply a source. Construction performs no I/O. The host
 * supplies the egress it fetches with, because an import reads URLs a user chose. Source
 * generators load with the first preparation, which keeps them out of hosted startup.
 */
export const createCatalog = (
  egress: HostEgress,
  source: CatalogSource = catalogSource(egress.client),
): Catalog => {
  const list = source.list.pipe(
    Effect.map((entries) => entries.map(applyCatalogOverride)),
    catalogStage("lookup"),
  );
  return {
    list,
    custom: (input) =>
      Effect.promise(() => import("./prepare.ts")).pipe(
        Effect.flatMap(({ generateCustomApp }) => generateCustomApp(input, egress)),
      ),
    prepare: (input) =>
      Effect.promise(() => import("./prepare.ts")).pipe(
        Effect.flatMap(({ prepareEntry }) => prepareEntry(list, egress, input)),
        catalogStage("prepare"),
      ),
  };
};
