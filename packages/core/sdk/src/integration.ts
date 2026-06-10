import type { IntegrationSlug } from "./ids";

/* Core knows only an integration's catalog identity — slug + description + which
 * plugin (`kind`) owns it. The type-specific shape (openapi auth templates + spec,
 * an mcp url, …) lives in the plugin and is stored as an opaque `config` blob core
 * never parses. An integration is one API surface; multi-API providers (Google)
 * are bundled into a single integration by their plugin, so one credential covers
 * the whole provider. */

// ---------------------------------------------------------------------------
// Declared auth methods — a plugin-agnostic projection of an integration's
// stored `config` into the catalog response. Each plugin derives these from its
// own opaque config (`describeAuthMethods`); core never parses config itself.
// The client renders these as the integration's selectable auth methods, so the
// catalog is authoritative even when the integration has zero connections.
//
// This is a DERIVED projection — there is no DB column. A plugin that declares
// no projector contributes `[]`, and the client falls through to its existing
// connection-inference behavior (no regression).
// ---------------------------------------------------------------------------

export interface IntegrationDisplayDescriptor {
  /** Non-secret URL suitable for display metadata such as favicons. */
  readonly url?: string;
}

/** Where a credential value is carried on the outbound request. Mirrors the
 *  client's `Placement`. */
export interface AuthPlacementDescriptor {
  readonly carrier: "header" | "query";
  readonly name: string;
  /** Literal prepended to the value (e.g. `"Bearer "`). Empty when bare. */
  readonly prefix: string;
  /** The input variable this placement renders from. `token` for single-input
   *  methods; a distinct name per input for multi-input ones (e.g. Datadog).
   *  Absent → treated as `token`. */
  readonly variable?: string;
}

/** OAuth specifics for an `oauth` auth method. For probe-at-connect providers
 *  (MCP) only `discoveryUrl` + `supportsDynamicRegistration` are known up front;
 *  the authorize/token endpoints are discovered live at connect time. For
 *  providers that store endpoints (OpenAPI) the resolved URLs are carried. */
export interface AuthMethodOAuthDescriptor {
  /** For probe-at-connect providers (MCP): the endpoint to discover metadata
   *  from (RFC 9728 PRM → RFC 8414 AS metadata). */
  readonly discoveryUrl?: string;
  readonly authorizationUrl?: string;
  readonly tokenUrl?: string;
  readonly scopes?: readonly string[];
  readonly registrationEndpoint?: string;
  /** True when the integration is known to support RFC 7591 dynamic client
   *  registration (drives the transparent auto-register connect flow). */
  readonly supportsDynamicRegistration?: boolean;
}

/** A single declared auth method on an integration's catalog response. */
export interface AuthMethodDescriptor {
  /** Stable id within the integration (e.g. the auth template slug). */
  readonly id: string;
  readonly label: string;
  readonly kind: "oauth" | "apikey" | "header" | "none";
  /** The auth-template slug a connection binds against. */
  readonly template: string;
  readonly placements?: readonly AuthPlacementDescriptor[];
  readonly oauth?: AuthMethodOAuthDescriptor;
}

/** Public projection of an integration — what `integrations.list/get` return.
 *  Carries no credentials and no plugin-internal config. */
export interface Integration {
  readonly slug: IntegrationSlug;
  readonly description: string;
  /** The plugin that owns this integration kind (e.g. "openapi", "mcp"). */
  readonly kind: string;
  /** Whether the user can remove this integration from the catalog. `false`
   *  for static / built-in integrations declared by a plugin at startup. */
  readonly canRemove: boolean;
  /** Whether the owning plugin supports re-resolving a connection's tools
   *  (`connections.refresh`). */
  readonly canRefresh: boolean;
  /** Declared auth methods derived from the owning plugin's stored config (a
   *  derived projection, not a DB column). Always present, possibly empty. */
  readonly authMethods: readonly AuthMethodDescriptor[];
  /** Non-secret display URL derived by the owning plugin from opaque config.
   *  Used for catalog favicons; never includes credentials or plugin config. */
  readonly displayUrl?: string;
}

/** Plugin-owned, opaque-to-core configuration stored on the integration row. The
 *  owning plugin writes it at register time and reads it back at execute time to
 *  render auth / produce tools. Core treats it as an opaque JSON blob. */
export type IntegrationConfig = unknown;

// ---------------------------------------------------------------------------
// Auth-template merge — shared by every plugin whose config carries a slugged
// `authenticationTemplate` array (openapi, graphql, mcp). The custom-method
// flow merge-appends: an incoming entry with a matching slug replaces the
// existing entry in place; entries lacking a slug (or colliding with another
// entry added in the same call) get a fresh `custom_<id>` slug.
// ---------------------------------------------------------------------------

const shortId = (): string => Math.random().toString(36).slice(2, 8);

export const freshCustomAuthSlug = (taken: ReadonlySet<string>): string => {
  let candidate = `custom_${shortId()}`;
  while (taken.has(candidate)) candidate = `custom_${shortId()}`;
  return candidate;
};

export const mergeAuthTemplates = <T extends { readonly slug: string }>(
  existing: readonly T[],
  incoming: readonly T[],
): readonly T[] => {
  const result: T[] = existing.map((entry: T) => entry);
  const taken = new Set<string>(result.map((entry: T) => String(entry.slug)));
  for (const entry of incoming) {
    // `slug` may be branded-required in the plugin's schema, but JSON callers
    // can submit it empty/blank — read defensively and backfill so every
    // stored template has a stable slug.
    const rawSlug = (entry as { readonly slug?: unknown }).slug;
    const requested = typeof rawSlug === "string" ? rawSlug.trim() : "";
    const existingIndex = result.findIndex((current: T) => String(current.slug) === requested);
    if (requested.length > 0 && existingIndex >= 0) {
      result[existingIndex] = entry;
      continue;
    }
    const slug =
      requested.length > 0 && !taken.has(requested) ? requested : freshCustomAuthSlug(taken);
    taken.add(slug);
    result.push({ ...entry, slug } as T);
  }
  return result;
};

/** What a plugin's extension method passes to `ctx.core.integrations.register`.
 *  The v2 analog of v1's `SourceInput`, minus the per-source tool list (tools are
 *  produced per-connection now). */
export interface RegisterIntegrationInput {
  readonly slug: IntegrationSlug;
  readonly description: string;
  /** Opaque plugin config (auth templates, spec ref, mcp url, …). */
  readonly config: IntegrationConfig;
  readonly canRemove?: boolean;
  readonly canRefresh?: boolean;
}
