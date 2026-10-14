/** Catalog and onboarding projections, independent of any integration runtime. */
import { Schema, SchemaGetter, type Effect } from "effect";
import { ApiError } from "@executor-js/utils/api-error";
import { TemplateErrorCode } from "@executor-js/app-templates/contracts";
import { AppCopyOrigin, SourceFiles } from "@executor-js/sdk";
import type { HostEgress } from "@executor-js/utils/url-policy";
import type { CustomAppInput } from "./imports.ts";
import { McpDetection } from "./detection.ts";

/** An image shown beside an app, light or dark. `src` is absolute once a catalog lists it. */
export const CatalogIcon = Schema.Struct({
  src: Schema.NonEmptyString,
  mimeType: Schema.optionalKey(Schema.String),
  theme: Schema.optionalKey(Schema.Literals(["light", "dark"])),
});
export type CatalogIcon = typeof CatalogIcon.Type;
/** One way to connect an account, as the app's provider declares it. */
export const CatalogAuth = Schema.Struct({
  method: Schema.NonEmptyString,
  kind: Schema.Literals(["secrets", "oauth2"]),
  label: Schema.optionalKey(Schema.String),
});
export type CatalogAuth = typeof CatalogAuth.Type;

/**
 * An official, vetted Executor app, or a host's own built-in app. Every entry installs its source
 * directly; the user then connects an account through the app's own providers.
 */
export const CatalogEntry = Schema.Struct({
  id: Schema.NonEmptyString,
  /** The app's package name, such as `@executor.sh/resend`. */
  package: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  description: Schema.String,
  auth: Schema.Array(CatalogAuth),
  category: Schema.optionalKey(Schema.String),
  icons: Schema.Array(CatalogIcon),
});
export type CatalogEntry = typeof CatalogEntry.Type;
/** A catalog choice contains no owner, workspace, account selection or credential. */
export const CatalogImport = Schema.Struct({ entry: Schema.NonEmptyString });
export type CatalogImport = typeof CatalogImport.Type;
/**
 * Ordinary source files ready for a product to save or deploy using its own rules. An official
 * app carries its `origin` and is installed as a copy under its own package name, as a published
 * app is; generated source has none and takes the installing organization's package scope.
 */
export const PreparedApp = Schema.Struct({
  files: SourceFiles,
  origin: Schema.optionalKey(AppCopyOrigin),
});
export type PreparedApp = typeof PreparedApp.Type;
/**
 * The feed's index, as `scripts/feed.ts` in the integrations repository writes it. Icon `src` and
 * `source` are relative to the index's own URL; `source` is always `apps/<id>.json`, which installs
 * read directly.
 */
export const CatalogFeed = Schema.Struct({
  version: Schema.Literal(1),
  apps: Schema.Array(Schema.Struct({ ...CatalogEntry.fields, source: Schema.NonEmptyString })),
});
/** One app's complete source, as the feed serves it. */
export const CatalogFeedSource = Schema.Struct({
  package: Schema.NonEmptyString,
  files: SourceFiles,
});
/** What to do next: a short step, and instructions for the agent that sets the service up. */
export const CatalogRecovery = Schema.Struct({
  action: Schema.NonEmptyString,
  instructions: Schema.NonEmptyString,
});
export type CatalogRecovery = typeof CatalogRecovery.Type;
/**
 * Import failures expose a safe, actionable reason, never a fetched document or credential. A
 * failed MCP server check also carries its typed detection and the signals that decided it. An MCP
 * server its caller's agent must set up carries the setup prompt as `recovery`.
 */
export class CatalogImportFailed extends Schema.TaggedError<CatalogImportFailed>()(
  "CatalogImportFailed",
  {
    code: Schema.Union([
      TemplateErrorCode,
      Schema.Literals([
        "entry_missing",
        "invalid_source",
        "agent_setup_required",
        "destination_blocked",
        "package_name",
        "mcp_url",
        "mcp_probe",
        "mcp_timeout",
      ]),
    ]),
    reason: Schema.String,
    detection: Schema.optionalKey(McpDetection),
    recovery: Schema.optionalKey(CatalogRecovery),
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
export const CatalogUnavailable = ApiError.define({
  tag: "CatalogUnavailable",
  status: 502,
  message: "Executor could not read the app catalog. Try again.",
});
export type CatalogUnavailable = typeof CatalogUnavailable.Type;

/**
 * What the importing host supplies. An import reads URLs a user chose, so it fetches with the
 * host's egress. `clientMetadataUrl` is the Client ID Metadata Document the host's account setup
 * uses, so an import reports the client setup that host will use.
 */
export interface CatalogHost {
  readonly egress: HostEgress;
  readonly clientMetadataUrl?: string | undefined;
  /**
   * The official app feed's `index.json`. Without one the catalog lists no feed apps; a host may
   * still add its own built-in apps.
   */
  readonly feedUrl?: string | undefined;
}

/** Where entries and their source come from, replaceable without changing the import workflow. */
export interface CatalogSource {
  readonly list: Effect.Effect<readonly CatalogEntry[], CatalogUnavailable>;
  /** The listed entry's complete source; it is read again, never kept from an earlier list. */
  readonly prepare: (
    entry: string,
  ) => Effect.Effect<PreparedApp, CatalogImportFailed | CatalogUnavailable>;
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
