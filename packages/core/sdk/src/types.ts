// ---------------------------------------------------------------------------
// Public projections beyond the core domain types. The integration / connection
// / tool views live in their own domain files (`integration.ts`, `connection.ts`,
// `tool.ts`); this file holds the schema-side views and the onboarding URL
// autodetect result.
// ---------------------------------------------------------------------------

import { Schema } from "effect";

import { ToolAddress } from "./ids";

// ---------------------------------------------------------------------------
// ToolSchemaView — the full schema-side view of a tool, returned by
// `executor.tools.schema(address)`. Includes JSON schema roots plus shared
// definitions for schema exploration, and optionally TypeScript preview strings.
// ---------------------------------------------------------------------------

export const ToolSchemaView = Schema.Struct({
  address: ToolAddress,
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  inputSchema: Schema.optional(Schema.Unknown),
  outputSchema: Schema.optional(Schema.Unknown),
  // "observed" = runtime-inferred from live responses (muscle memory), served
  // because the plugin declared no output schema. Absent = declared as-is.
  outputSchemaSource: Schema.optional(Schema.Literals(["observed"])),
  outputSchemaObservations: Schema.optional(Schema.Number),
  schemaDefinitions: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  inputTypeScript: Schema.optional(Schema.String),
  outputTypeScript: Schema.optional(Schema.String),
  typeScriptDefinitions: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type ToolSchemaView = typeof ToolSchemaView.Type;

// ---------------------------------------------------------------------------
// ToolProjection — one visible tool as an MCP passthrough surface serves it:
// the address, the resolved policy, and a SELF-CONTAINED input schema (shared
// `$defs` re-attached), returned by `executor.tools.describeAll()`. Built in
// one pass over the catalog so a workspace with thousands of tools costs a
// handful of reads, not one round-trip per tool.
// ---------------------------------------------------------------------------

export const ToolProjection = Schema.Struct({
  address: ToolAddress,
  integration: Schema.String,
  owner: Schema.Literals(["org", "user"]),
  connection: Schema.String,
  name: Schema.String,
  description: Schema.String,
  /** JSON Schema with every referenced `$def` inlined under `$defs`. Absent
   *  when the tool declares no input. */
  inputSchema: Schema.optional(Schema.Unknown),
  /** The effective policy action for this caller. `block`ed tools are never
   *  returned, so this is `approve` or `require_approval`. */
  policy: Schema.Literals(["approve", "require_approval"]),
  /** Whether the plugin marks the tool as never mutating upstream state. Only
   *  plugins that know (HTTP method, GraphQL operation kind, upstream MCP hint)
   *  set it; absent means unknown. */
  readOnly: Schema.optional(Schema.Boolean),
});
export type ToolProjection = typeof ToolProjection.Type;

// ---------------------------------------------------------------------------
// Integration detection — optional capability on `PluginSpec.detect`. When a
// user pastes a URL in the onboarding UI, `executor.integrations.detect(url)`
// asks every plugin "is this yours?" and returns the best-confidence match so
// the UI can auto-fill the onboarding form for the right plugin.
// ---------------------------------------------------------------------------

export const IntegrationDetectionResult = Schema.Struct({
  /** Plugin id that recognized the URL (e.g. "openapi", "graphql"). */
  kind: Schema.String,
  /** Confidence tier — UI uses this to pick a winner when multiple plugins
   *  claim a URL. */
  confidence: Schema.Literals(["high", "medium", "low"]),
  /** The (possibly normalized) endpoint the plugin will use. */
  endpoint: Schema.String,
  /** Human-readable name suggestion, typically derived from spec title or URL. */
  name: Schema.String,
  /** Slug suggestion — the plugin's recommendation for the integration slug. */
  slug: Schema.String,
});
export type IntegrationDetectionResult = typeof IntegrationDetectionResult.Type;
