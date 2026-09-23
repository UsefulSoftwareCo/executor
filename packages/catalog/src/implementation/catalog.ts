/** Resolve catalog choices into ordinary app source; installation belongs to the caller. */
import { catalogStage } from "./diagnostics.ts";
import { Effect } from "effect";
import { CatalogImportFailed, type Catalog, type CatalogSource } from "../contracts/catalog.ts";
import { generateApp } from "./generate.ts";
import { generateCustomApp } from "./custom.ts";
import { generateMcpApp } from "./mcp.ts";
import { applyCatalogOverride } from "./overrides.ts";
import { catalogSource } from "./source.ts";
import type { HostEgress } from "@executor-js/utils/url-policy";

/**
 * Use integrations.sh by default, or supply a source. Construction performs no I/O. The host
 * supplies the egress it fetches with, because an import reads URLs a user chose.
 */
export const createCatalog = (
  egress: HostEgress,
  source: CatalogSource = catalogSource(egress.client),
): Catalog => {
  const list = source.list.pipe(
    Effect.flatMap((entries) => Effect.forEach(entries, applyCatalogOverride)),
    catalogStage("lookup"),
  );
  return {
    list,
    custom: (input) => generateCustomApp(input, egress),
    prepare: (input) =>
      Effect.gen(function* () {
        const entry = (yield* list).find((entry) => entry.id === input.entry);
        if (entry === undefined)
          return yield* new CatalogImportFailed({
            code: "entry_missing",
            reason: "This entry is no longer in the catalog. Refresh and choose another app.",
          });
        // Only a matched public catalog identifier is recorded, never an arbitrary lookup input.
        yield* Effect.annotateCurrentSpan({
          "catalog.entry.id": entry.id,
          "catalog.entry.kind": entry.kind,
        });
        const generated =
          entry.kind === "mcp"
            ? yield* generateMcpApp(entry, egress, input.mcpAuth).pipe(catalogStage("mcp"))
            : yield* source.document(entry).pipe(
                catalogStage("document"),
                Effect.flatMap((document) =>
                  generateApp(entry, document).pipe(catalogStage("generate")),
                ),
              );
        return { files: generated.files };
      }).pipe(catalogStage("prepare")),
  };
};
