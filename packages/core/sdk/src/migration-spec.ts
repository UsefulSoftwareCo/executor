// ---------------------------------------------------------------------------
// v1.4.x → v2 migration — pure transform building blocks.
//
// These are the schema-STABLE, side-effect-free pieces of the migration: the
// scope→owner split, the policy-pattern remap, the WorkOS-Vault object naming
// (v1 read name vs v2 write name), the oauth_client dedup key, and OAuth scope
// serialization. The cloud/local RUNNERS read old rows + resolve secret values
// and call these; keeping them pure makes the risky part unit-testable without
// a database. See `personal-notes/migration-notes-5.md` for the full design.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

import { connectionIdentifier } from "./connection-name-identifier";

export {
  migrationOAuthAuthorizationUrlFor,
  migrationOAuthClientAuthorizationUrlResolutionSource,
  migrationOAuthClientNeedsAuthorizationUrlResolution,
  migrationOAuthClientPlanKey,
  resolveMigrationOAuthAuthorizationUrls,
  type MigrationOAuthMetadataFetch,
  type ResolveMigrationOAuthAuthorizationUrlsOptions,
} from "./migration-oauth-metadata";

export type MigrationOwner = "org" | "user";

/** v2 owner partition for a migrated row. `subject` is "" (ORG_SUBJECT) for org. */
export interface OwnerKeys {
  readonly owner: MigrationOwner;
  readonly subject: string;
  readonly tenant: string;
}

const ORG_SUBJECT = "";

// ---------------------------------------------------------------------------
// Scope → (owner, subject, tenant)
//
// v1 scope ids are EXACTLY two shapes in prod (verified across 1,079 rows):
//   - `org_<id>`                    → org-owned (shared); tenant = the org id
//   - `user-org:user_<u>:org_<o>`   → a user's personal scope within an org
// Returns null for any other shape so the runner FAILS LOUD rather than
// silently mis-owning a row (a scope leak is a security bug, not a data bug).
// ---------------------------------------------------------------------------

export const parseScope = (scopeId: string): OwnerKeys | null => {
  if (scopeId.startsWith("user-org:")) {
    const parts = scopeId.split(":");
    if (parts.length !== 3) return null;
    const [, user, org] = parts;
    if (!user || !org || !user.startsWith("user_") || !org.startsWith("org_")) return null;
    return { owner: "user", subject: user, tenant: org };
  }
  if (scopeId.startsWith("org_") && !scopeId.includes(":")) {
    return { owner: "org", subject: ORG_SUBJECT, tenant: scopeId };
  }
  return null;
};

export type ScopeOwnerResolver = (scopeId: string) => OwnerKeys | null;

/** Stable string identifying the partition an oauth_client is deduped within —
 *  shared org apps collapse across the org, personal apps stay per-user. */
export const ownerPartitionKey = (keys: OwnerKeys): string =>
  keys.owner === "org" ? `org:${keys.tenant}` : `user:${keys.subject}:${keys.tenant}`;

// ---------------------------------------------------------------------------
// WorkOS Vault object naming.
//
// v1 stored a secret value at `executor/<scopeId>/secrets/<secretId>` (with a
// per-scope KEK), url-encoding the segments — plus a LEGACY un-encoded fallback.
// v2 drops the scope segment (flat KEK): `executor/secrets/<itemId>`. The names
// differ, so id-reuse is impossible — the runner reads the v1 object and
// re-writes a fresh v2 object (+ a `plugin_storage[metadata]` row).
// ---------------------------------------------------------------------------

export const DEFAULT_VAULT_PREFIX = "executor";
const enc = encodeURIComponent;

export const vaultV1ObjectName = (prefix: string, scopeId: string, secretId: string): string =>
  `${prefix}/${enc(scopeId)}/secrets/${enc(secretId)}`;

/** The legacy un-url-encoded variant v1 falls back to on a 404. */
export const vaultV1LegacyObjectName = (
  prefix: string,
  scopeId: string,
  secretId: string,
): string => `${prefix}/${scopeId}/secrets/${secretId}`;

export const vaultV2ObjectName = (prefix: string, itemId: string): string =>
  `${prefix}/secrets/${enc(itemId)}`;

// ---------------------------------------------------------------------------
// oauth_client dedup key — collapse identical apps (BYO means mostly distinct,
// so this only merges a handful). Keyed on the owner partition + client id +
// token endpoint. NUL-separated so no value can forge a collision.
// ---------------------------------------------------------------------------

export const oauthClientDedupKey = (
  partition: string,
  clientId: string,
  tokenEndpoint: string,
): string => `${partition} ${clientId} ${tokenEndpoint}`;

// ---------------------------------------------------------------------------
// OAuth scope serialization — v1 `provider_state.scopes` is a JSON array;
// v2 `connection.oauth_scope` is a single space-joined string (round-trips:
// split on `\s+` at refresh). Order-preserving de-dupe; space-join is lossless
// because no scope value contains a space.
// ---------------------------------------------------------------------------

export const serializeOAuthScopes = (scopes: readonly string[]): string =>
  [...new Set(scopes.filter((s) => s.length > 0))].join(" ");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------
// Policy pattern migration.
//
// v1 patterns match a connection-AGNOSTIC `<source>.<tool>` id. v2 matches the
// FULL `<integration>.<owner>.<connection>.<tool>`, so a migrated policy applies
// across ALL connections → wildcard the owner+connection segments. The
// whole-integration (`<slug>.*`) and bare-slug forms already cover the deeper
// segments via their trailing `*`, so they only get the slug remapped.
//
//   - `*`                       → `*`                              (universal)
//   - static ns (`executor.*`)  → unchanged                       (pass-through)
//   - `<slug>` / `<slug>.*`     → `<newSlug>` / `<newSlug>.*`      (subtree)
//   - `<slug>.<rest>`           → `<newSlug>.*.*.<rest>`           (insert wildcards)
//   - unknown first segment     → DEAD (source removed) — flag, never silently drop
// ---------------------------------------------------------------------------

export const DEFAULT_STATIC_NAMESPACES: readonly string[] = ["executor", "openapi"];

export type PolicyTransformResult =
  | { readonly kind: "ok"; readonly pattern: string }
  | { readonly kind: "static"; readonly pattern: string }
  | { readonly kind: "dead"; readonly slug: string };

export const migratePolicyPattern = (
  pattern: string,
  slugMap: ReadonlyMap<string, string>,
  staticNamespaces: readonly string[] = DEFAULT_STATIC_NAMESPACES,
): PolicyTransformResult => {
  if (pattern === "*") return { kind: "ok", pattern: "*" };
  const firstDot = pattern.indexOf(".");
  const slug = firstDot === -1 ? pattern : pattern.slice(0, firstDot);
  if (staticNamespaces.includes(slug)) return { kind: "static", pattern };
  const newSlug = slugMap.get(slug);
  if (newSlug === undefined) return { kind: "dead", slug };
  const rest = firstDot === -1 ? "" : pattern.slice(firstDot + 1);
  if (rest === "") return { kind: "ok", pattern: newSlug };
  if (rest === "*") return { kind: "ok", pattern: `${newSlug}.*` };
  return { kind: "ok", pattern: `${newSlug}.*.*.${rest}` };
};

// ---------------------------------------------------------------------------
// Plugin runtime metadata migration.
//
// v1 plugins persisted invocation metadata in plugin-specific storage alongside
// source rows. v2 puts catalog-level operation metadata under org-owned
// `plugin_storage[operation]`, and MCP stores the raw upstream tool name on the
// tool row annotations. These helpers are shared by local + cloud runners so the
// migration produces the same v2-native runtime shape everywhere.
// ---------------------------------------------------------------------------

const GRAPHQL_GREENFIELD_V1_PLUGIN_ID = "graphql-greenfield";
const GRAPHQL_V2_PLUGIN_ID = "graphql";
const OPENAPI_PLUGIN_ID = "openapi";
const MCP_PLUGIN_ID = "mcp";
const OPERATION_COLLECTION = "operation";
const MCP_BINDING_COLLECTION = "binding";

const normalizeRuntimePluginId = (pluginId: string): string =>
  pluginId === GRAPHQL_GREENFIELD_V1_PLUGIN_ID ? GRAPHQL_V2_PLUGIN_ID : pluginId;

export interface V1ToolRuntimeMetadataRow {
  readonly scopeId: string;
  readonly sourceId: string;
  readonly pluginId: string;
  readonly name: string;
  readonly annotations: unknown;
}

export interface V1PluginStorageRuntimeRow {
  readonly scopeId: string;
  readonly pluginId: string;
  readonly collection: string;
  readonly key: string;
  readonly data: unknown;
}

export interface LegacyMcpToolBinding {
  readonly toolName: string;
  readonly annotations?: Record<string, unknown>;
}

export interface V1RuntimeMetadataIndex {
  readonly mcpBindings: ReadonlyMap<string, LegacyMcpToolBinding>;
}

export type MigratedPluginStorageOwner = "source" | "catalog";

export interface MigratedPluginStorageRuntimeRow {
  readonly pluginId: string;
  readonly collection: string;
  readonly key: string;
  readonly data: unknown;
  /** `catalog` rows are v2 integration metadata and must be org-owned. */
  readonly owner: MigratedPluginStorageOwner;
}

const runtimeStorageKey = (scopeId: string, key: string): string => `${scopeId}\0${key}`;

const fullToolKey = (sourceId: string, toolName: string): string => `${sourceId}.${toolName}`;

const stripToolPrefix = (sourceId: string, toolId: string): string =>
  toolId.startsWith(`${sourceId}.`) ? toolId.slice(sourceId.length + 1) : toolId;

const legacyMcpToolBinding = (data: unknown): LegacyMcpToolBinding | null => {
  if (!isRecord(data) || !isRecord(data.binding)) return null;
  const toolName = data.binding.toolName;
  if (typeof toolName !== "string" || toolName.length === 0) return null;
  const annotations = isRecord(data.binding.annotations) ? data.binding.annotations : undefined;
  return {
    toolName,
    ...(annotations ? { annotations } : {}),
  };
};

export const buildV1RuntimeMetadataIndex = (
  rows: readonly V1PluginStorageRuntimeRow[],
): V1RuntimeMetadataIndex => {
  const mcpBindings = new Map<string, LegacyMcpToolBinding>();
  for (const row of rows) {
    if (normalizeRuntimePluginId(row.pluginId) !== MCP_PLUGIN_ID) continue;
    if (row.collection !== MCP_BINDING_COLLECTION) continue;
    const binding = legacyMcpToolBinding(row.data);
    if (!binding) continue;
    mcpBindings.set(runtimeStorageKey(row.scopeId, row.key), binding);
  }
  return { mcpBindings };
};

export const migrateV1ToolAnnotations = (
  tool: V1ToolRuntimeMetadataRow,
  index: V1RuntimeMetadataIndex,
): unknown => {
  if (normalizeRuntimePluginId(tool.pluginId) !== MCP_PLUGIN_ID) return tool.annotations;
  if (isRecord(tool.annotations) && isRecord(tool.annotations.mcp)) return tool.annotations;

  const binding = index.mcpBindings.get(
    runtimeStorageKey(tool.scopeId, fullToolKey(tool.sourceId, tool.name)),
  );
  if (!binding) return tool.annotations;

  const base = isRecord(tool.annotations) ? tool.annotations : {};
  const destructive = binding.annotations?.destructiveHint === true;
  return {
    ...base,
    requiresApproval: base.requiresApproval ?? destructive,
    ...(destructive && base.approvalDescription === undefined
      ? { approvalDescription: binding.annotations?.title ?? binding.toolName }
      : {}),
    mcp: {
      toolName: binding.toolName,
      ...(binding.annotations ? { upstream: binding.annotations } : {}),
    },
  };
};

const migrateOperationStorageRow = (
  row: V1PluginStorageRuntimeRow,
): MigratedPluginStorageRuntimeRow | null => {
  const pluginId = normalizeRuntimePluginId(row.pluginId);
  if (
    row.collection !== OPERATION_COLLECTION ||
    (pluginId !== OPENAPI_PLUGIN_ID && pluginId !== GRAPHQL_V2_PLUGIN_ID)
  ) {
    return null;
  }
  if (!isRecord(row.data)) return null;

  const existingIntegration = row.data.integration;
  const existingToolName = row.data.toolName;
  if (
    typeof existingIntegration === "string" &&
    typeof existingToolName === "string" &&
    "binding" in row.data
  ) {
    return {
      pluginId,
      collection: row.collection,
      key: fullToolKey(existingIntegration, existingToolName),
      data: {
        integration: existingIntegration,
        toolName: existingToolName,
        binding: row.data.binding,
      },
      owner: "catalog",
    };
  }

  const sourceId = row.data.sourceId;
  const toolId = row.data.toolId;
  if (typeof sourceId !== "string" || typeof toolId !== "string" || !("binding" in row.data)) {
    return null;
  }

  const toolName = stripToolPrefix(sourceId, toolId);
  return {
    pluginId,
    collection: row.collection,
    key: fullToolKey(sourceId, toolName),
    data: {
      integration: sourceId,
      toolName,
      binding: row.data.binding,
    },
    owner: "catalog",
  };
};

export const migrateV1PluginStorageRuntimeRow = (
  row: V1PluginStorageRuntimeRow,
): MigratedPluginStorageRuntimeRow => {
  const operation = migrateOperationStorageRow(row);
  if (operation) return operation;
  return {
    pluginId: normalizeRuntimePluginId(row.pluginId),
    collection: row.collection,
    key: row.key,
    data: row.data,
    owner: "source",
  };
};

// ---------------------------------------------------------------------------
// OpenAPI auth template migration — v1 source `config` auth → v2
// `authenticationTemplate` (Authentication[]) + the static header/query
// passthrough + the slot→method-slug map the connection pass needs.
//
// v1 shapes (verified against prod):
//   - `config.headers` / `config.queryParams`: `Record<name, V1ConfiguredValue>`
//     where a value is either a literal string (a STATIC header) or a credential
//     placement `{ kind, slot?, prefix? }`. v1 applied EVERY configured credential
//     placement on every request, rendering `prefix ? prefix+value : value`.
//   - `config.oauth2`: the user-configured OAuth method (real urls/scopes/scheme).
//
// v2 model: each connection holds ONE value, rendered ONLY into the `token`
// variable (any other variable name renders to ""). So a source with a SINGLE
// credential placement maps cleanly to one apiKey method `{name: [prefix, token]}`;
// a source with >1 distinct credential placement (Datadog dd-api-key +
// dd-application-key; GitHub authorization + user-agent) has no faithful
// single-connection v2 form — we flag `needsReview` and never silently emit a
// template that would render a second credential as "".
// ---------------------------------------------------------------------------

/** A v1 `config.headers` / `config.queryParams` entry. A bare string is a static
 *  value; the object forms are credential placements that pull from a binding /
 *  secret / inline text, optionally with a literal `prefix` (e.g. `"Bearer "`). */
export type V1ConfiguredValue =
  | string
  | { readonly kind: "binding"; readonly slot: string; readonly prefix?: string }
  | { readonly kind: "secret"; readonly secretId?: string; readonly prefix?: string }
  | { readonly kind: "text"; readonly text: string; readonly prefix?: string };

export interface V1OAuth2Config {
  readonly securitySchemeName: string;
  readonly flow?: string;
  readonly authorizationUrl?: string;
  readonly tokenUrl: string;
  readonly scopes?: readonly string[];
}

export interface V1OpenApiAuthConfig {
  readonly headers?: Record<string, V1ConfiguredValue>;
  readonly queryParams?: Record<string, V1ConfiguredValue>;
  readonly oauth2?: V1OAuth2Config;
}

/** A part-array template value: `prefix ? [prefix, token] : [token]`. */
export type TemplatePart = string | { readonly type: "variable"; readonly name: string };

export interface MigratedApiKeyAuth {
  readonly slug: string;
  readonly type: "apiKey";
  readonly headers?: Record<string, readonly TemplatePart[]>;
  readonly queryParams?: Record<string, readonly TemplatePart[]>;
}

export interface MigratedOAuthAuth {
  readonly slug: string;
  readonly type: "oauth";
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly scopes: readonly string[];
}

export type MigratedAuthentication = MigratedApiKeyAuth | MigratedOAuthAuth;

export interface OpenApiAuthTemplateResult {
  readonly authenticationTemplate: readonly MigratedAuthentication[];
  /** Literal-string header/query entries — passed through to v2 `config`. */
  readonly staticHeaders: Record<string, string>;
  readonly staticQueryParams: Record<string, string>;
  /** v1 binding `slot_key` → the v2 method `slug` that consumes it. The
   *  connection pass uses this to set `connection.template`. */
  readonly slotToTemplateSlug: Record<string, string>;
  /** v1 binding `slot_key` → the v2 input variable its resolved secret fills. The
   *  connection migration writes one `item_ids` entry per (variable → secret), so
   *  a two-secret source (e.g. Datadog) lands both keys on one connection. */
  readonly slotToVariable: Record<string, string>;
  readonly warnings: readonly string[];
}

/** The single apiKey method slug — one apiKey method per source, so a constant
 *  is unique within the integration and every credential slot maps to it. */
export const API_KEY_TEMPLATE_SLUG = "apiKey";

/** The canonical variable for a single-input source. Multiple inputs derive
 *  distinct names instead (so a connection can carry both of e.g. Datadog's
 *  keys). Matches the runtime default in `connection.ts` / the plugins. */
export const PRIMARY_INPUT_VARIABLE = "token";

const isCredentialPlacement = (
  value: V1ConfiguredValue,
): value is Exclude<V1ConfiguredValue, string> => typeof value !== "string";

/** Slugify a header/query name into a stable variable identifier:
 *  `DD-API-KEY` → `dd_api_key`. */
const slugifyVariable = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

interface Placement {
  readonly carrier: "header" | "query";
  readonly name: string;
  readonly prefix?: string;
  readonly slot?: string;
}

export const migrateOpenApiAuthTemplate = (
  config: V1OpenApiAuthConfig,
): OpenApiAuthTemplateResult => {
  const template: MigratedAuthentication[] = [];
  const staticHeaders: Record<string, string> = {};
  const staticQueryParams: Record<string, string> = {};
  const slotToTemplateSlug: Record<string, string> = {};
  const slotToVariable: Record<string, string> = {};
  const warnings: string[] = [];

  // First pass — separate credential placements from static literals.
  const placements: Placement[] = [];
  for (const [name, value] of Object.entries(config.headers ?? {})) {
    if (isCredentialPlacement(value)) {
      placements.push({
        carrier: "header",
        name,
        prefix: value.prefix,
        slot: value.kind === "binding" ? value.slot : undefined,
      });
    } else {
      staticHeaders[name] = value;
    }
  }
  for (const [name, value] of Object.entries(config.queryParams ?? {})) {
    if (isCredentialPlacement(value)) {
      placements.push({
        carrier: "query",
        name,
        prefix: value.prefix,
        slot: value.kind === "binding" ? value.slot : undefined,
      });
    } else {
      staticQueryParams[name] = value;
    }
  }

  // Variable per placement: a lone input is the canonical `token`; multiple
  // inputs each get a distinct slugified variable (collision-suffixed) so a
  // connection carries one value per key.
  const taken = new Set<string>();
  const variableFor = (placement: Placement): string => {
    if (placements.length <= 1) return PRIMARY_INPUT_VARIABLE;
    const base = slugifyVariable(placement.name) || "input";
    let candidate = base;
    let n = 2;
    while (taken.has(candidate)) candidate = `${base}_${n++}`;
    taken.add(candidate);
    return candidate;
  };

  const apiKeyHeaders: Record<string, readonly TemplatePart[]> = {};
  const apiKeyQueryParams: Record<string, readonly TemplatePart[]> = {};
  for (const placement of placements) {
    const variable = variableFor(placement);
    const part: TemplatePart = { type: "variable", name: variable };
    const parts: readonly TemplatePart[] =
      placement.prefix && placement.prefix.length > 0 ? [placement.prefix, part] : [part];
    if (placement.carrier === "header") apiKeyHeaders[placement.name] = parts;
    else apiKeyQueryParams[placement.name] = parts;
    if (placement.slot) {
      slotToTemplateSlug[placement.slot] = API_KEY_TEMPLATE_SLUG;
      slotToVariable[placement.slot] = variable;
    }
  }

  if (placements.length > 0) {
    template.push({
      slug: API_KEY_TEMPLATE_SLUG,
      type: "apiKey",
      ...(Object.keys(apiKeyHeaders).length > 0 ? { headers: apiKeyHeaders } : {}),
      ...(Object.keys(apiKeyQueryParams).length > 0 ? { queryParams: apiKeyQueryParams } : {}),
    });
  }

  if (config.oauth2) {
    const o = config.oauth2;
    template.push({
      slug: o.securitySchemeName,
      type: "oauth",
      authorizationUrl: o.authorizationUrl ?? "",
      tokenUrl: o.tokenUrl,
      scopes: o.scopes ?? [],
    });
    // The oauth connection slot binds to the oauth method, not the apiKey one;
    // OAuth is single-input, so its value fills the `token` variable.
    const slot = `oauth2:${o.securitySchemeName.toLowerCase()}:connection`;
    slotToTemplateSlug[slot] = o.securitySchemeName;
    slotToVariable[slot] = PRIMARY_INPUT_VARIABLE;
  }

  return {
    authenticationTemplate: template,
    staticHeaders,
    staticQueryParams,
    slotToTemplateSlug,
    slotToVariable,
    warnings,
  };
};

// ---------------------------------------------------------------------------
// OAuth grant mapping + C1a synthetic expiry.
//
// v1 `connection.provider_state.kind` is authorization-code / dynamic-dcr /
// client-credentials; v2 collapses to two grants. A client_credentials token
// re-mints with NO user, so a v1 connection whose provider omitted `expires_in`
// (null v1 expiry) gets a short synthetic `expires_at` at migrate time — purely
// so the v2 refresh gate fires and re-mints, NOT a general TTL policy. A
// connection that carried a real v1 expiry keeps it.
// ---------------------------------------------------------------------------

export type V1ConnectionKind = "authorization-code" | "dynamic-dcr" | "client-credentials";
export type MigrationGrant = "authorization_code" | "client_credentials";

export const migrateGrant = (kind: V1ConnectionKind): MigrationGrant =>
  kind === "client-credentials" ? "client_credentials" : "authorization_code";

/** 1h — synthetic TTL for client_credentials connections whose v1 provider
 *  omitted `expires_in`. Re-mint is userless + cheap, so hourly churn is fine. */
export const SYNTHETIC_CLIENT_CREDENTIALS_TTL_MS = 60 * 60 * 1000;

export const migrateExpiresAt = (input: {
  readonly grant: MigrationGrant;
  readonly v1ExpiresAt: number | null;
  readonly nowMs: number;
}): number | null =>
  input.grant === "client_credentials" && input.v1ExpiresAt == null
    ? input.nowMs + SYNTHETIC_CLIENT_CREDENTIALS_TTL_MS
    : input.v1ExpiresAt;

// ---------------------------------------------------------------------------
// Source config → v2 integration config.
//
// v1 per-kind config lives in `plugin_storage[collection=source].data` (openapi
// + mcp nest under `.data.config`; graphql is flat at `.data`). Structural fields
// copy near-1:1; the only real conversion is v1 auth → v2 auth. openapi reuses
// `migrateOpenApiAuthTemplate` (the static headers/queryParams + the template);
// mcp/graphql carry only an `auth.kind` (none/oauth2) — the connection slot is
// dropped (a v2 connection IS the credential). `namespace` is dropped (the
// integration slug replaces it).
// ---------------------------------------------------------------------------

export interface V1OpenApiSourceConfig extends V1OpenApiAuthConfig {
  readonly spec?: string;
  readonly sourceUrl?: string;
  readonly baseUrl?: string;
  readonly googleDiscoveryUrls?: readonly string[];
}

export interface V2OpenApiIntegrationConfig {
  readonly spec?: string;
  readonly sourceUrl?: string;
  readonly baseUrl?: string;
  readonly googleDiscoveryUrls?: readonly string[];
  readonly headers?: Record<string, string>;
  readonly queryParams?: Record<string, string>;
  readonly authenticationTemplate?: readonly MigratedAuthentication[];
}

export interface MigratedSourceConfig {
  /** The opaque v2 `integration.config` blob (openapi/mcp/graphql shaped). */
  readonly config: unknown;
  /** v1 binding `slot_key` → the v2 method slug it feeds (connection migration). */
  readonly slotToTemplateSlug: Record<string, string>;
  /** v1 binding `slot_key` → the v2 input variable its secret fills. */
  readonly slotToVariable: Record<string, string>;
  readonly warnings: readonly string[];
}

export const migrateOpenApiSourceConfig = (v1: V1OpenApiSourceConfig): MigratedSourceConfig => {
  const auth = migrateOpenApiAuthTemplate(v1);
  const config: V2OpenApiIntegrationConfig = {
    ...(v1.spec !== undefined ? { spec: v1.spec } : {}),
    ...(v1.sourceUrl !== undefined ? { sourceUrl: v1.sourceUrl } : {}),
    ...(v1.baseUrl !== undefined ? { baseUrl: v1.baseUrl } : {}),
    ...(v1.googleDiscoveryUrls !== undefined
      ? { googleDiscoveryUrls: v1.googleDiscoveryUrls }
      : {}),
    ...(Object.keys(auth.staticHeaders).length > 0 ? { headers: auth.staticHeaders } : {}),
    ...(Object.keys(auth.staticQueryParams).length > 0
      ? { queryParams: auth.staticQueryParams }
      : {}),
    ...(auth.authenticationTemplate.length > 0
      ? { authenticationTemplate: auth.authenticationTemplate }
      : {}),
  };
  return {
    config,
    slotToTemplateSlug: auth.slotToTemplateSlug,
    slotToVariable: auth.slotToVariable,
    warnings: auth.warnings,
  };
};

/** v1 mcp/graphql `auth` block. The oauth2 form carries a `connectionSlot` that
 *  bound a credential_binding; v2 drops it (the connection is the credential). */
export type V1SourceAuth =
  | { readonly kind: "none" }
  | { readonly kind: "oauth2"; readonly connectionSlot?: string };

export type V2SourceAuth = { readonly kind: "none" } | { readonly kind: "oauth2" };

export const migrateSourceAuth = (auth: V1SourceAuth | undefined): V2SourceAuth =>
  auth?.kind === "oauth2" ? { kind: "oauth2" } : { kind: "none" };

// ---------------------------------------------------------------------------
// Secret-role classification.
//
// Each v1 secret resolves to a v2 target keyed by HOW it is referenced. The
// runner builds the reference graph (connection token columns, provider_state
// client creds, credential_binding slots) and asks the classifier per secret.
// Roles map to: oauth-access/apikey → `connection.item_id`; oauth-refresh →
// `connection.refresh_item_id`; client-secret → `oauth_client.client_secret_item_id`;
// client-id → `oauth_client.client_id` (a PLAINTEXT column, not a vault item);
// orphan → a standalone re-keyed vault object (migrate-all default).
// ---------------------------------------------------------------------------

export type SecretRole =
  | "oauth-access"
  | "oauth-refresh"
  | "apikey"
  | "client-secret"
  | "client-id"
  | "orphan";

/** Classify a credential_binding `slot_key` into its v2 secret role. v1 slot
 *  shapes: `header:<name>` / `query_param:<name>` / `spec_fetch_header:<name>`
 *  (api key), `oauth2:<strat>:client-secret` / `:client-id` (BYO client creds),
 *  `oauth2:<strat>:connection` / `auth:oauth2:connection` (the oauth token — a
 *  `kind=connection` binding, not a secret; classified oauth-access for the rare
 *  cases it is secret-backed). */
export const classifyBindingSlot = (slotKey: string): SecretRole => {
  if (slotKey.includes("client-secret")) return "client-secret";
  if (slotKey.includes("client-id")) return "client-id";
  if (
    slotKey.startsWith("header:") ||
    slotKey.startsWith("query_param:") ||
    slotKey.startsWith("spec_fetch_header:")
  ) {
    return "apikey";
  }
  if (slotKey.endsWith(":connection")) return "oauth-access";
  return "apikey";
};

// ---------------------------------------------------------------------------
// oauth_client dedup (190 → 173).
//
// v1 BYO apps are mostly distinct, but identical apps within an owner partition
// collapse to one v2 `oauth_client`. When v1 already has a plaintext client ID,
// the dedup key is `(owner-partition, clientId, tokenEndpoint)`. Older rows can
// store the client ID as a secret; those dedupe by the source secret reference
// until the runner resolves the plaintext value for `oauth_client.client_id`.
// The assigned slug is derived from the token endpoint host, collision-suffixed
// WITHIN the partition, and deterministic given input order — so a re-run
// produces the same slugs. Each connection later points at its client by
// `(slug, owner)`.
// ---------------------------------------------------------------------------

export interface SecretReadRef {
  readonly scopeId: string;
  readonly secretId: string;
  readonly provider: string;
}

/** A v1 OAuth app to fold into the v2 `oauth_client` set. `clientIdSecretRef`
 *  carries legacy client IDs that v1 stored as secrets; runners resolve it into
 *  the v2 plaintext `oauth_client.client_id` column. `clientSecretRef` is an
 *  opaque handle (e.g. the v1 secret id/scope pair) the runner resolves to the
 *  actual secret value when writing the vault item; null for public/PKCE apps. */
export interface PlannedOAuthClientInput {
  readonly ownerKeys: OwnerKeys;
  readonly clientId: string;
  readonly clientIdSecretRef?: SecretReadRef | null;
  readonly tokenUrl: string;
  readonly authorizationUrl: string;
  readonly authorizationServerMetadataUrl?: string | null;
  readonly grant: MigrationGrant;
  readonly resource: string | null;
  readonly clientSecretRef: string | null;
}

export interface DedupedOAuthClient extends PlannedOAuthClientInput {
  readonly slug: string;
}

export interface OAuthClientDedupResult {
  readonly clients: readonly DedupedOAuthClient[];
  /** dedup key → assigned slug; the connection planner maps each v1 app to it. */
  readonly slugByDedupKey: Record<string, string>;
}

const hostSlug = (url: string): string => {
  // Parse defensively — a malformed URL falls back to a generic stem.
  const match = /^[a-z]+:\/\/([^/:]+)/i.exec(url);
  const host = match?.[1] ?? "client";
  const label = host.split(".").length > 1 ? host.split(".").slice(-2, -1)[0] : host;
  return slugifyVariable(label ?? "client") || "client";
};

export const dedupeOAuthClients = (
  inputs: readonly PlannedOAuthClientInput[],
): OAuthClientDedupResult => {
  const slugByDedupKey: Record<string, string> = {};
  const clients: DedupedOAuthClient[] = [];
  // Per-partition taken slugs, so two distinct apps in one partition disambiguate.
  const takenByPartition = new Map<string, Set<string>>();

  for (const input of inputs) {
    const partition = ownerPartitionKey(input.ownerKeys);
    const key = oauthClientPlanDedupKey(input);
    if (slugByDedupKey[key]) continue; // already folded — identical app

    const taken = takenByPartition.get(partition) ?? new Set<string>();
    const base = hostSlug(input.tokenUrl);
    let slug = base;
    let n = 2;
    while (taken.has(slug)) slug = `${base}_${n++}`;
    taken.add(slug);
    takenByPartition.set(partition, taken);

    slugByDedupKey[key] = slug;
    clients.push({ ...input, slug });
  }

  return { clients, slugByDedupKey };
};

const secretReadRefKey = (ref: SecretReadRef): string =>
  `${ref.provider}\0${ref.scopeId}\0${ref.secretId}`;

const oauthClientDedupeIdentity = (input: {
  readonly clientId: string;
  readonly clientIdSecretRef?: SecretReadRef | null;
}): string =>
  input.clientId.length > 0
    ? `literal:${input.clientId}`
    : input.clientIdSecretRef
      ? `secret:${secretReadRefKey(input.clientIdSecretRef)}`
      : "missing:";

const oauthClientPlanDedupKey = (input: {
  readonly ownerKeys: OwnerKeys;
  readonly clientId: string;
  readonly clientIdSecretRef?: SecretReadRef | null;
  readonly tokenUrl: string;
}): string =>
  oauthClientDedupKey(
    ownerPartitionKey(input.ownerKeys),
    oauthClientDedupeIdentity(input),
    input.tokenUrl,
  );

/** The dedup key for a v1 app — call with the same parts to look its slug up in
 *  `slugByDedupKey` when planning the connection that uses it. Secret-backed v1
 *  client IDs use their source secret reference so distinct BYO apps do not
 *  collapse before the runner can resolve plaintext values. */
export const oauthClientSlugKey = (input: {
  readonly ownerKeys: OwnerKeys;
  readonly clientId: string;
  readonly clientIdSecretRef?: SecretReadRef | null;
  readonly tokenUrl: string;
}): string => oauthClientPlanDedupKey(input);

// ---------------------------------------------------------------------------
// Integration + connection row assembly (the v2 rows, minus resolved secret
// values — the runner fills `item_ids`/`client_secret` from its secret-op pass).
// ---------------------------------------------------------------------------

export interface PlannedIntegrationRow {
  readonly tenant: string;
  readonly owner: MigrationOwner;
  readonly subject: string;
  readonly slug: string;
  readonly plugin_id: string;
  readonly description: string;
  readonly config: unknown;
}

/** Build a v2 `integration` row from a v1 source + its migrated config. All prod
 *  sources are org-owned, but we derive owner from the scope generically (a local
 *  user-scoped source maps to owner=user). */
export const planIntegrationRow = (input: {
  readonly scopeId: string;
  readonly sourceId: string;
  readonly pluginId: string;
  readonly description: string;
  readonly config: unknown;
  readonly ownerForScope?: ScopeOwnerResolver;
}): PlannedIntegrationRow | null => {
  const keys = (input.ownerForScope ?? parseScope)(input.scopeId);
  if (!keys) return null; // fail loud upstream — never silently mis-own
  return {
    tenant: keys.tenant,
    owner: keys.owner,
    subject: keys.subject,
    slug: input.sourceId,
    plugin_id: input.pluginId,
    description: input.description,
    config: input.config,
  };
};

export interface PlannedConnectionRow {
  readonly tenant: string;
  readonly owner: MigrationOwner;
  readonly subject: string;
  readonly integration: string;
  readonly name: string;
  readonly template: string;
  readonly provider: string;
  readonly identityLabel: string | null;
  readonly oauthClientSlug: string | null;
  readonly oauthClientOwner: MigrationOwner | null;
  readonly oauthScope: string | null;
  readonly expiresAt: number | null;
}

/** Build a v2 `connection` row (owner split, C1a expiry, oauth-client ref). The
 *  runner attaches `item_ids`/`refresh_item_id` from its secret-op results. */
export const planConnectionRow = (input: {
  readonly scopeId: string;
  readonly integration: string;
  readonly name: string;
  readonly template: string;
  readonly provider: string;
  readonly identityLabel: string | null;
  readonly grant: MigrationGrant;
  readonly v1ExpiresAt: number | null;
  readonly oauthScopes: readonly string[];
  readonly oauthClientSlug: string | null;
  readonly oauthClientOwner: OwnerKeys | null;
  readonly nowMs: number;
  readonly ownerForScope?: ScopeOwnerResolver;
}): PlannedConnectionRow | null => {
  const keys = (input.ownerForScope ?? parseScope)(input.scopeId);
  if (!keys) return null;
  return {
    tenant: keys.tenant,
    owner: keys.owner,
    subject: keys.subject,
    integration: input.integration,
    name: input.name,
    template: input.template,
    provider: input.provider,
    identityLabel: input.identityLabel,
    oauthClientSlug: input.oauthClientSlug,
    oauthClientOwner: input.oauthClientOwner ? input.oauthClientOwner.owner : null,
    oauthScope: input.oauthScopes.length > 0 ? serializeOAuthScopes(input.oauthScopes) : null,
    expiresAt: migrateExpiresAt({
      grant: input.grant,
      v1ExpiresAt: input.v1ExpiresAt,
      nowMs: input.nowMs,
    }),
  };
};

// ---------------------------------------------------------------------------
// Deterministic v2 item id.
//
// A v2 vault item id is derived from the v1 `(scopeId, secretId)` pair (NOT
// random) so a crashed/re-run migration produces the SAME id and the runner's
// `provider.get(item_id)` skip-if-present idempotency holds. Distinct from any
// v1 name, so it never collides with a not-yet-migrated object. The id carries
// no legacy scope/secret names; the prefix only gives provider lists a stable
// shape.
// ---------------------------------------------------------------------------

const stableMigrationHash = (...parts: readonly string[]): string => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("base64url");
};

export const migratedItemId = (scopeId: string, secretId: string): string =>
  `secret_${stableMigrationHash(scopeId, secretId)}`;

const fallbackPolicyId = (scopeId: string, pattern: string, action: string): string =>
  `policy_${stableMigrationHash(scopeId, pattern, action)}`;

// ---------------------------------------------------------------------------
// mcp / graphql source config → v2 integration config.
//
// Verified against prod: mcp/graphql carry the SAME `{kind:"binding", slot,
// prefix}` header/queryParam shape as openapi (so the apiKey template reuses
// `migrateOpenApiAuthTemplate`), plus an `auth:{kind:"none"|"oauth2",
// connectionSlot?}` block. The oauth method has no securitySchemeName (unlike
// openapi), so its template slug is the conventional `oauth2`; its real
// endpoints/scopes live on the connection's `provider_state`, not the config.
// ---------------------------------------------------------------------------

/** The conventional oauth method slug for mcp/graphql (which carry no
 *  securitySchemeName). A connection's `template` points at it. */
export const OAUTH_TEMPLATE_SLUG = "oauth2";

export interface V1McpSourceConfig {
  readonly endpoint?: string;
  readonly transport?: string;
  readonly remoteTransport?: string;
  readonly headers?: Record<string, V1ConfiguredValue>;
  readonly queryParams?: Record<string, V1ConfiguredValue>;
  readonly auth?: V1SourceAuth;
}

export interface V1GraphqlSourceConfig {
  readonly endpoint?: string;
  readonly name?: string;
  readonly headers?: Record<string, V1ConfiguredValue>;
  readonly queryParams?: Record<string, V1ConfiguredValue>;
  readonly auth?: V1SourceAuth;
}

/** Fold a v1 `auth:{kind:oauth2, connectionSlot}` into the slot maps so the
 *  connection that binds that slot resolves to the conventional oauth method. */
const withSourceAuthOauth = (
  auth: V1SourceAuth | undefined,
  slotToTemplateSlug: Record<string, string>,
  slotToVariable: Record<string, string>,
): void => {
  if (auth?.kind === "oauth2" && auth.connectionSlot) {
    slotToTemplateSlug[auth.connectionSlot] = OAUTH_TEMPLATE_SLUG;
    slotToVariable[auth.connectionSlot] = PRIMARY_INPUT_VARIABLE;
  }
};

export const migrateMcpSourceConfig = (v1: V1McpSourceConfig): MigratedSourceConfig => {
  const apikey = migrateOpenApiAuthTemplate({ headers: v1.headers, queryParams: v1.queryParams });
  const slotToTemplateSlug = { ...apikey.slotToTemplateSlug };
  const slotToVariable = { ...apikey.slotToVariable };
  withSourceAuthOauth(v1.auth, slotToTemplateSlug, slotToVariable);
  const config = {
    ...(v1.endpoint !== undefined ? { endpoint: v1.endpoint } : {}),
    ...(v1.transport !== undefined ? { transport: v1.transport } : {}),
    ...(v1.remoteTransport !== undefined ? { remoteTransport: v1.remoteTransport } : {}),
    ...(Object.keys(apikey.staticHeaders).length > 0 ? { headers: apikey.staticHeaders } : {}),
    ...(Object.keys(apikey.staticQueryParams).length > 0
      ? { queryParams: apikey.staticQueryParams }
      : {}),
    auth: migrateSourceAuth(v1.auth),
    ...(apikey.authenticationTemplate.length > 0
      ? { authenticationTemplate: apikey.authenticationTemplate }
      : {}),
  };
  return { config, slotToTemplateSlug, slotToVariable, warnings: apikey.warnings };
};

export const migrateGraphqlSourceConfig = (v1: V1GraphqlSourceConfig): MigratedSourceConfig => {
  const apikey = migrateOpenApiAuthTemplate({ headers: v1.headers, queryParams: v1.queryParams });
  const slotToTemplateSlug = { ...apikey.slotToTemplateSlug };
  const slotToVariable = { ...apikey.slotToVariable };
  withSourceAuthOauth(v1.auth, slotToTemplateSlug, slotToVariable);
  const config = {
    ...(v1.endpoint !== undefined ? { endpoint: v1.endpoint } : {}),
    ...(v1.name !== undefined ? { name: v1.name } : {}),
    ...(Object.keys(apikey.staticHeaders).length > 0 ? { headers: apikey.staticHeaders } : {}),
    ...(Object.keys(apikey.staticQueryParams).length > 0
      ? { queryParams: apikey.staticQueryParams }
      : {}),
    auth: migrateSourceAuth(v1.auth),
    ...(apikey.authenticationTemplate.length > 0
      ? { authenticationTemplate: apikey.authenticationTemplate }
      : {}),
  };
  return { config, slotToTemplateSlug, slotToVariable, warnings: apikey.warnings };
};

// ===========================================================================
// planMigration — the WEAVE.
//
// Composes the pure transforms above into a complete, side-effect-free plan the
// cloud/local runners execute. Built against the prod-verified model: exactly ONE
// connection per (scope, source); a `credential_binding` ties them (kind=connection
// → an oauth connection; kind=secret → a synthesized apiKey connection, 1–2 slots;
// kind=text → inline); no (scope, source) is both oauth AND apiKey. Secret VALUES
// are NOT resolved here — each `SecretOp` carries the v1 read descriptor + the
// deterministic v2 item id, and the runner does the vault read/write.
// ===========================================================================

export interface V1SourceRow {
  readonly scopeId: string;
  readonly id: string;
  readonly pluginId: string;
  readonly name: string;
}

export interface V1ProviderState {
  readonly kind?: string;
  readonly clientId?: string;
  readonly clientIdSecretId?: string;
  readonly clientIdSecretScopeId?: string | null;
  readonly clientSecretSecretId?: string;
  readonly clientSecretSecretScopeId?: string | null;
  readonly tokenEndpoint?: string;
  readonly authorizationEndpoint?: string;
  readonly authorizationServerUrl?: string;
  readonly authorizationServerMetadataUrl?: string;
  readonly authorizationServerMetadata?: {
    readonly authorization_endpoint?: string;
  } | null;
  readonly issuerUrl?: string;
  readonly resource?: string | null;
  readonly scopes?: readonly string[];
  readonly scope?: string;
}

export interface V1ConnectionRow {
  readonly id: string;
  readonly scopeId: string;
  readonly provider: string;
  readonly identityLabel: string | null;
  readonly accessTokenSecretId: string | null;
  readonly refreshTokenSecretId: string | null;
  readonly expiresAt: number | null;
  readonly providerState: V1ProviderState | null;
}

export interface V1BindingRow {
  readonly scopeId: string;
  readonly sourceScopeId?: string;
  readonly sourceId: string;
  readonly slotKey: string;
  readonly kind: "secret" | "connection" | "text";
  readonly secretId: string | null;
  readonly secretScopeId?: string | null;
  readonly connectionId: string | null;
  readonly textValue: string | null;
}

export interface V1PolicyRow {
  readonly id?: string;
  readonly scopeId: string;
  readonly pattern: string;
  readonly action: string;
  readonly position?: string;
}

export interface V1SecretRow {
  readonly id: string;
  readonly scopeId: string;
  readonly name: string;
  readonly provider: string;
  readonly ownedByConnectionId: string | null;
}

/** A v1 secret value to (re-)materialize in the v2 store. The runner resolves
 *  `fromSecret` via the provider (walking the scope-stack for client-* roles) or
 *  writes `fromText` verbatim, to the deterministic `itemId` under `owner`. */
export interface SecretOp {
  readonly itemId: string;
  readonly role: SecretRole;
  readonly owner: OwnerKeys;
  readonly targetProvider: string;
  readonly fromSecret?: {
    readonly scopeId: string;
    readonly secretId: string;
    readonly provider: string;
  };
  readonly fromText?: string;
}

export interface PlannedConnectionFull {
  readonly credentialScopeId: string;
  readonly sourceScopeId: string;
  readonly sourceId: string;
  readonly row: PlannedConnectionRow;
  /** variable → v2 item id (the connection's `item_ids` map). */
  readonly itemIds: Record<string, string>;
  readonly refreshItemId: string | null;
}

export interface PlannedOAuthClientFull extends DedupedOAuthClient {
  /** Vault item id for the client secret (when one existed); else null. */
  readonly clientSecretItemId: string | null;
}

export interface PlannedPolicy {
  readonly owner: OwnerKeys;
  readonly id: string;
  readonly pattern: string;
  readonly action: string;
  readonly position: string;
  readonly status: "ok" | "static" | "dead-inert";
}

export interface MigrationReport {
  readonly integrations: number;
  readonly connections: number;
  readonly oauthClients: number;
  readonly secretOps: number;
  /** v1 connection rows with no source binding — not migrated (stale residue). */
  readonly staleConnections: number;
  readonly policies: { readonly ok: number; readonly static: number; readonly deadInert: number };
  readonly warnings: readonly string[];
}

export interface MigrationPlan {
  readonly integrations: readonly PlannedIntegrationRow[];
  readonly oauthClients: readonly PlannedOAuthClientFull[];
  readonly connections: readonly PlannedConnectionFull[];
  readonly secretOps: readonly SecretOp[];
  readonly policies: readonly PlannedPolicy[];
  readonly report: MigrationReport;
}

export interface MigrationInput {
  readonly sources: readonly V1SourceRow[];
  /** `${scopeId} ${sourceId}` → the migrated config + slot maps (the runner
   *  builds these per kind via the `migrate*SourceConfig` assemblers). */
  readonly migratedConfigs: ReadonlyMap<string, MigratedSourceConfig>;
  readonly connections: readonly V1ConnectionRow[];
  readonly bindings: readonly V1BindingRow[];
  readonly secrets: readonly V1SecretRow[];
  readonly policies: readonly V1PolicyRow[];
  /** Tool `source_id`s with no `source` row (Class B orphans) — folded into the
   *  slug map so their policies/tools survive. */
  readonly toolSourceIds: readonly string[];
  readonly nowMs: number;
  readonly ownerForScope?: ScopeOwnerResolver;
  readonly defaultWritableProvider?: string;
}

/** The map key joining a (scopeId, sourceId) pair. Exported so the runner keys
 *  `migratedConfigs` identically to the weave's lookup. */
export const migrationSourceKey = (scopeId: string, sourceId: string): string =>
  `${scopeId} ${sourceId}`;

const sourceKey = migrationSourceKey;

const bindingSourceScope = (binding: V1BindingRow): string =>
  binding.sourceScopeId ?? binding.scopeId;

const bindingSecretScope = (binding: V1BindingRow): string =>
  binding.secretScopeId ?? binding.scopeId;

const slugifyName = (name: string, fallback = "account"): string =>
  String(connectionIdentifier(name, fallback));

const secretRefKey = (scopeId: string, secretId: string): string => `${scopeId}\0${secretId}`;

const staticConnectionNameForSecretBindings = (
  bindings: readonly V1BindingRow[],
  secrets: readonly V1SecretRow[],
): string => {
  const refs = new Map<string, { readonly scopeId: string; readonly secretId: string }>();
  for (const binding of bindings) {
    if (!binding.secretId) continue;
    const scopeId = bindingSecretScope(binding);
    refs.set(secretRefKey(scopeId, binding.secretId), { scopeId, secretId: binding.secretId });
  }

  if (refs.size !== 1) return "api-key";

  const [ref] = refs.values();
  if (!ref) return "api-key";
  const secret = secrets.find((s) => s.scopeId === ref.scopeId && s.id === ref.secretId);
  const nameSlug = secret?.name.trim() ? slugifyName(secret.name, "") : "";
  return nameSlug || slugifyName(ref.secretId, "api-key");
};

const scopesFromProviderState = (ps: V1ProviderState | null): readonly string[] => {
  if (!ps) return [];
  if (ps.scopes && ps.scopes.length > 0) return ps.scopes;
  if (ps.scope) return ps.scope.split(/\s+/).filter((s) => s.length > 0);
  return [];
};

const nonEmptyString = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const authorizationUrlFromProviderState = (ps: V1ProviderState | null): string =>
  nonEmptyString(ps?.authorizationEndpoint) ??
  nonEmptyString(ps?.authorizationServerMetadata?.authorization_endpoint) ??
  nonEmptyString(ps?.authorizationServerUrl) ??
  nonEmptyString(ps?.issuerUrl) ??
  "";

export const planMigration = (input: MigrationInput): MigrationPlan => {
  const warnings: string[] = [];
  const secretOps: SecretOp[] = [];
  const connections: PlannedConnectionFull[] = [];
  const ownerForScope = input.ownerForScope ?? parseScope;
  const defaultWritableProvider = input.defaultWritableProvider ?? "workos-vault";

  // --- Integrations (one per source) + the policy slug map (source ∪ tool ids).
  const integrations: PlannedIntegrationRow[] = [];
  const slugMap = new Map<string, string>();
  for (const id of input.toolSourceIds) slugMap.set(id, id);
  for (const source of input.sources) {
    slugMap.set(source.id, source.id);
    const migrated = input.migratedConfigs.get(sourceKey(source.scopeId, source.id));
    const row = planIntegrationRow({
      scopeId: source.scopeId,
      sourceId: source.id,
      pluginId: source.pluginId,
      description: source.name,
      config: migrated?.config ?? {},
      ownerForScope,
    });
    if (!row) {
      warnings.push(`Skipped source "${source.id}": unparseable scope "${source.scopeId}".`);
      continue;
    }
    integrations.push(row);
    for (const w of migrated?.warnings ?? []) warnings.push(`[${source.id}] ${w}`);
  }

  // --- Group bindings by (scope, source); each group → one connection.
  const groups = new Map<string, V1BindingRow[]>();
  for (const b of input.bindings) {
    const key = sourceKey(b.scopeId, b.sourceId);
    const list = groups.get(key) ?? [];
    list.push(b);
    groups.set(key, list);
  }
  const connectionById = new Map<string, V1ConnectionRow>();
  for (const c of input.connections) connectionById.set(`${c.scopeId} ${c.id}`, c);

  // Track which secrets a connection/oauth-client consumes, so the leftovers are
  // the orphans (migrate-all). Keyed `${scopeId} ${secretId}`.
  const consumed = new Set<string>();
  const consume = (scopeId: string, secretId: string): void => {
    consumed.add(`${scopeId} ${secretId}`);
  };
  // Connection rows actually bound to a source (and thus migrated). v1 leaves
  // stale, unbound connection rows behind (disconnect/re-auth residue); they have
  // no source to attach to in v2, so they're not migrated — their tokens fall to
  // the orphan re-key (migrate-all). Tracked for transparency in the report.
  const boundConnections = new Set<string>();

  // OAuth client inputs collected for dedup; each connection records its dedup
  // key so it can pick up the assigned slug after dedup runs.
  const oauthClientInputs: PlannedOAuthClientInput[] = [];
  const clientSecretItemIdByKey = new Map<string, string | null>();
  // Defer the slug wire-up: store (connection plan, dedupKey) pairs.
  const pendingClientSlug: { readonly index: number; readonly key: string }[] = [];

  for (const [key, bindings] of groups) {
    const [scopeId, sourceId] = key.split(" ");
    if (!scopeId || !sourceId) continue;
    const sourceScopeId = bindings[0] ? bindingSourceScope(bindings[0]) : scopeId;
    const owner = ownerForScope(scopeId);
    if (!owner) {
      warnings.push(`Skipped binding group "${sourceId}": unparseable scope "${scopeId}".`);
      continue;
    }
    const config = input.migratedConfigs.get(sourceKey(sourceScopeId, sourceId));
    const slotTemplate = (slot: string): string =>
      config?.slotToTemplateSlug[slot] ?? API_KEY_TEMPLATE_SLUG;
    const slotVar = (slot: string): string =>
      config?.slotToVariable[slot] ?? PRIMARY_INPUT_VARIABLE;

    const connBinding = bindings.find((b) => b.kind === "connection");
    const secretBindings = bindings.filter((b) => b.kind === "secret");
    const textBindings = bindings.filter((b) => b.kind === "text");

    if (connBinding && connBinding.connectionId) {
      // OAuth connection.
      const conn = connectionById.get(`${scopeId} ${connBinding.connectionId}`);
      if (!conn) {
        warnings.push(
          `Connection "${connBinding.connectionId}" referenced by a binding is missing.`,
        );
        continue;
      }
      boundConnections.add(`${conn.scopeId} ${conn.id}`);
      const ps = conn.providerState;
      const grant = migrateGrant((ps?.kind as V1ConnectionKind) ?? "authorization-code");
      const oauthTargetProvider =
        conn.provider === "oauth2" ? defaultWritableProvider : conn.provider;
      const itemIds: Record<string, string> = {};
      let refreshItemId: string | null = null;
      if (conn.accessTokenSecretId) {
        const itemId = migratedItemId(scopeId, conn.accessTokenSecretId);
        const provider = providerForSecret(input.secrets, scopeId, conn.accessTokenSecretId);
        secretOps.push({
          itemId,
          role: "oauth-access",
          owner,
          targetProvider: oauthTargetProvider,
          fromSecret: { scopeId, secretId: conn.accessTokenSecretId, provider },
        });
        itemIds[PRIMARY_INPUT_VARIABLE] = itemId;
        consume(scopeId, conn.accessTokenSecretId);
      }
      if (conn.refreshTokenSecretId) {
        refreshItemId = migratedItemId(scopeId, conn.refreshTokenSecretId);
        const provider = providerForSecret(input.secrets, scopeId, conn.refreshTokenSecretId);
        secretOps.push({
          itemId: refreshItemId,
          role: "oauth-refresh",
          owner,
          targetProvider: oauthTargetProvider,
          fromSecret: { scopeId, secretId: conn.refreshTokenSecretId, provider },
        });
        consume(scopeId, conn.refreshTokenSecretId);
      }
      // OAuth client.
      let clientSecretItemId: string | null = null;
      if (ps?.clientSecretSecretId) {
        const clientSecretScopeId = ps.clientSecretSecretScopeId ?? scopeId;
        clientSecretItemId = migratedItemId(clientSecretScopeId, ps.clientSecretSecretId);
        const provider = providerForSecret(
          input.secrets,
          clientSecretScopeId,
          ps.clientSecretSecretId,
        );
        secretOps.push({
          itemId: clientSecretItemId,
          role: "client-secret",
          owner,
          targetProvider: oauthTargetProvider,
          fromSecret: { scopeId: clientSecretScopeId, secretId: ps.clientSecretSecretId, provider },
        });
        consume(clientSecretScopeId, ps.clientSecretSecretId);
      }
      const clientIdSecretScopeId = ps?.clientIdSecretScopeId ?? scopeId;
      const clientIdSecretRef =
        ps?.clientIdSecretId != null
          ? {
              scopeId: clientIdSecretScopeId,
              secretId: ps.clientIdSecretId,
              provider: providerForSecret(
                input.secrets,
                clientIdSecretScopeId,
                ps.clientIdSecretId,
              ),
            }
          : null;
      if (clientIdSecretRef) consume(clientIdSecretRef.scopeId, clientIdSecretRef.secretId);
      if (!ps?.clientId && !clientIdSecretRef) {
        warnings.push(
          `OAuth connection "${conn.id}" has no client id or client-id secret reference; migrated oauth_client will need repair.`,
        );
      }
      const clientInput: PlannedOAuthClientInput = {
        ownerKeys: owner,
        clientId: ps?.clientId ?? "",
        clientIdSecretRef,
        tokenUrl: ps?.tokenEndpoint ?? "",
        authorizationUrl: authorizationUrlFromProviderState(ps),
        authorizationServerMetadataUrl: nonEmptyString(ps?.authorizationServerMetadataUrl),
        grant,
        resource: ps?.resource ?? null,
        clientSecretRef: ps?.clientSecretSecretId ?? null,
      };
      oauthClientInputs.push(clientInput);
      const dedupKey = oauthClientSlugKey({
        ownerKeys: owner,
        clientId: clientInput.clientId,
        clientIdSecretRef: clientInput.clientIdSecretRef,
        tokenUrl: clientInput.tokenUrl,
      });
      clientSecretItemIdByKey.set(dedupKey, clientSecretItemId);

      const row = planConnectionRow({
        scopeId,
        integration: sourceId,
        name: slugifyName(conn.identityLabel ?? "account"),
        template: slotTemplate(connBinding.slotKey),
        provider: oauthTargetProvider,
        identityLabel: conn.identityLabel,
        grant,
        v1ExpiresAt: conn.expiresAt,
        oauthScopes: scopesFromProviderState(ps),
        oauthClientSlug: null, // wired after dedup
        oauthClientOwner: owner,
        nowMs: input.nowMs,
        ownerForScope,
      });
      if (!row) continue;
      const index =
        connections.push({
          credentialScopeId: scopeId,
          sourceScopeId,
          sourceId,
          row,
          itemIds,
          refreshItemId,
        }) - 1;
      pendingClientSlug.push({ index, key: dedupKey });
    } else if (secretBindings.length > 0) {
      // apiKey connection (one or more distinct inputs into one connection). A
      // single-secret v1 binding keeps the user's secret label as the v2 account
      // name; multi-input methods keep the deterministic generic fallback.
      const itemIds: Record<string, string> = {};
      let template = API_KEY_TEMPLATE_SLUG;
      const providers = new Set<string>();
      let targetProvider: string | null = null;
      const connectionName = staticConnectionNameForSecretBindings(secretBindings, input.secrets);
      for (const b of secretBindings) {
        if (!b.secretId) continue;
        const secretScopeId = bindingSecretScope(b);
        const variable = slotVar(b.slotKey);
        const itemId = migratedItemId(secretScopeId, b.secretId);
        const provider = providerForSecret(input.secrets, secretScopeId, b.secretId);
        targetProvider ??= provider;
        providers.add(provider);
        secretOps.push({
          itemId,
          role: "apikey",
          owner,
          targetProvider,
          fromSecret: { scopeId: secretScopeId, secretId: b.secretId, provider },
        });
        itemIds[variable] = itemId;
        template = slotTemplate(b.slotKey);
        consume(secretScopeId, b.secretId);
      }
      const provider = targetProvider ?? defaultWritableProvider;
      if (providers.size > 1) {
        warnings.push(
          `Connection "${sourceId}" in scope "${scopeId}" uses multiple secret providers; v2 supports one provider per connection and will use "${provider}".`,
        );
      }
      const row = planConnectionRow({
        scopeId,
        integration: sourceId,
        name: connectionName,
        template,
        provider,
        identityLabel: null,
        grant: "authorization_code",
        v1ExpiresAt: null,
        oauthScopes: [],
        oauthClientSlug: null,
        oauthClientOwner: null,
        nowMs: input.nowMs,
        ownerForScope,
      });
      if (row) {
        connections.push({
          credentialScopeId: scopeId,
          sourceScopeId,
          sourceId,
          row,
          itemIds,
          refreshItemId: null,
        });
      }
    } else if (textBindings.length > 0) {
      // Inline text connection (rare — 2 in prod).
      const itemIds: Record<string, string> = {};
      let template = API_KEY_TEMPLATE_SLUG;
      for (const b of textBindings) {
        const variable = slotVar(b.slotKey);
        const itemId = migratedItemId(scopeId, `text:${b.slotKey}`);
        secretOps.push({
          itemId,
          role: "apikey",
          owner,
          targetProvider: defaultWritableProvider,
          fromText: b.textValue ?? "",
        });
        itemIds[variable] = itemId;
        template = slotTemplate(b.slotKey);
      }
      const row = planConnectionRow({
        scopeId,
        integration: sourceId,
        name: "inline",
        template,
        provider: defaultWritableProvider,
        identityLabel: null,
        grant: "authorization_code",
        v1ExpiresAt: null,
        oauthScopes: [],
        oauthClientSlug: null,
        oauthClientOwner: null,
        nowMs: input.nowMs,
        ownerForScope,
      });
      if (row) {
        connections.push({
          credentialScopeId: scopeId,
          sourceScopeId,
          sourceId,
          row,
          itemIds,
          refreshItemId: null,
        });
      }
    }
  }

  // --- Dedup oauth clients, then wire each connection's slug + secret item id.
  const dedup = dedupeOAuthClients(oauthClientInputs);
  const oauthClients: PlannedOAuthClientFull[] = dedup.clients.map((c) => {
    const dedupKey = oauthClientSlugKey({
      ownerKeys: c.ownerKeys,
      clientId: c.clientId,
      clientIdSecretRef: c.clientIdSecretRef,
      tokenUrl: c.tokenUrl,
    });
    return { ...c, clientSecretItemId: clientSecretItemIdByKey.get(dedupKey) ?? null };
  });
  for (const { index, key } of pendingClientSlug) {
    const slug = dedup.slugByDedupKey[key] ?? null;
    const existing = connections[index];
    if (existing) {
      connections[index] = { ...existing, row: { ...existing.row, oauthClientSlug: slug } };
    }
  }

  // --- Orphan secrets (migrate-all): everything not consumed above + not an
  // OAuth-token secret already handled. Re-keyed standalone under its scope owner.
  for (const s of input.secrets) {
    if (consumed.has(`${s.scopeId} ${s.id}`)) continue;
    const owner = ownerForScope(s.scopeId);
    if (!owner) continue; // unparseable scope orphan — skip + (counted via warnings below)
    secretOps.push({
      itemId: migratedItemId(s.scopeId, s.id),
      role: "orphan",
      owner,
      targetProvider: s.provider,
      fromSecret: { scopeId: s.scopeId, secretId: s.id, provider: s.provider },
    });
  }

  // --- Policies: transform; dead-source ones KEEP INERT (decided) — emitted with
  // their original pattern, which matches no v2 4-segment address.
  const policies: PlannedPolicy[] = [];
  let ok = 0;
  let staticN = 0;
  let deadInert = 0;
  for (const p of input.policies) {
    const owner = ownerForScope(p.scopeId);
    if (!owner) {
      warnings.push(`Skipped policy "${p.pattern}": unparseable scope "${p.scopeId}".`);
      continue;
    }
    const result = migratePolicyPattern(p.pattern, slugMap);
    if (result.kind === "dead") {
      deadInert += 1;
      warnings.push(
        `Dead-source policy kept inert: "${p.pattern}" (slug "${result.slug}" removed).`,
      );
      policies.push({
        owner,
        id: p.id ?? fallbackPolicyId(p.scopeId, p.pattern, p.action),
        pattern: p.pattern,
        action: p.action,
        position: p.position ?? String(policies.length).padStart(6, "0"),
        status: "dead-inert",
      });
    } else {
      if (result.kind === "static") staticN += 1;
      else ok += 1;
      policies.push({
        owner,
        id: p.id ?? fallbackPolicyId(p.scopeId, p.pattern, p.action),
        pattern: result.pattern,
        action: p.action,
        position: p.position ?? String(policies.length).padStart(6, "0"),
        status: result.kind,
      });
    }
  }

  // Stale (unbound) v1 connection rows — counted for transparency.
  const staleConnections = input.connections.filter(
    (c) => !boundConnections.has(`${c.scopeId} ${c.id}`),
  ).length;
  if (staleConnections > 0) {
    warnings.push(
      `${staleConnections} unbound v1 connection row(s) were not migrated (no source binding); their tokens migrate as orphan secrets.`,
    );
  }

  // Dedupe secret ops by their (deterministic) item id — a secret referenced more
  // than once yields one op. The runner is idempotent regardless, but a clean op
  // set makes the dry-run count meaningful.
  const dedupedSecretOps = [...new Map(secretOps.map((o) => [o.itemId, o])).values()];

  return {
    integrations,
    oauthClients,
    connections,
    secretOps: dedupedSecretOps,
    policies,
    report: {
      integrations: integrations.length,
      connections: connections.length,
      oauthClients: oauthClients.length,
      secretOps: dedupedSecretOps.length,
      staleConnections,
      policies: { ok, static: staticN, deadInert },
      warnings,
    },
  };
};

const providerForSecret = (
  secrets: readonly V1SecretRow[],
  scopeId: string,
  secretId: string,
): string =>
  secrets.find((s) => s.scopeId === scopeId && s.id === secretId)?.provider ?? "workos-vault";
