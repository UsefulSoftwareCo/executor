import { Config, Schema, SchemaGetter, type Effect } from "effect";
import { ApiError } from "@executor-js/utils/api-error";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { TemplateErrorCode } from "@executor-js/app-templates/contracts";
import { AppCopyOrigin, SourceFiles } from "@executor-js/sdk";
import type { HostEgress } from "@executor-js/utils/url-policy";
import type { CustomAppInput } from "./imports.ts";
import { McpDetection } from "./detection.ts";

export const CatalogIcon = Schema.Struct({
  src: Schema.NonEmptyString,
  mimeType: Schema.optionalKey(Schema.String),
  theme: Schema.optionalKey(Schema.Literals(["light", "dark"])),
});
export type CatalogIcon = typeof CatalogIcon.Type;
export const CatalogAuth = Schema.Struct({
  method: Schema.NonEmptyString,
  kind: Schema.Literals(["secrets", "oauth2"]),
  label: Schema.optionalKey(Schema.String),
});
export type CatalogAuth = typeof CatalogAuth.Type;

export const CatalogEntry = Schema.Struct({
  id: Schema.NonEmptyString,
  package: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  description: Schema.String,
  auth: Schema.Array(CatalogAuth),
  category: Schema.optionalKey(Schema.String),
  icons: Schema.Array(CatalogIcon),
});
export type CatalogEntry = typeof CatalogEntry.Type;
export const CatalogQuery = {
  search: Schema.optional(
    Schema.String.annotate({
      description:
        "Case-insensitive text, trimmed, matched as a substring of each entry's id, name or package. Matches keep the catalog's order. Blank text matches every entry.",
    }),
  ),
  limit: Schema.optional(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: 1_000 }),
    ).pipe(
      Schema.annotateEncoded({
        description:
          "The most entries to return after filtering: a whole number from 1 to 1000. Without it, every match.",
      }),
    ),
  ),
};
export type CatalogQuery = Schema.Struct.Type<typeof CatalogQuery>;
export const filterCatalog = (
  entries: ReadonlyArray<CatalogEntry>,
  filter: CatalogQuery = {},
): ReadonlyArray<CatalogEntry> => {
  const text = filter.search?.trim().toLowerCase();
  const matched =
    text === undefined || text === ""
      ? entries
      : entries.filter((entry) =>
          [entry.id, entry.name, entry.package].some((value) => value.toLowerCase().includes(text)),
        );
  return filter.limit === undefined ? matched : matched.slice(0, filter.limit);
};
export const CatalogImport = Schema.Struct({ entry: Schema.NonEmptyString });
export type CatalogImport = typeof CatalogImport.Type;
export const PreparedApp = Schema.Struct({
  files: SourceFiles,
  origin: Schema.optionalKey(AppCopyOrigin),
});
export type PreparedApp = typeof PreparedApp.Type;
export const officialCatalogUrl = "https://catalog.executor.sh/index.json";
export const catalogFeedSetting = Config.String("EXECUTOR_CATALOG_URL").pipe(
  Config.withDefault(officialCatalogUrl),
  Config.map((value) => (value.trim().toLowerCase() === "off" ? undefined : value)),
);
export const CatalogFeed = Schema.Struct({
  version: Schema.Literal(1),
  apps: Schema.Array(Schema.Struct({ ...CatalogEntry.fields, source: Schema.NonEmptyString })),
});
export const CatalogFeedSource = Schema.Struct({
  package: Schema.NonEmptyString,
  files: SourceFiles,
});
export const CatalogRecovery = Schema.Struct({
  action: Schema.NonEmptyString,
  instructions: Schema.NonEmptyString,
});
export type CatalogRecovery = typeof CatalogRecovery.Type;
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
    message: Schema.optionalKey(Schema.String).pipe(
      Schema.decodeTo(Schema.optionalKey(Schema.String), {
        decode: SchemaGetter.omit(),
        encode: SchemaGetter.passthrough(),
      }),
    ),
  },
  { httpApiStatus: 422 },
) {}
Object.defineProperty(CatalogImportFailed.prototype, "message", {
  get(this: CatalogImportFailed) {
    return `${this.reason} [${this.code}]`;
  },
});
const unavailableDescription =
  "This Executor server could not read its app catalog feed just now, so this request to list or add Executor’s official apps did not complete.";
const unavailableNextStep =
  "Nothing was added, and the apps still exist. Try again shortly; if it still fails, add the app from its MCP server URL or build it.";
const unavailableRepair =
  "If it keeps failing on Executor Cloud, contact Executor support; on a self-hosted or local server, whoever runs it should check its EXECUTOR_CATALOG_URL setting, its outbound internet access, and that the feed returns valid catalog data.";

export const CatalogUnavailable = ApiError.define({
  tag: "CatalogUnavailable",
  status: 502,
  message: `${unavailableDescription} ${unavailableNextStep} ${unavailableRepair}`,
});
export type CatalogUnavailable = typeof CatalogUnavailable.Type;

export const CatalogFeedUnavailable = UserFacingError.define({
  tag: "CatalogFeedUnavailable",
  status: 502,
  title: "App catalog unavailable",
  description: unavailableDescription,
  recovery: {
    action: `Try again. ${unavailableRepair}`,
    instructions: `${unavailableNextStep} ${unavailableRepair} Add a remote MCP server through the Executor app's apps.importCustom where you have it, or from the dashboard's Add app, Make your own, From an MCP server. A self-hosted or local server without internet access can set EXECUTOR_CATALOG_URL=off.`,
  },
  retryable: true,
});
export type CatalogFeedUnavailable = typeof CatalogFeedUnavailable.Type;

export const catalogTurnedOff =
  "This Executor instance has its app catalog turned off (EXECUTOR_CATALOG_URL=off), so Executor's official apps are not listed. Add a remote MCP server by URL, or build an app.";

export const CatalogFeedState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("listed") }),
  Schema.Struct({ status: Schema.Literal("off"), message: Schema.String }),
  Schema.Struct({ status: Schema.Literal("unavailable"), error: CatalogFeedUnavailable }),
]);
export type CatalogFeedState = typeof CatalogFeedState.Type;

export const CatalogListing = Schema.Struct({
  apps: Schema.Array(CatalogEntry),
  feed: CatalogFeedState,
});
export type CatalogListing = typeof CatalogListing.Type;

export interface CatalogHost {
  readonly egress: HostEgress;
  readonly clientMetadataUrl?: string | undefined;
  readonly feedUrl?: string | undefined;
}

export interface CatalogSource {
  readonly list: Effect.Effect<readonly CatalogEntry[], CatalogUnavailable>;
  readonly prepare: (
    entry: string,
  ) => Effect.Effect<PreparedApp, CatalogImportFailed | CatalogUnavailable>;
}

export interface Catalog {
  readonly list: Effect.Effect<CatalogListing>;
  readonly prepare: (
    input: CatalogImport,
  ) => Effect.Effect<PreparedApp, CatalogImportFailed | CatalogUnavailable>;
  readonly custom: (input: CustomAppInput) => Effect.Effect<PreparedApp, CatalogImportFailed>;
}
