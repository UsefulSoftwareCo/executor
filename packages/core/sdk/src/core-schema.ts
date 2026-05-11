// ---------------------------------------------------------------------------
// Core data model — the SDK owns these tables. Plugins write into them via
// `ctx.core.sources.register(...)` and `ctx.core.definitions.register(...)`;
// the executor reads from them directly on every list / invoke / schema
// call. There is no in-memory registry layered on top.
//
// Static (code-declared) sources and tools are NOT in these tables — they
// live in an in-memory map built at executor startup from each plugin's
// `staticSources` declaration. See executor.ts. The DB only holds
// dynamic (runtime-registered) rows.
// ---------------------------------------------------------------------------

import type { DBSchema, InferDBFieldsOutput } from "@executor-js/storage-core";

export const credentialBindingKinds = ["text", "secret", "connection"] as [
  "text",
  "secret",
  "connection",
];

export const coreSchema = {
  source: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      plugin_id: { type: "string", required: true, index: true },
      kind: { type: "string", required: true },
      name: { type: "string", required: true },
      url: { type: "string", required: false },
      can_remove: {
        type: "boolean",
        required: true,
        defaultValue: true,
      },
      can_refresh: {
        type: "boolean",
        required: true,
        defaultValue: false,
      },
      can_edit: {
        type: "boolean",
        required: true,
        defaultValue: false,
      },
      created_at: { type: "date", required: true },
      updated_at: { type: "date", required: true },
    },
  },
  tool: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      source_id: { type: "string", required: true, index: true },
      plugin_id: { type: "string", required: true, index: true },
      name: { type: "string", required: true },
      description: { type: "string", required: true },
      input_schema: { type: "json", required: false },
      output_schema: { type: "json", required: false },
      // NOTE: tool annotations (requiresApproval, approvalDescription,
      // mayElicit) are NOT stored on this row. They're derived at read
      // time from plugin-owned data via `plugin.resolveAnnotations`,
      // because the source of truth already lives in each plugin's own
      // storage (openapi's OperationBinding, etc.) and duplicating it
      // here would just mean bulk-rewriting rows every time the
      // derivation logic changes.
      created_at: { type: "date", required: true },
      updated_at: { type: "date", required: true },
    },
  },
  // Shared JSON-schema `$defs` stored once per source. Tool input/output
  // schemas carry `$ref: "#/$defs/X"` pointers; the read path attaches
  // matching defs under `$defs` before returning. Keyed by synthetic id
  // `${source_id}.${name}` so cleanup on source removal is a single
  // deleteMany by source_id.
  definition: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      source_id: { type: "string", required: true, index: true },
      plugin_id: { type: "string", required: true, index: true },
      name: { type: "string", required: true },
      schema: { type: "json", required: true },
      created_at: { type: "date", required: true },
    },
  },
  // Secrets live in the core surface as metadata (id, display name,
  // provider key). Actual values never touch this table — they live in
  // the secret provider (keychain, 1password, file, etc.) and are
  // resolved on demand via `ctx.secrets.get(id)`.
  //
  // `owned_by_connection_id` ties the row to a connection. Connection-
  // owned secrets are plumbing, not user-facing values: `ctx.secrets.list`
  // filters them out (the user sees the Connection instead), and
  // `ctx.secrets.remove` refuses to delete them (Connection.remove is
  // the single owner of the lifecycle). The FK is nullable so existing
  // "bare" secrets (API keys entered by the user, pre-connection OAuth
  // rows during migration) remain visible and removable unchanged.
  secret: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      name: { type: "string", required: true },
      provider: { type: "string", required: true, index: true },
      owned_by_connection_id: {
        type: "string",
        required: false,
        index: true,
      },
      created_at: { type: "date", required: true },
    },
  },
  // Connections — sign-in state for one identity against one remote
  // provider. A Connection owns one or more `secret` rows (access +
  // refresh tokens, etc.) via `secret.owned_by_connection_id`, and the
  // SDK exposes `ctx.connections.accessToken(id)` which transparently
  // refreshes the backing secrets when they're near expiry. Plugins
  // contribute refresh behavior via `plugin.connectionProviders[].refresh`
  // keyed by `provider`, same pattern as `secretProviders`.
  //
  // `provider_state` is plugin-owned opaque JSON — token endpoint URL,
  // scopes, issuer, auth-server metadata — whatever the provider's
  // refresh handler needs to re-hit the token endpoint. It's NOT
  // sensitive (all secrets go through the provider-backed secret rows);
  // it's just enough metadata to drive a refresh without re-running
  // discovery.
  connection: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      /** Routing key into `plugin.connectionProviders`. OAuth2 connections
       *  use the shared `oauth2` provider. Mirrors `secret.provider`. */
      provider: { type: "string", required: true, index: true },
      /** Display label shown in the Connections UI. Usually the account
       *  email / handle / org name the user signed in as. */
      identity_label: { type: "string", required: false },
      /** Stable id of the access-token secret. Always present. */
      access_token_secret_id: { type: "string", required: true },
      /** Stable id of the refresh-token secret. Null for flows that
       *  don't mint a refresh token (client_credentials, etc.). */
      refresh_token_secret_id: { type: "string", required: false },
      /** Epoch ms when the access token expires. Null if the provider
       *  didn't declare an expiry. Used as the refresh trigger. Stored as
       *  `bigint` because `Date.now()` overflows int32. */
      expires_at: { type: "number", required: false, bigint: true },
      /** Scope string as returned by the token endpoint. */
      scope: { type: "string", required: false },
      /** Opaque plugin-owned JSON — token endpoint URL, scopes list,
       *  discovery hints, etc. Never sensitive. */
      provider_state: { type: "json", required: false },
      created_at: { type: "date", required: true },
      updated_at: { type: "date", required: true },
    },
  },
  // Pending OAuth authorization rows shared by every OAuth-capable plugin.
  // Rows are short-lived and deleted after completion/cancel; the resulting
  // `connection` row is the durable sign-in state.
  oauth2_session: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      plugin_id: { type: "string", required: true, index: true },
      strategy: { type: "string", required: true },
      connection_id: { type: "string", required: true, index: true },
      token_scope: { type: "string", required: true },
      redirect_url: { type: "string", required: true },
      payload: { type: "json", required: true },
      expires_at: { type: "number", required: true, bigint: true },
      created_at: { type: "date", required: true },
    },
  },
  // Shared credential slot bindings. Plugins keep source-specific semantics
  // local, but credential ownership and resolution use one scoped shape.
  credential_binding: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      plugin_id: { type: "string", required: true, index: true },
      source_id: { type: "string", required: true, index: true },
      source_scope_id: { type: "string", required: true, index: true },
      slot_key: { type: "string", required: true, index: true },
      /** "text" | "secret" | "connection". */
      kind: { type: credentialBindingKinds, required: true, index: true },
      text_value: { type: "string", required: false },
      secret_id: { type: "string", required: false, index: true },
      secret_scope_id: { type: "string", required: false, index: true },
      connection_id: { type: "string", required: false, index: true },
      created_at: { type: "date", required: true },
      updated_at: { type: "date", required: true },
    },
  },
  // User-authored overrides for tool permissions. Each row is one rule:
  // a glob-ish pattern + an action (approve / require_approval / block).
  // Resolution walks the scope stack innermost-first, then `position`
  // ascending within each scope; first match wins. Plugin-derived
  // annotations from `resolveAnnotations` apply only when no rule
  // matches.
  //
  // Pattern grammar (v1):
  //   - `*`                  every tool id (universal)
  //   - `vercel.dns.create`  exact tool id
  //   - `vercel.dns.*`       any tool whose id starts with `vercel.dns.`
  //   - `vercel.*`           plugin-wide
  // No `**`, no brace expansion, no leading-`*` prefixes (`*foo`, `*.foo`).
  tool_policy: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      pattern: { type: "string", required: true },
      /** "approve" | "require_approval" | "block". */
      action: { type: "string", required: true },
      /** Fractional-indexing key (Jira lexorank style). Lower lex order =
       *  higher precedence. New rules default to a key generated above
       *  the current minimum. Strings instead of numbers so we can
       *  always lengthen the key to insert between two adjacent rows
       *  without precision loss; see `fractional-indexing` in
       *  `policies.ts`. */
      position: { type: "string", required: true, index: true },
      created_at: { type: "date", required: true },
      updated_at: { type: "date", required: true },
    },
  },
} as const satisfies DBSchema;

export type CoreSchema = typeof coreSchema;

// ---------------------------------------------------------------------------
// Row types — derived from the schema. Adding a field to coreSchema.fields
// adds it to the row type automatically.
// ---------------------------------------------------------------------------

export type SourceRow = InferDBFieldsOutput<CoreSchema["source"]["fields"]> &
  Record<string, unknown>;

export type ToolRow = InferDBFieldsOutput<CoreSchema["tool"]["fields"]> & Record<string, unknown>;

export type DefinitionRow = InferDBFieldsOutput<CoreSchema["definition"]["fields"]> &
  Record<string, unknown>;

export type SecretRow = InferDBFieldsOutput<CoreSchema["secret"]["fields"]> &
  Record<string, unknown>;

export type ConnectionRow = InferDBFieldsOutput<CoreSchema["connection"]["fields"]> &
  Record<string, unknown>;

type CredentialBindingRowFields = InferDBFieldsOutput<CoreSchema["credential_binding"]["fields"]>;
type CredentialBindingRowBase = Omit<
  CredentialBindingRowFields,
  "kind" | "text_value" | "secret_id" | "secret_scope_id" | "connection_id"
>;

export type CredentialBindingRow = CredentialBindingRowBase &
  (
    | {
        kind: "text";
        text_value: string;
      }
    | {
        kind: "secret";
        secret_id: string;
        secret_scope_id?: string;
      }
    | {
        kind: "connection";
        connection_id: string;
      }
  ) &
  Record<string, unknown>;

export type ToolPolicyRow = InferDBFieldsOutput<CoreSchema["tool_policy"]["fields"]> &
  Record<string, unknown>;

// ---------------------------------------------------------------------------
// Tool policy — user-authored override of the default approval behavior.
// `action` tells the executor what to do at invoke time and at search /
// list time:
//   - approve          : skip the upfront approval prompt, just run.
//   - require_approval : force an approval prompt even if the plugin's
//                        annotations would have skipped it.
//   - block            : invisible to search / list, hard-fail at invoke
//                        with `ToolBlockedError`.
// Mid-invocation elicitations (`mayElicit`) are NOT affected by policies.
// ---------------------------------------------------------------------------

export type ToolPolicyAction = "approve" | "require_approval" | "block";

export const TOOL_POLICY_ACTIONS = [
  "approve",
  "require_approval",
  "block",
] as const satisfies readonly ToolPolicyAction[];

export const isToolPolicyAction = (value: unknown): value is ToolPolicyAction =>
  typeof value === "string" && (TOOL_POLICY_ACTIONS as readonly string[]).includes(value);

// ---------------------------------------------------------------------------
// Tool annotations — default-policy metadata the executor consults
// before invocation. Returned by `plugin.resolveAnnotations` (dynamic
// tools) or declared inline on `StaticToolDecl` (static tools). Never
// stored on `tool` rows — every field here is derived at read time
// from plugin-owned data.
//
// OpenAPI derives from HTTP method:
//   - GET / HEAD / OPTIONS → {} (auto-approved)
//   - POST / PUT / PATCH / DELETE → { requiresApproval: true,
//                                     approvalDescription: "DELETE /users/:id" }
//
// MCP derives from the server's tool declaration (mcp has its own
// may-elicit and approval signals).
// ---------------------------------------------------------------------------

export interface ToolAnnotations {
  /** If true, the executor will call the invoke-time elicitation handler
   *  before running the tool and abort if the user declines. */
  readonly requiresApproval?: boolean;
  /** Free-text message shown in the approval prompt. Falls back to the
   *  tool's id / description if unset. */
  readonly approvalDescription?: string;
  /** Hint for UI — tool may suspend to ask the user for input mid-invocation.
   *  Not enforced by the executor; purely a UI signal. */
  readonly mayElicit?: boolean;
}

// ---------------------------------------------------------------------------
// SourceInput — what a plugin passes to `ctx.core.sources.register(...)`.
// Writes both the source row and all its tool rows in one transaction.
// Annotations are NOT part of this input — they're computed from
// plugin-owned data via `plugin.resolveAnnotations` when the executor
// needs them.
// ---------------------------------------------------------------------------

export interface SourceInputTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
}

export interface SourceInput {
  readonly id: string;
  /** Scope id this source belongs to. Must be one of the executor's
   *  configured scopes. Callers (plugins) pick the target scope
   *  explicitly — typically the scope the source was authored against. */
  readonly scope: string;
  readonly kind: string;
  readonly name: string;
  readonly url?: string;
  readonly canRemove?: boolean;
  readonly canRefresh?: boolean;
  readonly canEdit?: boolean;
  readonly tools: readonly SourceInputTool[];
}

// ---------------------------------------------------------------------------
// DefinitionsInput — paired with SourceInput when a plugin registers
// shared JSON-schema `$defs` alongside a source. Usually called inside
// the same `ctx.transaction` as `sources.register` so a failure rolls
// back both the source rows and the def rows.
// ---------------------------------------------------------------------------

export interface DefinitionsInput {
  readonly sourceId: string;
  /** Scope id these definitions belong to — should match the scope of
   *  the source they're registered under. */
  readonly scope: string;
  readonly definitions: Record<string, unknown>;
}
