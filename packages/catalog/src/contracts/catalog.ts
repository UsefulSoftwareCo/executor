/** Catalog and onboarding projections, independent of any integration runtime. */
import { Schema, type Effect } from "effect";
import { JsonObject, SourceFiles } from "@executor-js/sdk";
import type { CustomAppInput } from "./imports.ts";

/** Public integrations.sh v1 entries; only metadata consumed by the importer is retained. */
export const CatalogEntry = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: Schema.Literals(["openapi", "mcp", "graphql", "cli"]),
  name: Schema.NonEmptyString,
  description: Schema.String,
  domain: Schema.String,
  connectUrl: Schema.optional(Schema.String),
  /** Protected-resource discovery target, independent of transport/spec options. */
  oauthDiscoveryUrl: Schema.optional(Schema.String),
  feeds: Schema.optional(Schema.Array(Schema.String)),
  popularity: Schema.optional(Schema.NullOr(Schema.Number)),
  auth: Schema.optional(
    Schema.Struct({ kind: Schema.String, header: Schema.optional(Schema.String) }),
  ),
  scopes: Schema.optional(Schema.Array(Schema.String)),
  specOverrides: Schema.optional(Schema.Array(JsonObject)),
});
export type CatalogEntry = typeof CatalogEntry.Type;
/** MCP imports can use the catalog's auth hints or an explicit user choice. */
export const McpImportAuth = Schema.Literals(["auto", "none", "oauth", "apiKey"]);
export type McpImportAuth = typeof McpImportAuth.Type;
/** A catalog choice contains no owner, workspace, account selection or credential. */
export const CatalogImport = Schema.Struct({
  entry: Schema.NonEmptyString,
  mcpAuth: Schema.optional(McpImportAuth),
});
export type CatalogImport = typeof CatalogImport.Type;
/** Ordinary source files ready for a product to save or deploy using its own rules. */
export const PreparedApp = Schema.Struct({ files: SourceFiles });
export type PreparedApp = typeof PreparedApp.Type;
/** The registry envelope is versioned, rather than guessed from an arbitrary array. */
export const CatalogFeed = Schema.Struct({
  version: Schema.Literal(1),
  data: Schema.Array(CatalogEntry),
});
/** Import failures expose a safe, actionable reason, never a fetched document or credential. */
export class CatalogImportFailed extends Schema.TaggedError<CatalogImportFailed>()(
  "CatalogImportFailed",
  {
    reason: Schema.String,
  },
  { httpApiStatus: 422 },
) {}
/** Remote catalog availability is separate from the local app inventory. */
export class CatalogUnavailable extends Schema.TaggedError<CatalogUnavailable>()(
  "CatalogUnavailable",
  {},
  { httpApiStatus: 502 },
) {}

/** Published metadata and API documents, replaceable without changing the import workflow. */
export interface CatalogSource {
  readonly list: Effect.Effect<readonly CatalogEntry[], CatalogUnavailable>;
  readonly document: (entry: CatalogEntry) => Effect.Effect<unknown, CatalogImportFailed>;
}

/** Read a catalog and prepare source. The caller owns access checks and installation. */
export interface Catalog {
  readonly list: Effect.Effect<readonly CatalogEntry[], CatalogUnavailable>;
  readonly prepare: (
    input: CatalogImport,
  ) => Effect.Effect<PreparedApp, CatalogImportFailed | CatalogUnavailable>;
  /** Prepare source for a URL a user supplied, using the same host egress as an install. */
  readonly custom: (input: CustomAppInput) => Effect.Effect<PreparedApp, CatalogImportFailed>;
}
