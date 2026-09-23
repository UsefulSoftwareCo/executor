/** Resolve catalog choices into ordinary app source; installation belongs to the caller. */
import { catalogStage } from "./diagnostics.ts";
import { Effect, Option, Schema } from "effect";
import {
  CatalogImportFailed,
  GraphqlImport,
  graphqlCatalogAuth,
  type Catalog,
  type CatalogSource,
} from "../contracts/catalog.ts";

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
        const generated = yield* Effect.gen(function* () {
          switch (entry.kind) {
            case "mcp":
              return yield* generateMcpApp(entry, egress, input.mcpAuth).pipe(catalogStage("mcp"));
            case "graphql": {
              const settings =
                input.graphql === undefined
                  ? Schema.decodeUnknownOption(GraphqlImport)({
                      url: entry.connectUrl,
                      auth: Option.getOrUndefined(graphqlCatalogAuth(entry)),
                    })
                  : Option.some(input.graphql);
              if (Option.isNone(settings))
                return yield* new CatalogImportFailed({
                  code: "graphql_settings",
                  reason: "Enter the GraphQL endpoint and authentication settings, then try again.",
                });
              return yield* generateCustomApp(
                {
                  kind: "graphql",
                  name: entry.name,
                  ...settings.value,
                },
                egress,
              );
            }
            case "openapi":
              return yield* source.document(entry).pipe(
                catalogStage("document"),
                Effect.flatMap((document) =>
                  generateApp(entry, document).pipe(catalogStage("generate")),
                ),
              );
            case "cli":
              return yield* new CatalogImportFailed({
                code: "cli_unsupported",
                reason: "CLI imports are not supported.",
              });
          }
        });
        return { files: generated.files };
      }).pipe(catalogStage("prepare")),
  };
};
