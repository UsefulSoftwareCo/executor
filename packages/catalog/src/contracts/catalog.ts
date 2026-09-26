/** Catalog and onboarding projections, independent of any integration runtime. */
import { Option, Schema, SchemaGetter, type Effect } from "effect";
import { SkippedOperation, TemplateErrorCode } from "@executor-js/app-templates/contracts";
import { DeployedApp, JsonObject, SourceFiles } from "@executor-js/sdk";
import { ImportAuth, ImportUrl, type CustomAppInput } from "./imports.ts";

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
/** GraphQL endpoints and auth settings can be completed before connecting an account. */
export const GraphqlImport = Schema.Struct({ url: ImportUrl, auth: ImportAuth });
export type GraphqlImport = typeof GraphqlImport.Type;
/** Translate a catalog header template into credential-free settings, refusing unknown hints. */
export const graphqlCatalogAuth = (entry: CatalogEntry): Option.Option<ImportAuth> => {
  if (entry.auth === undefined || ["none", "public"].includes(entry.auth.kind))
    return Option.some({ type: "none" });
  const header = /^([!#$%&'*+.^_`|~A-Za-z0-9-]+):[ \t]*([^{}\r\n]*)\{[A-Za-z0-9_]+\}$/.exec(
    entry.auth.header ?? "",
  );
  return Schema.decodeUnknownOption(ImportAuth)({
    type: "apiKey",
    header: header?.[1],
    prefix: header?.[2],
  });
};
/** A catalog choice contains no owner, workspace, account selection or credential. */
export const CatalogImport = Schema.Struct({
  entry: Schema.NonEmptyString,
  mcpAuth: Schema.optional(McpImportAuth),
  graphql: Schema.optional(GraphqlImport),
});
export type CatalogImport = typeof CatalogImport.Type;
/**
 * Ordinary source files ready for a product to save or deploy using its own rules, and the API
 * operations the importer had to leave out. Only OpenAPI imports skip operations.
 */
export const PreparedApp = Schema.Struct({
  files: SourceFiles,
  skippedOperations: Schema.Array(SkippedOperation),
});
export type PreparedApp = typeof PreparedApp.Type;
/** A deployed import and the operations it left out, so the user can see what is missing. */
export const ImportedApp = DeployedApp.mapFields((fields) => ({
  ...fields,
  skippedOperations: Schema.Array(SkippedOperation),
}));
export type ImportedApp = typeof ImportedApp.Type;
/** The registry envelope is versioned, rather than guessed from an arbitrary array. */
export const CatalogFeed = Schema.Struct({
  version: Schema.Literal(1),
  data: Schema.Array(CatalogEntry),
});
/** Import failures expose a safe, actionable reason, never a fetched document or credential. */
export class CatalogImportFailed extends Schema.TaggedError<CatalogImportFailed>()(
  "CatalogImportFailed",
  {
    code: Schema.Union([
      TemplateErrorCode,
      Schema.Literals([
        "entry_missing",
        "graphql_settings",
        "cli_unsupported",
        "destination_blocked",
        "base_url_blocked",
        "package_name",
        "patch_operation",
        "patch_path",
        "patch_mismatch",
        "patch_value",
        "mcp_url",
        "mcp_probe",
        "mcp_timeout",
        "mcp_auth_missing",
        "mcp_discovery",
        "mcp_entry",
        "mcp_auth_header",
        "document_size",
        "document_fetch",
        "document_http",
        "document_timeout",
        "document_redirect",
        "document_json",
        "document_yaml",
        "document_kind",
        "document_url",
      ]),
    ]),
    reason: Schema.String,
    // Optional on the wire for older clients; restored from safe fields on decode.
    message: Schema.optionalKey(Schema.String).pipe(
      Schema.decodeTo(Schema.optionalKey(Schema.String), {
        decode: SchemaGetter.omit(),
        encode: SchemaGetter.passthrough(),
      }),
    ),
    /** Observed unsuccessful download status; absent for transport, parse and generation failures. */
    httpStatus: Schema.optional(Schema.Int),
  },
  { httpApiStatus: 422 },
) {}
// Imported OpenAPI tools only forward a declared message, not arbitrary body fields.
Object.defineProperty(CatalogImportFailed.prototype, "message", {
  get(this: CatalogImportFailed) {
    return `${this.reason} [${this.code}${this.httpStatus === undefined ? "" : `; HTTP ${this.httpStatus}`}]`;
  },
});
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
