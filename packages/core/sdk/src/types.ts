// ---------------------------------------------------------------------------
// Public projections — what consumers see when they call
// `executor.sources.list()` / `executor.tools.list()`. Deliberately leaner
// than the row shapes in core-schema.ts: no audit columns, no raw JSON.
// ---------------------------------------------------------------------------

import { Schema } from "effect";

import type { ToolAnnotations } from "./core-schema";
import { ToolId } from "./ids";

export interface Source {
  readonly id: string;
  /** Owning scope of the visible source row. Present for dynamic
   *  sources; static sources omit it. */
  readonly scopeId?: string;
  readonly kind: string;
  readonly name: string;
  readonly url?: string;
  /** Which plugin owns this source. */
  readonly pluginId: string;
  /** Whether the user can remove this source via
   *  `executor.sources.remove({ id, targetScope })`. `false` for
   *  static / built-in sources declared by plugins at startup. */
  readonly canRemove: boolean;
  /** Whether the plugin supports `executor.sources.refresh({ id, targetScope })`. */
  readonly canRefresh: boolean;
  /** Whether the source has editable config (headers, base url, etc.).
   *  Editing is done via plugin-specific extension methods
   *  (`executor.openapi.updateSource(id, patch)` etc.) — this flag is
   *  just a UI signal. */
  readonly canEdit: boolean;
  /** True if the source was declared statically by a plugin at startup
   *  (in-memory only, no DB row). False if it was added at runtime via
   *  `ctx.core.sources.register(...)`. UI differentiates built-in vs
   *  user-added with this. */
  readonly runtime: boolean;
}

export interface RemoveSourceInput {
  readonly id: string;
  readonly targetScope: string;
}

export interface RefreshSourceInput {
  readonly id: string;
  readonly targetScope: string;
}

export interface Tool {
  readonly id: string;
  readonly sourceId: string;
  /** Which plugin owns this tool. Matches the owning source's `pluginId`. */
  readonly pluginId: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: ToolAnnotations;
}

// ---------------------------------------------------------------------------
// ToolSchema — the full schema-side view of a tool, returned by
// `executor.tools.schema(toolId)`. Includes JSON schemas with `$defs`
// attached at read time AND TypeScript preview strings rendered from
// them via `schemaToTypeScriptPreview`. The UI uses the TS previews to
// show "calling this tool looks like this" code samples.
// ---------------------------------------------------------------------------

export class ToolSchema extends Schema.Class<ToolSchema>("ToolSchema")({
  id: ToolId,
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  inputSchema: Schema.optional(Schema.Unknown),
  outputSchema: Schema.optional(Schema.Unknown),
  inputTypeScript: Schema.optional(Schema.String),
  outputTypeScript: Schema.optional(Schema.String),
  typeScriptDefinitions: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

// ---------------------------------------------------------------------------
// Source detection — optional capability on `PluginSpec.detect`. When a
// user pastes a URL in the onboarding UI, `executor.sources.detect(url)`
// asks every plugin "is this yours?" and returns the best-confidence
// match so the UI can auto-fill the onboarding form for the right
// plugin.
// ---------------------------------------------------------------------------

export class SourceDetectionResult extends Schema.Class<SourceDetectionResult>(
  "SourceDetectionResult",
)({
  /** Plugin id that recognized the URL (e.g. "openapi", "graphql"). */
  kind: Schema.String,
  /** Confidence tier — UI uses this to pick a winner when multiple
   *  plugins claim a URL. */
  confidence: Schema.Literals(["high", "medium", "low"]),
  /** The (possibly normalized) endpoint the plugin will use. */
  endpoint: Schema.String,
  /** Human-readable name suggestion, typically derived from spec title
   *  or URL hostname. */
  name: Schema.String,
  /** Namespace suggestion — the plugin's recommendation for the source
   *  id. UI may override. */
  namespace: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Filter passed to `executor.tools.list(...)`. Empty filter = all tools.
// ---------------------------------------------------------------------------

export interface ToolListFilter {
  /** Only tools under this source id. */
  readonly sourceId?: string;
  /** Case-insensitive substring match against `name` OR `description`. */
  readonly query?: string;
  /** Resolve plugin-derived annotations. Defaults to true. */
  readonly includeAnnotations?: boolean;
  /** Include tools whose effective `tool_policy` is `block`. Defaults to
   *  `false` so the agent-facing surfaces (`searchTools`, sandbox `tools.list`)
   *  silently omit blocked tools. The settings UI for managing policies
   *  should pass `true` so users can author rules against blocked tools. */
  readonly includeBlocked?: boolean;
}
