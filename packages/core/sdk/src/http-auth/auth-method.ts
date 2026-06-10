import { Schema } from "effect";
import type { AuthMethodDescriptor, AuthPlacementDescriptor } from "../integration";

// ---------------------------------------------------------------------------
// The shared HTTP auth-method vocabulary for protocol plugins (openapi,
// graphql, mcp). An integration declares a LIST of auth methods; a connection
// binds one by its `slug` (`connection.template`) and supplies one credential
// value per `variable` the method's placements reference (D11: core resolves
// `values: Record<variable, string|null>`, the plugin renders them onto the
// request).
//
// Core itself never imports this module — core stays carrier-agnostic (a
// connection could be a CLI login or a DB URL). It ships as the
// `@executor-js/sdk/http-auth` subpath purely as a home: composition, not
// location, is what keeps headers/query params an HTTP-plugin concern.
//
// OAuth methods are NOT modeled here — their config genuinely differs per
// plugin (openapi stores endpoints+scopes, graphql an optional header
// override, mcp discovers everything at connect time). Each plugin's method
// union is `NoneAuthMethod | ApiKeyAuthMethod | <its own oauth variant>`.
// OAuth-refreshed connections resolve only the `token` input, so oauth
// values must never be mixed into a placements method.
// ---------------------------------------------------------------------------

/** The canonical input variable of single-credential methods. A placement
 *  with no `variable` renders from it, and core resolves a connection created
 *  with a bare `{ value }` into `{ token: value }`. */
export const TOKEN_VARIABLE = "token";

export const AuthCarrier = Schema.Literals(["header", "query"]);
export type AuthCarrier = typeof AuthCarrier.Type;

/** One spot on the outbound request a method writes to.
 *
 *  Credential placement: renders `prefix + values[variable ?? "token"]`.
 *  Two placements naming the same variable share one credential input; a
 *  placement naming its own variable gets its own input (e.g. Datadog's two
 *  keys).
 *
 *  Literal placement (`literal` set): renders the literal verbatim and
 *  references no credential — static values a method carries alongside its
 *  credential (e.g. a fixed version header). */
export const AuthPlacement = Schema.Struct({
  carrier: AuthCarrier,
  /** Header name (e.g. `Authorization`) or query-param name (e.g. `token`). */
  name: Schema.String,
  /** Literal prepended to the credential value, e.g. `Bearer `. */
  prefix: Schema.optional(Schema.String),
  /** The credential input this placement renders from. Absent ⇒ `token`. */
  variable: Schema.optional(Schema.String),
  /** Render this exact value instead of a credential. */
  literal: Schema.optional(Schema.String),
});
export type AuthPlacement = typeof AuthPlacement.Type;

export const ApiKeyAuthMethod = Schema.Struct({
  slug: Schema.String,
  kind: Schema.Literal("apikey"),
  /** Display label; derived from the first placement when absent. */
  label: Schema.optional(Schema.String),
  placements: Schema.Array(AuthPlacement),
});
export type ApiKeyAuthMethod = typeof ApiKeyAuthMethod.Type;

/** An open integration — connections carry no credential. */
export const NoneAuthMethod = Schema.Struct({
  slug: Schema.String,
  kind: Schema.Literal("none"),
});
export type NoneAuthMethod = typeof NoneAuthMethod.Type;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface RenderedAuthPlacements {
  readonly headers: Record<string, string>;
  readonly queryParams: Record<string, string>;
}

const renderPlacementValue = (
  placement: AuthPlacement,
  values: Record<string, string | null>,
): string | null => {
  if (placement.literal !== undefined) return placement.literal;
  const value = values[placement.variable ?? TOKEN_VARIABLE];
  if (value == null) return null;
  return placement.prefix ? `${placement.prefix}${value}` : value;
};

/** Render a method's placements with a connection's resolved values. Total:
 *  a credential placement whose variable resolved to nothing is skipped —
 *  callers own their missing-value policy (fail the invocation, dial
 *  unauthenticated, …) and should gate on `requiredPlacementVariables`. */
export const renderAuthPlacements = (
  placements: readonly AuthPlacement[],
  values: Record<string, string | null>,
): RenderedAuthPlacements => {
  const headers: Record<string, string> = {};
  const queryParams: Record<string, string> = {};
  for (const placement of placements) {
    const rendered = renderPlacementValue(placement, values);
    if (rendered === null) continue;
    if (placement.carrier === "header") headers[placement.name] = rendered;
    else queryParams[placement.name] = rendered;
  }
  return { headers, queryParams };
};

/** The distinct credential inputs a method's placements reference — what a
 *  connection must supply. Literal placements reference none. */
export const requiredPlacementVariables = (
  placements: readonly AuthPlacement[],
): readonly string[] => {
  const names = new Set<string>();
  for (const placement of placements) {
    if (placement.literal !== undefined) continue;
    names.add(placement.variable ?? TOKEN_VARIABLE);
  }
  return [...names];
};

/** The conventional rendering of an OAuth access token, as a placement — for
 *  plugins whose oauth method applies the token as a plain (possibly
 *  customized) header. The token is always the `token` input. */
export const oauthBearerPlacement = (header?: string, prefix?: string): AuthPlacement => ({
  carrier: "header",
  name: header ?? "Authorization",
  prefix: prefix ?? "Bearer ",
});

// ---------------------------------------------------------------------------
// Slug normalization — methods are input without slugs from UIs/agents; every
// stored method needs a stable one (`connection.template` binds by it).
// ---------------------------------------------------------------------------

/** Assign each method a stable slug: a caller-provided one wins, otherwise
 *  `defaultSlugFor(method)`, suffixed `_2`, `_3`, … on collision. */
export const normalizeAuthMethodSlugs = <T extends { readonly slug?: string | undefined }>(
  methods: readonly T[],
  defaultSlugFor: (method: T) => string,
): readonly (T & { readonly slug: string })[] => {
  const taken = new Set<string>();
  return methods.map((method: T): T & { readonly slug: string } => {
    const requested = method.slug?.trim() || defaultSlugFor(method);
    let slug = requested;
    for (let n = 2; taken.has(slug); n += 1) slug = `${requested}_${n}`;
    taken.add(slug);
    return { ...method, slug };
  });
};

// ---------------------------------------------------------------------------
// Catalog projection — the plugin-agnostic `AuthMethodDescriptor` every
// plugin's `describeAuthMethods` emits (the descriptor TYPE stays in
// @executor-js/sdk: core carries it as opaque catalog metadata).
// ---------------------------------------------------------------------------

export const apiKeyMethodLabel = (method: ApiKeyAuthMethod): string => {
  if (method.label !== undefined && method.label.trim().length > 0) return method.label;
  const first = method.placements.find(
    (placement: AuthPlacement) => placement.name.trim().length > 0,
  );
  return first ? `API key (${first.name})` : `API key (${method.slug})`;
};

const describePlacement = (placement: AuthPlacement): AuthPlacementDescriptor => ({
  carrier: placement.carrier,
  name: placement.name,
  prefix: placement.prefix ?? "",
  ...(placement.variable !== undefined ? { variable: placement.variable } : {}),
  ...(placement.literal !== undefined ? { literal: placement.literal } : {}),
});

export const describeApiKeyAuthMethod = (method: ApiKeyAuthMethod): AuthMethodDescriptor => ({
  id: method.slug,
  label: apiKeyMethodLabel(method),
  kind: "apikey",
  template: method.slug,
  placements: method.placements.map(describePlacement),
});

export const describeNoneAuthMethod = (slug: string): AuthMethodDescriptor => ({
  id: slug,
  label: "No authentication",
  kind: "none",
  template: slug,
});
