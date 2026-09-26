/** Catalog and onboarding projections, independent of any integration runtime. */
import { Schema, SchemaGetter, type Effect } from "effect";
import { TemplateErrorCode } from "@executor-js/app-templates/contracts";
import { SourceFiles } from "@executor-js/sdk";
import type { CustomAppInput } from "./imports.ts";

/**
 * Public integrations.sh v1 entries, plus a host's own built-in apps. Only MCP servers and
 * built-in apps are added directly; every other kind is set up with the user's agent.
 */
export const CatalogEntry = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: Schema.Literals(["app", "openapi", "mcp", "graphql", "cli"]),
  name: Schema.NonEmptyString,
  description: Schema.String,
  domain: Schema.String,
  connectUrl: Schema.optional(Schema.String),
  /** Protected-resource discovery target, independent of transport options. */
  oauthDiscoveryUrl: Schema.optional(Schema.String),
  feeds: Schema.optional(Schema.Array(Schema.String)),
  popularity: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type CatalogEntry = typeof CatalogEntry.Type;
/** Entries a host can add without the user's agent; others copy a setup prompt instead. */
export const quickAdd = (entry: CatalogEntry) =>
  entry.kind === "app" || (entry.kind === "mcp" && entry.connectUrl !== undefined);
/** A catalog choice contains no owner, workspace, account selection or credential. */
export const CatalogImport = Schema.Struct({ entry: Schema.NonEmptyString });
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
    code: Schema.Union([
      TemplateErrorCode,
      Schema.Literals([
        "entry_missing",
        "agent_setup_required",
        "destination_blocked",
        "package_name",
        "mcp_url",
        "mcp_probe",
        "mcp_timeout",
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
  },
  { httpApiStatus: 422 },
) {}
// Imported OpenAPI tools only forward a declared message, not arbitrary body fields.
Object.defineProperty(CatalogImportFailed.prototype, "message", {
  get(this: CatalogImportFailed) {
    return `${this.reason} [${this.code}]`;
  },
});
/** Remote catalog availability is separate from the local app inventory. */
export class CatalogUnavailable extends Schema.TaggedError<CatalogUnavailable>()(
  "CatalogUnavailable",
  {},
  { httpApiStatus: 502 },
) {}

/** Published metadata, replaceable without changing the import workflow. */
export interface CatalogSource {
  readonly list: Effect.Effect<readonly CatalogEntry[], CatalogUnavailable>;
}

/** Read a catalog and prepare source. The caller owns access checks and installation. */
export interface Catalog {
  readonly list: Effect.Effect<readonly CatalogEntry[], CatalogUnavailable>;
  readonly prepare: (
    input: CatalogImport,
  ) => Effect.Effect<PreparedApp, CatalogImportFailed | CatalogUnavailable>;
  /** Prepare source for an MCP URL a user supplied, using the same host egress as an install. */
  readonly custom: (input: CustomAppInput) => Effect.Effect<PreparedApp, CatalogImportFailed>;
}
