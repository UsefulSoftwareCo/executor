import { Schema } from "effect";
import {
  ApiKeyAuthTemplate,
  apiKeyMethodFromAuthTemplate,
  isApiKeyAuthTemplate,
  ApiKeyAuthMethod,
  NoneAuthMethod,
  normalizeAuthMethodSlugs,
} from "@executor-js/sdk/http-auth";

// ---------------------------------------------------------------------------
// GraphQL operation kind
// ---------------------------------------------------------------------------

export const GraphqlOperationKind = Schema.Literals(["query", "mutation"]);
export type GraphqlOperationKind = typeof GraphqlOperationKind.Type;

// ---------------------------------------------------------------------------
// Extracted field (becomes a tool)
// ---------------------------------------------------------------------------

export const GraphqlArgument = Schema.Struct({
  name: Schema.String,
  typeName: Schema.String,
  required: Schema.Boolean,
  description: Schema.OptionFromOptional(Schema.String),
});
export type GraphqlArgument = typeof GraphqlArgument.Type;

export const ExtractedField = Schema.Struct({
  /** e.g. "user", "createUser" */
  fieldName: Schema.String,
  /** "query" or "mutation" */
  kind: GraphqlOperationKind,
  description: Schema.OptionFromOptional(Schema.String),
  arguments: Schema.Array(GraphqlArgument),
  /** JSON Schema for the input (built from arguments) */
  inputSchema: Schema.OptionFromOptional(Schema.Unknown),
  /** The return type name for documentation */
  returnTypeName: Schema.String,
});
export type ExtractedField = typeof ExtractedField.Type;

export const ExtractionResult = Schema.Struct({
  /** Schema name from introspection */
  schemaName: Schema.OptionFromOptional(Schema.String),
  fields: Schema.Array(ExtractedField),
});
export type ExtractionResult = typeof ExtractionResult.Type;

// ---------------------------------------------------------------------------
// Operation binding — minimal data needed to invoke
// ---------------------------------------------------------------------------

export const OperationBinding = Schema.Struct({
  kind: GraphqlOperationKind,
  fieldName: Schema.String,
  /** The full GraphQL query/mutation string, with the default scalar-leaf
   *  selection. Sent when the caller does not supply a custom `select`. */
  operationString: Schema.String,
  /** Operation text up to (not including) the field's selection set, e.g.
   *  `query Op($a: T) { field(a: $a)`. With `operationSuffix`, lets `invoke`
   *  splice a caller-supplied `select` as `{ <select> }` without re-introspecting.
   *  Optional so bindings persisted before this field still decode. */
  operationPrefix: Schema.optional(Schema.String),
  /** Closes the operation (` }`); pairs with `operationPrefix`. */
  operationSuffix: Schema.optional(Schema.String),
  /** Ordered variable names for mapping */
  variableNames: Schema.Array(Schema.String),
});
export type OperationBinding = typeof OperationBinding.Type;

// ---------------------------------------------------------------------------
// Auth methods — the shared placements vocabulary (`@executor-js/sdk/http-auth`)
// plus GraphQL's own oauth variant. The integration's
// `config.authenticationTemplate` declares zero or more methods, each with a
// stable `slug` a connection binds against (`connection.template`). There are
// no secret slots and no credential bindings — a connection IS the credential,
// and the plugin renders its resolved values onto the request through the
// bound method (D11).
//
//   none   — no credential (open endpoint)
//   apikey — render the connection's values through the method's header/query
//            placements (one credential input per distinct placement
//            `variable`; a method may mix carriers — e.g. a bearer header
//            plus a team-id query param)
//   oauth2 — the value is an OAuth access token, applied as a bearer header
//            (optionally overriding the header name / prefix). GraphQL oauth
//            stores no endpoints — only how the token is rendered.
// ---------------------------------------------------------------------------

/** An OAuth bearer method: write `<header>: <prefix><access-token>`. The
 *  resolved (and refreshed) access token is the connection's `token` value. */
export const GraphqlOAuthMethod = Schema.Struct({
  kind: Schema.Literal("oauth2"),
  slug: Schema.String,
  /** The header to write the bearer token to. Defaults to `Authorization`. */
  header: Schema.optional(Schema.String),
  /** The token prefix. Defaults to `Bearer `. */
  prefix: Schema.optional(Schema.String),
});
export type GraphqlOAuthMethod = typeof GraphqlOAuthMethod.Type;

export const GraphqlAuthMethod = Schema.Union([
  NoneAuthMethod,
  ApiKeyAuthMethod,
  GraphqlOAuthMethod,
]);
export type GraphqlAuthMethod = typeof GraphqlAuthMethod.Type;

/** Input variant of `GraphqlAuthMethod` — callers (UI, agents) may omit the
 *  slug; `normalizeGraphqlAuthMethods` backfills it. */
export const GraphqlAuthMethodInput = Schema.Union([
  Schema.Struct({ slug: Schema.optional(Schema.String), kind: Schema.Literal("none") }),
  Schema.Struct({
    slug: Schema.optional(Schema.String),
    kind: Schema.Literal("oauth2"),
    header: Schema.optional(Schema.String),
    prefix: Schema.optional(Schema.String),
  }),
  // Credential methods are authored request-shaped — the ONE apikey input
  // dialect: `{ type: "apiKey", headers: { Authorization: ["Bearer ",
  // variable("token")] }, queryParams: { … } }`. Stored configs and the
  // catalog read as canonical placements; `apiKeyAuthTemplateFromMethod`
  // serializes them back for read-modify-write flows.
  ApiKeyAuthTemplate,
]);
export type GraphqlAuthMethodInput = typeof GraphqlAuthMethodInput.Type;

/** The expansion target: input arms with the dialect resolved to canonical
 *  placements (slug still optional — backfill is a separate pass). */
export type GraphqlCanonicalAuthMethodInput =
  | Exclude<GraphqlAuthMethodInput, ApiKeyAuthTemplate>
  | (Omit<ApiKeyAuthMethod, "slug"> & { readonly slug?: string });

/** The default slug for a slug-less input method. Carrier-derived for the
 *  single-placement apikey cases (`header` / `query`) so the UI, agent, and
 *  migration paths all converge on the same names. */
const defaultGraphqlAuthSlug = (method: GraphqlCanonicalAuthMethodInput): string => {
  if (method.kind !== "apikey") return method.kind;
  if (method.placements.length === 1) {
    return method.placements[0]!.carrier === "header" ? "header" : "query";
  }
  return "apikey";
};

/** Expand request-shaped dialect entries into canonical placements; canonical
 *  entries pass through. Slug backfill is the caller's concern
 *  (`normalizeGraphqlAuthMethods` for declare flows, `mergeAuthTemplates` for
 *  the custom-method merge). */
export const expandGraphqlAuthMethodInputs = (
  methods: readonly GraphqlAuthMethodInput[],
): readonly GraphqlCanonicalAuthMethodInput[] =>
  methods.map(
    (method): GraphqlCanonicalAuthMethodInput =>
      isApiKeyAuthTemplate(method)
        ? (apiKeyMethodFromAuthTemplate(method) as GraphqlCanonicalAuthMethodInput)
        : (method as GraphqlCanonicalAuthMethodInput),
  );

/** Assign each method a stable slug: a caller-provided one wins, otherwise a
 *  kind/carrier-derived default, suffixed `_2`, `_3`, … on collision. The
 *  request-shaped dialect is expanded to canonical placements first. */
export const normalizeGraphqlAuthMethods = (
  methods: readonly GraphqlAuthMethodInput[],
): readonly GraphqlAuthMethod[] =>
  normalizeAuthMethodSlugs(
    expandGraphqlAuthMethodInputs(methods),
    defaultGraphqlAuthSlug,
  ) as readonly GraphqlAuthMethod[];

// ---------------------------------------------------------------------------
// Integration config — the opaque-to-core blob the graphql plugin stores on the
// integration row. Holds everything `resolveTools` (introspection) and
// `invokeTool` (request building + auth rendering) need.
// ---------------------------------------------------------------------------

export const GraphqlIntegrationConfig = Schema.Struct({
  /** The GraphQL endpoint URL. */
  endpoint: Schema.String,
  /** Display name for the integration. */
  name: Schema.String,
  /** Hex SHA-256 of the introspection JSON snapshot — the content address of
   *  the blob (`introspection/<hash>` in the plugin blob store). Rows that
   *  predate the blob store (inline `introspectionJson` text) are rewritten
   *  by the introspection-to-blob migrations before this schema sees them. */
  introspectionHash: Schema.optional(Schema.String),
  /** Static headers applied to every request (and to add-time introspection). */
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Static query parameters applied to every request. */
  queryParams: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Declared auth methods — how a connection's values are rendered onto
   *  requests. A connection's `template` picks one by slug. */
  authenticationTemplate: Schema.Array(GraphqlAuthMethod),
});
export type GraphqlIntegrationConfig = typeof GraphqlIntegrationConfig.Type;

// Decodes ONLY the canonical shape. Pre-canonical stored shapes are rewritten
// by the one-off config migration (`migrate-config.ts`), not decoded here —
// runtime code knows only the canonical model.
export const decodeGraphqlIntegrationConfig = Schema.decodeUnknownEffect(GraphqlIntegrationConfig);
export const decodeGraphqlIntegrationConfigOption =
  Schema.decodeUnknownOption(GraphqlIntegrationConfig);

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

export const InvocationResult = Schema.Struct({
  status: Schema.Number,
  data: Schema.NullOr(Schema.Unknown),
  errors: Schema.NullOr(Schema.Unknown),
});
export type InvocationResult = typeof InvocationResult.Type;
