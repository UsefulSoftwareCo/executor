/** Generate app source for a catalog choice. Loaded when a user prepares an app, not at startup. */
import { Effect, Option, Schema } from "effect";
import {
  CatalogImportFailed,
  GraphqlImport,
  graphqlCatalogAuth,
  type Catalog,
  type CatalogSource,
} from "../contracts/catalog.ts";
import type { HostEgress } from "@executor-js/utils/url-policy";
import { catalogStage } from "./diagnostics.ts";
import { generateApp } from "./generate.ts";
import { complete, generateCustomApp } from "./custom.ts";
import { generateMcpApp } from "./mcp.ts";

export { generateCustomApp };

/** Resolve one listed entry into ordinary app source. */
export const prepareEntry = (
  list: Catalog["list"],
  source: CatalogSource,
  egress: HostEgress,
  input: Parameters<Catalog["prepare"]>[0],
) =>
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
          return yield* generateMcpApp(entry, egress, input.mcpAuth).pipe(
            Effect.map(complete),
            catalogStage("mcp"),
          );
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
              generateApp(entry, document).pipe(
                Effect.map(({ files, skippedOperations }) => ({ files, skippedOperations })),
                catalogStage("generate"),
              ),
            ),
          );
        case "cli":
          return yield* new CatalogImportFailed({
            code: "cli_unsupported",
            reason: "CLI imports are not supported.",
          });
      }
    });
    return generated;
  });
