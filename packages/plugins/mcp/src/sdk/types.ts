import { Effect, Option, Schema } from "effect";
import {
  ApiKeyAuthMethod,
  ApiKeyAuthTemplate,
  NoneAuthMethod,
  apiKeyMethodFromAuthTemplate,
  isApiKeyAuthTemplate,
  normalizeAuthMethodSlugs,
} from "@executor-js/sdk/http-auth";

// ---------------------------------------------------------------------------
// MCP plugin v2 data model.
//
// An MCP integration is one server. Its `config` blob (opaque to core, stored
// on the integration row) carries everything needed to dial the server plus
// the declared auth methods describing how a connection's resolved credential
// values are applied to the request. A connection IS the credential: at
// execute time core resolves the connection's values through its provider
// (refreshing OAuth tokens), and the plugin renders them onto the request per
// the method the connection binds (D11).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Transport / remote transport
// ---------------------------------------------------------------------------

export const McpRemoteTransport = Schema.Literals(["streamable-http", "sse", "auto"]);
export type McpRemoteTransport = typeof McpRemoteTransport.Type;

/** All transport types (used in the connector layer) */
export const McpTransport = Schema.Literals(["streamable-http", "sse", "stdio", "auto"]);
export type McpTransport = typeof McpTransport.Type;

// ---------------------------------------------------------------------------
// Auth methods — the shared placements vocabulary (`@executor-js/sdk/http-auth`)
// plus MCP's own oauth variant. An integration declares zero or more methods,
// each with a stable `slug` a connection binds against (`connection.template`),
// mirroring the OpenAPI/GraphQL `authenticationTemplate` arrays.
//
//   none   — no credential (open server)
//   apikey — render the connection's values through the method's header/query
//            placements (one credential input per distinct placement
//            `variable`; servers like ui.sh authenticate via a `?token=`
//            query placement, and a method may mix carriers — e.g. a bearer
//            header plus a team-id query param)
//   oauth2 — the value is an OAuth access token, applied as a Bearer header
//            via the MCP SDK's OAuthClientProvider. MCP oauth carries no
//            stored endpoints: metadata is discovered live at connect time.
// ---------------------------------------------------------------------------

export const McpOAuthMethod = Schema.Struct({
  slug: Schema.String,
  kind: Schema.Literal("oauth2"),
});
export type McpOAuthMethod = typeof McpOAuthMethod.Type;

/** Stdio env credential: the named environment variables a stdio server needs
 *  (often API keys / tokens). A connection supplies one secret value per `var`,
 *  keyed by the var name; at launch the connector injects them into the
 *  subprocess env. The VALUES live in the secret store as the connection's
 *  inputs, never in this config blob — that is the "properly store auth" half
 *  of the stdio model, mirroring how remote apikey methods keep their secrets
 *  on the connection rather than the integration. */
export const McpStdioEnvMethod = Schema.Struct({
  slug: Schema.String,
  kind: Schema.Literal("stdio_env"),
  vars: Schema.Array(Schema.String),
});
export type McpStdioEnvMethod = typeof McpStdioEnvMethod.Type;

export const McpAuthMethod = Schema.Union([
  NoneAuthMethod,
  ApiKeyAuthMethod,
  McpOAuthMethod,
  McpStdioEnvMethod,
]);
export type McpAuthMethod = typeof McpAuthMethod.Type;

/** Single-method `auth` shorthand on `addServer` — agent convenience for the
 *  common cases. Normalized into `authenticationTemplate` at the boundary;
 *  never stored. */
export const McpAuthShorthand = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("header"),
    headerName: Schema.String,
    prefix: Schema.optional(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("oauth2") }),
]);
export type McpAuthShorthand = typeof McpAuthShorthand.Type;

/** Expand the `auth` shorthand into a declared method. Slugs match what the
 *  shorthand has always produced (`none` / `header` / `oauth2`) so existing
 *  connections bound to them keep matching. */
export const mcpAuthMethodFromShorthand = (auth: McpAuthShorthand): McpAuthMethod => {
  if (auth.kind === "header") {
    return {
      slug: "header",
      kind: "apikey",
      placements: [
        {
          carrier: "header",
          name: auth.headerName,
          ...(auth.prefix !== undefined ? { prefix: auth.prefix } : {}),
        },
      ],
    };
  }
  return { slug: auth.kind, kind: auth.kind };
};

/** Input variant of `McpAuthMethod` — callers (UI, agents) may omit the slug;
 *  `normalizeMcpAuthMethods` backfills it. */
export const McpAuthMethodInput = Schema.Union([
  Schema.Struct({ slug: Schema.optional(Schema.String), kind: Schema.Literal("none") }),
  Schema.Struct({ slug: Schema.optional(Schema.String), kind: Schema.Literal("oauth2") }),
  // Credential methods are authored request-shaped — the ONE apikey input
  // dialect: `{ type: "apiKey", headers: { Authorization: ["Bearer ",
  // variable("token")] }, queryParams: { … } }`. Stored configs and the
  // catalog read as canonical placements; `apiKeyAuthTemplateFromMethod`
  // serializes them back for read-modify-write flows.
  ApiKeyAuthTemplate,
]);
export type McpAuthMethodInput = typeof McpAuthMethodInput.Type;

/** The expansion target: input arms with the dialect resolved to canonical
 *  placements (slug still optional — backfill is a separate pass). */
export type McpCanonicalAuthMethodInput =
  | Exclude<McpAuthMethodInput, ApiKeyAuthTemplate>
  | (Omit<ApiKeyAuthMethod, "slug"> & { readonly slug?: string });

/** The default slug for a slug-less input method. Carrier-derived for the
 *  single-placement apikey cases (`header` / `query`) — the slugs those
 *  methods have always had — so the shorthand, UI, and migration paths all
 *  converge on the same names. */
const defaultMcpAuthSlug = (method: McpCanonicalAuthMethodInput): string => {
  if (method.kind !== "apikey") return method.kind;
  if (method.placements.length === 1) {
    return method.placements[0]!.carrier === "header" ? "header" : "query";
  }
  return "apikey";
};

/** Expand request-shaped dialect entries into canonical placements; canonical
 *  entries pass through. Slug backfill is the caller's concern
 *  (`normalizeMcpAuthMethods` for declare flows, `mergeAuthTemplates` for the
 *  custom-method merge). */
export const expandMcpAuthMethodInputs = (
  methods: readonly McpAuthMethodInput[],
): readonly McpCanonicalAuthMethodInput[] =>
  methods.map(
    (method): McpCanonicalAuthMethodInput =>
      isApiKeyAuthTemplate(method)
        ? (apiKeyMethodFromAuthTemplate(method) as McpCanonicalAuthMethodInput)
        : (method as McpCanonicalAuthMethodInput),
  );

/** Assign each method a stable slug: a caller-provided one wins, otherwise a
 *  kind/carrier-derived default, suffixed `_2`, `_3`, … on collision. The
 *  request-shaped dialect is expanded to canonical placements first. */
export const normalizeMcpAuthMethods = (
  methods: readonly McpAuthMethodInput[],
): readonly McpAuthMethod[] =>
  normalizeAuthMethodSlugs(
    expandMcpAuthMethodInputs(methods),
    defaultMcpAuthSlug,
  ) as readonly McpAuthMethod[];

// ---------------------------------------------------------------------------
// Integration config — the opaque blob stored on the integration row. A
// discriminated union on transport.
// ---------------------------------------------------------------------------

const StringMap = Schema.Record(Schema.String, Schema.String);

export const McpRemoteIntegrationConfig = Schema.Struct({
  transport: Schema.Literal("remote"),
  /** The MCP server endpoint URL */
  endpoint: Schema.String,
  /** Transport preference for this remote server */
  remoteTransport: McpRemoteTransport.pipe(
    Schema.optionalKey,
    Schema.withConstructorDefault(Effect.succeed("auto" as const)),
  ),
  /** Static query params appended to the endpoint URL (non-credential) */
  queryParams: Schema.optional(StringMap),
  /** Static headers sent on every request (non-credential) */
  headers: Schema.optional(StringMap),
  /** Declared auth methods — how a connection's values are rendered onto
   *  requests. A connection's `template` picks one by slug. */
  authenticationTemplate: Schema.Array(McpAuthMethod),
});
export type McpRemoteIntegrationConfig = typeof McpRemoteIntegrationConfig.Type;

export const McpStdioIntegrationConfig = Schema.Struct({
  transport: Schema.Literal("stdio"),
  /** The command to run */
  command: Schema.String,
  /** Arguments to the command */
  args: Schema.optional(Schema.Array(Schema.String)),
  /** Static, non-credential environment variables injected verbatim into the
   *  subprocess. Secret env (API keys / tokens) is NOT stored here — it is
   *  declared as a `stdio_env` method in `authenticationTemplate` and its
   *  values live on the connection. Optional + legacy: pre-revamp stdio
   *  integrations stored their (then-plaintext) env here, so it stays
   *  decodable. */
  env: Schema.optional(StringMap),
  /** Working directory */
  cwd: Schema.optional(Schema.String),
  /** Declared auth methods — a single `stdio_env` method naming the secret env
   *  vars, or `none`. A connection's `template` picks one by slug, exactly as
   *  for remote servers. Optional so pre-revamp stdio configs (which had no
   *  methods) still decode; absence is treated as no declared secret env. */
  authenticationTemplate: Schema.optional(Schema.Array(McpAuthMethod)),
});
export type McpStdioIntegrationConfig = typeof McpStdioIntegrationConfig.Type;

export const McpIntegrationConfig = Schema.Union([
  McpRemoteIntegrationConfig,
  McpStdioIntegrationConfig,
]);
export type McpIntegrationConfig = typeof McpIntegrationConfig.Type;

const decodeIntegrationConfig = Schema.decodeUnknownOption(McpIntegrationConfig);

/** Parse an opaque integration `config` blob into a typed MCP config, or null
 *  if it isn't this plugin's (canonical) shape. Pre-canonical stored shapes
 *  are rewritten by the one-off config migration (`migrate-config.ts`), not
 *  decoded here — runtime code knows only the canonical model. */
export const parseMcpIntegrationConfig = (config: unknown): McpIntegrationConfig | null =>
  Option.getOrNull(decodeIntegrationConfig(config));

// ---------------------------------------------------------------------------
// Tool annotations — upstream MCP ToolAnnotations we honour (destructiveHint
// drives requiresApproval).
// ---------------------------------------------------------------------------

export const McpToolAnnotations = Schema.Struct({
  title: Schema.optional(Schema.String),
  readOnlyHint: Schema.optional(Schema.Boolean),
  destructiveHint: Schema.optional(Schema.Boolean),
  idempotentHint: Schema.optional(Schema.Boolean),
  openWorldHint: Schema.optional(Schema.Boolean),
});
export type McpToolAnnotations = typeof McpToolAnnotations.Type;

// ---------------------------------------------------------------------------
// Tool binding — maps a persisted (sanitized) tool name back to its real MCP
// tool name and upstream annotations, persisted per-connection so invokeTool
// can dial the server with the correct name.
// ---------------------------------------------------------------------------

export const McpToolBinding = Schema.Struct({
  /** Sanitized, address-safe tool name (the `<tool>` address segment). */
  toolId: Schema.String,
  /** The real MCP tool name as advertised by the server. */
  toolName: Schema.String,
  description: Schema.NullOr(Schema.String),
  inputSchema: Schema.optional(Schema.Unknown),
  outputSchema: Schema.optional(Schema.Unknown),
  annotations: Schema.optional(McpToolAnnotations),
});
export type McpToolBinding = typeof McpToolBinding.Type;
