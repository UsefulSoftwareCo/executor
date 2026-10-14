/**
 * Decode-only copies of the Executor v1 formats the importer reads (`notes/v1-import.md`). v1
 * owns these formats; nothing here writes them. Rows are tenant-scoped by the WorkOS organization
 * id; owned rows add `owner` (`org` or `user`) and `subject` (the WorkOS user id, `''` for org
 * rows). Unknown fields are ignored; a value that does not decode makes its item unsupported.
 */
import { Effect, Option, Schema } from "effect";
import { Base64Url } from "effect/encoding";

const Owner = Schema.Literals(["org", "user"]);
export type V1Owner = typeof Owner.Type;
/** JSON columns arrive parsed; legacy rows may hold JSON text. */
const JsonColumn = Schema.Unknown;
const Millis = Schema.Number;

export const IntegrationRow = Schema.Struct({
  row_id: Schema.String,
  slug: Schema.String,
  plugin_id: Schema.String,
  name: Schema.NullOr(Schema.String),
  config: JsonColumn,
  /** v1's declared account check (`HealthCheckSpec`), kept beside the plugin's config. */
  health_check: JsonColumn,
  created_ms: Millis,
});
export type IntegrationRow = typeof IntegrationRow.Type;

/**
 * v1's account check: the operation to run, arguments it pins, and the dot path of the response
 * field that names the account. OpenAPI runs the operation; GraphQL supports only `__schema`,
 * introspection; MCP ignores it and lists tools.
 */
export const HealthCheckSpec = Schema.Struct({
  operation: Schema.String,
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  identityField: Schema.optional(Schema.String),
});
export type HealthCheckSpec = typeof HealthCheckSpec.Type;
/** The one GraphQL operation v1 checks accounts with. */
export const graphqlHealthOperation = "__schema";

export const ConnectionRow = Schema.Struct({
  row_id: Schema.String,
  owner: Owner,
  subject: Schema.String,
  integration: Schema.String,
  name: Schema.String,
  template: Schema.String,
  provider: Schema.String,
  item_ids: JsonColumn,
  oauth_client: Schema.NullOr(Schema.String),
  oauth_client_owner: Schema.NullOr(Schema.String),
  refresh_item_id: Schema.NullOr(Schema.String),
  expires_at: Schema.NullOr(Millis),
  oauth_scope: Schema.NullOr(Schema.String),
  oauth_token_url: Schema.NullOr(Schema.String),
  created_ms: Millis,
});
export type ConnectionRow = typeof ConnectionRow.Type;

export const OAuthClientRow = Schema.Struct({
  row_id: Schema.String,
  owner: Owner,
  subject: Schema.String,
  slug: Schema.String,
  authorization_url: Schema.String,
  token_url: Schema.String,
  grant: Schema.String,
  client_id: Schema.String,
  client_secret_item_id: Schema.NullOr(Schema.String),
  token_endpoint_auth_method: Schema.NullOr(Schema.String),
  resource: Schema.NullOr(Schema.String),
  origin_kind: Schema.NullOr(Schema.String),
  origin_issuer: Schema.NullOr(Schema.String),
  origin_redirect_uri: Schema.NullOr(Schema.String),
});
export type OAuthClientRow = typeof OAuthClientRow.Type;

export const PolicyAction = Schema.Literals(["approve", "require_approval", "block"]);
export type PolicyAction = typeof PolicyAction.Type;
export const PolicyRow = Schema.Struct({
  row_id: Schema.String,
  owner: Owner,
  subject: Schema.String,
  id: Schema.String,
  pattern: Schema.String,
  action: Schema.String,
  position: Schema.String,
});
export type PolicyRow = typeof PolicyRow.Type;

/**
 * A saved artifact: a React component (`App`) whose code calls `tools.<integration>.<tool>` or
 * `tools.<integration>("<role>").<tool>`. `bindings` maps each role to the connection it runs as;
 * null on rows saved before bindings existed, whose code may still name five-segment addresses.
 */
export const ArtifactRow = Schema.Struct({
  row_id: Schema.String,
  owner: Owner,
  subject: Schema.String,
  id: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  code: Schema.String,
  bindings: JsonColumn,
});
export type ArtifactRow = typeof ArtifactRow.Type;

/** v1's `ArtifactBinding`: the three address segments a role in the code omits. */
export const ArtifactBinding = Schema.Struct({
  integration: Schema.String,
  owner: Owner,
  connection: Schema.String,
});
export type ArtifactBinding = typeof ArtifactBinding.Type;
const ArtifactBindings = Schema.Record(Schema.String, ArtifactBinding);
/**
 * The stored bindings. Null when the row predates bindings; a present column that does not decode
 * is empty, as v1 reads it, so every role in the code is unbound.
 */
export const decodeArtifactBindings = (
  value: unknown,
): Readonly<Record<string, ArtifactBinding>> | null =>
  value === null || value === undefined
    ? null
    : Option.getOrElse(Schema.decodeUnknownOption(ArtifactBindings)(jsonValue(value)), () => ({}));

/** v1's tool roots that name no integration and bind no connection: its own built-in tools. */
const reservedToolRoots = new Set(["search", "describe", "executor"]);
const withCommentsBlanked = (code: string) =>
  code.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (text) => text.replace(/[^\n]/g, " "));
/** v1's `tools.<integration>` or `tools["<integration>"]`, with an optional `("<role>")`. */
const toolsReference = new RegExp(
  String.raw`(?<![.\w$])tools\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*(?:"([A-Za-z_$][\w$-]*)"|'([A-Za-z_$][\w$-]*)')\s*\])\s*(?:\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*\))?`,
  "g",
);
/** A five-segment address, `tools.<integration>.<user|org>.<connection>.`, from before bindings. */
const fullAddress =
  /(?<![.\w$])tools\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*(user|org)\s*\.\s*([A-Za-z_$][\w$-]*)\s*\./g;

/** One integration an artifact's code calls: its role and the connection it runs as, if bound. */
export interface ArtifactUse {
  readonly role: string;
  readonly integration: string;
  readonly binding: ArtifactBinding | undefined;
}

/**
 * The integrations an artifact's code calls, as v1 resolves them: each role (the integration slug,
 * or the tag of `tools.<integration>("<tag>")`) with its stored binding. An artifact saved before
 * bindings existed (`bindings` null) names its connections in five-segment addresses instead.
 * `builtIn` says whether it calls v1's own tools (`tools.executor`, `tools.search`, …).
 */
export const artifactUses = (row: Pick<ArtifactRow, "code" | "bindings">) => {
  const code = withCommentsBlanked(row.code);
  const bindings = decodeArtifactBindings(row.bindings);
  const uses = new Map<string, ArtifactUse>();
  let builtIn = false;
  if (bindings === null)
    for (const match of code.matchAll(fullAddress)) {
      const [, integration = "", owner = "", connection = ""] = match;
      const role = `${integration}.${owner}.${connection}`;
      if (!uses.has(role))
        uses.set(role, {
          role,
          integration,
          binding: { integration, owner: owner === "org" ? "org" : "user", connection },
        });
    }
  for (const match of code.matchAll(toolsReference)) {
    const integration = match[1] ?? match[2] ?? match[3];
    if (integration === undefined) continue;
    if (reservedToolRoots.has(integration)) {
      builtIn = true;
      continue;
    }
    const role = match[4] ?? match[5] ?? integration;
    // A five-segment address was read above; its integration root is not a role of its own.
    if (role === "" || uses.has(role)) continue;
    if (bindings === null && [...uses.values()].some((use) => use.integration === integration))
      continue;
    uses.set(role, { role, integration, binding: bindings?.[role] });
  }
  return { uses: [...uses.values()], builtIn, bindings };
};

/** A toolkits plugin storage row (`collection = 'toolkits'`). */
export const ToolkitRow = Schema.Struct({
  row_id: Schema.String,
  owner: Owner,
  subject: Schema.String,
  key: Schema.String,
  data: JsonColumn,
});
export type ToolkitRow = typeof ToolkitRow.Type;
export const ToolkitData = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
});
export type ToolkitData = typeof ToolkitData.Type;
/**
 * A toolkit's rule (`toolkitConnections` or `toolkitPolicies`), with its owner partition. A
 * connection rule has no action: its pattern grants access to the tools it matches.
 */
export const ToolkitRuleRow = Schema.Struct({
  owner: Owner,
  subject: Schema.String,
  collection: Schema.Literals(["toolkitConnections", "toolkitPolicies"]),
  data: JsonColumn,
});
export type ToolkitRuleRow = typeof ToolkitRuleRow.Type;
export const ToolkitRuleData = Schema.Struct({
  id: Schema.String,
  toolkitId: Schema.String,
  pattern: Schema.String,
  action: Schema.optional(Schema.String),
  position: Schema.String,
});
export type ToolkitRuleData = typeof ToolkitRuleData.Type;

/** An OpenAPI operation's stored binding, which v1 invokes; decoded where it is read. */
export const OpenApiBindingRow = Schema.Struct({ binding: Schema.Unknown });

/** One persisted v1 tool: the name agents and policies used, per connection. */
export const ToolRow = Schema.Struct({
  owner: Owner,
  connection: Schema.String,
  name: Schema.String,
  /** The MCP server's own tool name, for MCP tools. */
  upstream: Schema.NullOr(Schema.String),
});
export type ToolRow = typeof ToolRow.Type;

/** An OpenAPI operation v1 compiled for an integration: the tool name and its request target. */
export const OpenApiOperationRow = Schema.Struct({
  tool: Schema.String,
  method: Schema.String,
  path: Schema.String,
});
export type OpenApiOperationRow = typeof OpenApiOperationRow.Type;

// ---------------------------------------------------------------------------------------------
// Plugin configuration (`integration.config`) per `plugin_id`.

const StringMap = Schema.Record(Schema.String, Schema.String);
/** `token` when a placement names no variable. */
export const tokenVariable = "token";
export const AuthPlacement = Schema.Struct({
  carrier: Schema.Literals(["header", "query"]),
  name: Schema.String,
  prefix: Schema.optional(Schema.String),
  variable: Schema.optional(Schema.String),
  literal: Schema.optional(Schema.String),
});
export type AuthPlacement = typeof AuthPlacement.Type;
const ApiKeyMethod = Schema.Struct({
  slug: Schema.String,
  kind: Schema.Literal("apikey"),
  label: Schema.optional(Schema.String),
  placements: Schema.Array(AuthPlacement),
});
export type ApiKeyMethod = typeof ApiKeyMethod.Type;
const NoneMethod = Schema.Struct({ slug: Schema.String, kind: Schema.Literal("none") });
const OpenApiOAuthMethod = Schema.Struct({
  slug: Schema.String,
  kind: Schema.Literal("oauth2"),
  label: Schema.optional(Schema.String),
  authorizationUrl: Schema.String,
  tokenUrl: Schema.String,
  resource: Schema.optional(Schema.NullOr(Schema.String)),
  scopes: Schema.Array(Schema.String),
});
const McpOAuthMethod = Schema.Struct({
  slug: Schema.String,
  kind: Schema.Literal("oauth2"),
  scopes: Schema.optional(Schema.Array(Schema.String)),
  enterpriseIdentityProvider: Schema.optional(Schema.Unknown),
});
const GraphqlOAuthMethod = Schema.Struct({
  slug: Schema.String,
  kind: Schema.Literal("oauth2"),
  header: Schema.optional(Schema.String),
  prefix: Schema.optional(Schema.String),
});
const StdioEnvMethod = Schema.Struct({
  slug: Schema.String,
  kind: Schema.Literal("stdio_env"),
  vars: Schema.Array(Schema.String),
});

export const McpRemoteConfig = Schema.Struct({
  transport: Schema.Literal("remote"),
  endpoint: Schema.String,
  remoteTransport: Schema.optional(Schema.Literals(["streamable-http", "sse", "auto"])),
  queryParams: Schema.optional(StringMap),
  headers: Schema.optional(StringMap),
  authenticationTemplate: Schema.Array(
    Schema.Union([NoneMethod, ApiKeyMethod, McpOAuthMethod, StdioEnvMethod]),
  ),
});
export type McpRemoteConfig = typeof McpRemoteConfig.Type;
const McpStdioConfig = Schema.Struct({ transport: Schema.Literal("stdio") });
export const McpConfig = Schema.Union([McpRemoteConfig, McpStdioConfig]);

export const OpenApiConfig = Schema.Struct({
  specHash: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  headers: Schema.optional(StringMap),
  queryParams: Schema.optional(StringMap),
  specFormat: Schema.optional(Schema.String),
  authenticationTemplate: Schema.optional(
    Schema.Array(Schema.Union([ApiKeyMethod, OpenApiOAuthMethod, NoneMethod])),
  ),
});
export type OpenApiConfig = typeof OpenApiConfig.Type;

export const GraphqlConfig = Schema.Struct({
  endpoint: Schema.String,
  headers: Schema.optional(StringMap),
  queryParams: Schema.optional(StringMap),
  authenticationTemplate: Schema.Array(
    Schema.Union([NoneMethod, ApiKeyMethod, GraphqlOAuthMethod]),
  ),
});
export type GraphqlConfig = typeof GraphqlConfig.Type;

/** How a connection authenticates, whatever plugin defined the method. */
export type V1AuthMethod =
  | { readonly kind: "none" }
  | {
      readonly kind: "apikey";
      readonly label?: string | undefined;
      readonly placements: readonly AuthPlacement[];
    }
  | {
      readonly kind: "oauth2";
      /** OpenAPI declares endpoints; MCP discovers them; GraphQL reads them from the client. */
      readonly scopes: readonly string[];
      readonly authorizationUrl?: string;
      readonly tokenUrl?: string;
      /** Where the access token goes; `Authorization: Bearer ` unless GraphQL says otherwise. */
      readonly header: string;
      readonly prefix: string;
      readonly enterprise: boolean;
    }
  | { readonly kind: "unsupported"; readonly reason: string };

/** A decoded integration: what the generator needs, or why it cannot be imported. */
export type V1Integration =
  | {
      readonly plugin: "mcp";
      readonly config: McpRemoteConfig;
      readonly methods: ReadonlyMap<string, V1AuthMethod>;
    }
  | {
      readonly plugin: "openapi";
      readonly config: OpenApiConfig;
      readonly specHash: string;
      readonly methods: ReadonlyMap<string, V1AuthMethod>;
      readonly healthCheck: HealthCheckSpec | undefined;
    }
  | {
      readonly plugin: "graphql";
      readonly config: GraphqlConfig;
      readonly methods: ReadonlyMap<string, V1AuthMethod>;
      /** Whether v1 introspected the endpoint to check accounts. */
      readonly healthCheck: boolean;
    }
  | { readonly plugin: "unsupported"; readonly reason: string };

const jsonValue = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  return Option.getOrElse(
    Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(value),
    () => value,
  );
};

const httpUrl = (value: string) => {
  const url = URL.canParse(value) ? new URL(value) : undefined;
  return url !== undefined && (url.protocol === "https:" || url.protocol === "http:")
    ? url
    : undefined;
};

/** v1 always sends `none` connections without credentials, even when no method declares it. */
const noneMethod: V1AuthMethod = { kind: "none" };
/**
 * A spec with both OAuth flows gives v1 two methods under one slug, and v1 signs a connection in
 * with the first (`authenticationTemplate.find`). Later duplicates are never used.
 */
const methodMap = (
  entries: ReadonlyArray<readonly [string, V1AuthMethod]>,
): ReadonlyMap<string, V1AuthMethod> => {
  const methods = new Map<string, V1AuthMethod>([["none", noneMethod]]);
  for (const [slug, method] of entries) if (!methods.has(slug)) methods.set(slug, method);
  return methods;
};

export const decodeIntegration = (row: IntegrationRow): V1Integration => {
  const config = jsonValue(row.config);
  const healthCheck = Option.getOrUndefined(
    Schema.decodeUnknownOption(HealthCheckSpec)(jsonValue(row.health_check)),
  );
  const unsupported = (reason: string) => ({ plugin: "unsupported" as const, reason });
  switch (row.plugin_id) {
    case "mcp": {
      const decoded = Schema.decodeUnknownOption(McpConfig)(config);
      if (Option.isNone(decoded)) return unsupported("Its MCP configuration could not be read.");
      if (decoded.value.transport === "stdio")
        return unsupported("Local (stdio) MCP servers do not run in Executor Cloud.");
      const remote = decoded.value;
      if (httpUrl(remote.endpoint) === undefined)
        return unsupported("Its MCP server address is not an http(s) URL.");
      return {
        plugin: "mcp",
        config: remote,
        methods: methodMap(
          remote.authenticationTemplate.map((method): readonly [string, V1AuthMethod] => [
            method.slug,
            method.kind === "oauth2"
              ? {
                  kind: "oauth2",
                  scopes: method.scopes ?? [],
                  header: "Authorization",
                  prefix: "Bearer ",
                  enterprise: method.enterpriseIdentityProvider !== undefined,
                }
              : method.kind === "stdio_env"
                ? { kind: "unsupported", reason: "Its environment variables need a local server." }
                : method,
          ]),
        ),
      };
    }
    case "openapi": {
      const decoded = Schema.decodeUnknownOption(OpenApiConfig)(config);
      if (Option.isNone(decoded))
        return unsupported("Its OpenAPI configuration could not be read.");
      if (decoded.value.specHash === undefined)
        return unsupported("v1 stored no resolved specification for it.");
      // v1 treats an empty base URL as unset and uses the specification's server.
      const { baseUrl, ...rest } = decoded.value;
      const openapi: OpenApiConfig =
        baseUrl === undefined || baseUrl === "" ? rest : { ...rest, baseUrl };
      if (openapi.baseUrl !== undefined && httpUrl(openapi.baseUrl) === undefined)
        return unsupported("Its base URL is not an http(s) URL.");
      return {
        plugin: "openapi",
        config: openapi,
        specHash: decoded.value.specHash,
        healthCheck,
        methods: methodMap(
          (decoded.value.authenticationTemplate ?? []).map(
            (method): readonly [string, V1AuthMethod] => [
              method.slug,
              method.kind === "oauth2"
                ? {
                    kind: "oauth2",
                    scopes: method.scopes,
                    authorizationUrl: method.authorizationUrl,
                    tokenUrl: method.tokenUrl,
                    // v1's OpenAPI plugin sends the header in lower case.
                    header: "authorization",
                    prefix: "Bearer ",
                    enterprise: false,
                  }
                : method,
            ],
          ),
        ),
      };
    }
    case "graphql": {
      const decoded = Schema.decodeUnknownOption(GraphqlConfig)(config);
      if (Option.isNone(decoded))
        return unsupported("Its GraphQL configuration could not be read.");
      if (httpUrl(decoded.value.endpoint) === undefined)
        return unsupported("Its GraphQL endpoint is not an http(s) URL.");
      return {
        plugin: "graphql",
        config: decoded.value,
        healthCheck: healthCheck?.operation === graphqlHealthOperation,
        methods: methodMap(
          decoded.value.authenticationTemplate.map((method): readonly [string, V1AuthMethod] => [
            method.slug,
            method.kind === "oauth2"
              ? {
                  kind: "oauth2",
                  scopes: [],
                  header: method.header ?? "Authorization",
                  prefix: method.prefix ?? "Bearer ",
                  enterprise: false,
                }
              : method,
          ]),
        ),
      };
    }
    default:
      return unsupported("Executor v2 has no equivalent of this v1 plugin.");
  }
};

/** The variables an API-key method reads from a connection's `item_ids`, in placement order. */
export const placementVariables = (placements: readonly AuthPlacement[]) => [
  ...new Set(
    placements.flatMap((placement) =>
      placement.literal === undefined ? [placement.variable ?? tokenVariable] : [],
    ),
  ),
];

export const ItemIds = Schema.Record(Schema.String, Schema.String);
export const decodeItemIds = (value: unknown) =>
  Schema.decodeUnknownOption(ItemIds)(jsonValue(value));

// ---------------------------------------------------------------------------------------------
// OAuth clients.

export const firstPartyClientPrefix = "first-party:";
export const OAuthGrantKind = Schema.Literals([
  "authorization_code",
  "client_credentials",
  "id_jag",
]);
/** v1's stored token endpoint authentication; null means `body`. */
export const tokenEndpointAuthMethod = (value: string | null) =>
  value === null || value === "body"
    ? ("client_secret_post" as const)
    : value === "basic"
      ? ("client_secret_basic" as const)
      : value === "basic_raw"
        ? ("client_secret_basic_raw" as const)
        : undefined;

/** The `oauth_client` row a connection minted through, by owner partition. */
export const connectionClient = (
  connection: ConnectionRow,
  clients: readonly OAuthClientRow[],
): OAuthClientRow | undefined => {
  if (connection.oauth_client === null) return undefined;
  const owner = connection.oauth_client_owner ?? connection.owner;
  return clients.find(
    (client) =>
      client.slug === connection.oauth_client &&
      client.owner === owner &&
      (owner === "org" || client.subject === connection.subject),
  );
};

// ---------------------------------------------------------------------------------------------
// WorkOS Vault object names and R2 blob keys.

const maxObjectName = 200;
/** The partition an item id names: its second `:` segment, for the id families that embed one. */
export const itemOwner = (itemId: string): V1Owner | undefined => {
  const [family, owner] = itemId.split(":");
  if (family !== "connection" && family !== "oauth" && family !== "oauth-client") return undefined;
  return owner === "org" || owner === "user" ? owner : undefined;
};

/**
 * The Vault object holding an item: `executor/org/<tenant>/secrets/<id>` or
 * `executor/user/<tenant>/<subject>/secrets/<id>`, each segment URL-encoded. A name longer than 200
 * characters ends in `h~` and the unpadded base64url SHA-256 of the raw item id instead. Ids
 * without an embedded owner live under `executor/secrets/`.
 */
export const vaultObjectName = (input: {
  readonly tenant: string;
  /** The reading subject; v1 binds user-owned items to the caller. */
  readonly subject: string;
  readonly itemId: string;
}) =>
  Effect.gen(function* () {
    const owner = itemOwner(input.itemId);
    const tenant = encodeURIComponent(input.tenant);
    const head =
      owner === undefined
        ? "executor"
        : owner === "user"
          ? `executor/user/${tenant}/${encodeURIComponent(input.subject)}`
          : `executor/org/${tenant}`;
    const name = `${head}/secrets/${encodeURIComponent(input.itemId)}`;
    if (name.length <= maxObjectName) return name;
    const digest = yield* Effect.promise(() =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.itemId)),
    );
    return `${head}/secrets/h~${Base64Url.encode(new Uint8Array(digest))}`;
  });

/** The R2 object (and Postgres `blob` row) v1 keeps a plugin's blob in, org partition. */
export const blobKey = (tenant: string, plugin: string, key: string) => ({
  namespace: `o:${tenant}/${plugin}`,
  key,
  object: `o:${tenant}/${plugin}/${key}`,
});

// ---------------------------------------------------------------------------------------------
// Tool names and policies.

/** v1's MCP tool id: lower case, other runs of characters become `_`. */
export const mcpToolName = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "tool";

/** v1's tool policy pattern match against `integration.owner.connection.tool`. */
export const matchPattern = (pattern: string, toolId: string): boolean => {
  if (pattern === "*") return true;
  const patternSegments = pattern.split(".");
  const toolSegments = toolId.split(".");
  for (let index = 0; index < patternSegments.length; index++) {
    const segment = patternSegments[index];
    if (segment === "*") {
      if (index === patternSegments.length - 1) return toolSegments.length >= index;
      if (index >= toolSegments.length) return false;
      continue;
    }
    if (index >= toolSegments.length || toolSegments[index] !== segment) return false;
  }
  return patternSegments.length === toolSegments.length;
};

const restriction = { approve: 1, require_approval: 2, block: 3 } as const;
/**
 * v1's resolution: the first match by `position` (then id) within each owner, then the most
 * restrictive result across owners. Undefined when no policy matches; the tool's own default
 * applies then.
 */
export const resolvePolicy = (
  toolId: string,
  policies: readonly PolicyRow[],
): PolicyAction | undefined => {
  const sorted = [...policies].sort((a, b) =>
    a.position < b.position
      ? -1
      : a.position > b.position
        ? 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
  );
  const first = new Map<string, PolicyAction>();
  for (const row of sorted) {
    if (first.has(row.owner)) continue;
    const action = Schema.decodeUnknownOption(PolicyAction)(row.action);
    if (Option.isSome(action) && matchPattern(row.pattern, toolId))
      first.set(row.owner, action.value);
  }
  let selected: PolicyAction | undefined;
  for (const action of first.values())
    if (selected === undefined || restriction[action] > restriction[selected]) selected = action;
  return selected;
};

/** v1 accepted only these patterns; anything else never matched a tool. */
export const validPattern = (pattern: string) =>
  pattern === "*" ||
  (pattern.length > 0 &&
    !pattern.startsWith(".") &&
    !pattern.endsWith(".") &&
    !pattern.includes("..") &&
    !pattern.startsWith("*") &&
    pattern.split(".").every((segment) => segment === "*" || !segment.includes("*")));

// ---------------------------------------------------------------------------------------------
// Credentials in v1's configuration.

/**
 * Names of headers and query parameters that carry credentials, read conservatively: any name
 * containing one of these words.
 */
const credentialName =
  /authorization|cookie|key|token|secret|password|passwd|credential|session|signature|auth/iu;
/** A word an `Authorization`-style value starts with before its credential. */
const scheme = /^(bearer|basic|token|bot|apikey|api-key|digest|sso-key)\s+/iu;
/**
 * Whether a value looks like a credential: after an optional scheme word, a run of 16 or more
 * token characters with a digit, or of 32 or more. Versions, dates and media types do not.
 */
export const secretValue = (value: string) =>
  [
    ...value
      .trim()
      .replace(scheme, "")
      .matchAll(/[A-Za-z0-9_\-+=~:@!*]{16,}/gu),
  ].some(([run]) => run.length >= 32 || /[0-9]/u.test(run));

/**
 * Whether v1 configuration sent this header or query parameter as a credential: by its name, or
 * by a value that looks like one. Such values become account fields, never generated source.
 */
export const credentialLike = (name: string, value: string) =>
  value !== "" && (credentialName.test(name) || secretValue(value));

/**
 * Whether a placement's prefix holds a credential rather than a scheme such as `Bearer `: any
 * text beyond the scheme word that looks like one.
 */
export const secretPrefix = (prefix: string) => secretValue(prefix);

// ---------------------------------------------------------------------------------------------
// Toolkits.

/** A toolkit decoded with its own rules, from the rows of its owner partition. */
export interface V1Toolkit {
  readonly row: ToolkitRow;
  readonly data: ToolkitData;
  /** Patterns that grant access: its connection rules, and v1's legacy approve-all policies. */
  readonly access: readonly string[];
  /** Its other policies, in v1's order: by `position`, then `id`. */
  readonly policies: readonly ToolkitRuleData[];
}

const byPosition = (a: ToolkitRuleData, b: ToolkitRuleData) =>
  a.position < b.position
    ? -1
    : a.position > b.position
      ? 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;

/**
 * A toolkit and its rules, or undefined when its row does not decode. v1 reads an `approve` policy
 * ending in `*` with three or four segments as access, unless a connection rule already covers it.
 */
export const decodeToolkit = (
  row: ToolkitRow,
  rules: readonly ToolkitRuleRow[],
): V1Toolkit | undefined => {
  const data = Option.getOrUndefined(Schema.decodeUnknownOption(ToolkitData)(jsonValue(row.data)));
  if (data === undefined) return undefined;
  const own = rules.flatMap((rule) => {
    if (rule.owner !== row.owner || rule.subject !== row.subject) return [];
    const decoded = Schema.decodeUnknownOption(ToolkitRuleData)(jsonValue(rule.data));
    return Option.isSome(decoded) && decoded.value.toolkitId === data.id
      ? [{ collection: rule.collection, rule: decoded.value }]
      : [];
  });
  const connections = own
    .filter((entry) => entry.collection === "toolkitConnections")
    .map((entry) => entry.rule);
  const policies = own
    .filter((entry) => entry.collection === "toolkitPolicies")
    .map((entry) => entry.rule);
  const legacy = (policy: ToolkitRuleData) => {
    const parts = policy.pattern.split(".");
    return (
      policy.action === "approve" &&
      parts.at(-1) === "*" &&
      (parts.length === 3 || parts.length === 4) &&
      !connections.some((connection) => matchPattern(policy.pattern, connection.pattern))
    );
  };
  return {
    row,
    data,
    access: [
      ...connections.map((connection) => connection.pattern),
      ...policies.filter(legacy).map((policy) => policy.pattern),
    ],
    policies: policies.filter((policy) => !legacy(policy)).sort(byPosition),
  };
};

/**
 * What v1 did with a tool called through the toolkit: `undefined` when the toolkit does not grant
 * it, else the first matching policy's action, or `default` (the tool's own default). An org
 * toolkit never grants a personal connection's tools. Inside a toolkit, v1 ignored the
 * workspace's own policies.
 */
export const toolkitAction = (
  toolkit: V1Toolkit,
  toolId: string,
): PolicyAction | "default" | undefined => {
  if (toolkit.row.owner === "org" && toolId.split(".")[1] === "user") return undefined;
  if (!toolkit.access.some((pattern) => matchPattern(pattern, toolId))) return undefined;
  for (const policy of toolkit.policies)
    if (matchPattern(policy.pattern, toolId)) {
      const action = Schema.decodeUnknownOption(PolicyAction)(policy.action);
      if (Option.isSome(action)) return action.value;
    }
  return "default";
};

/**
 * Whether a toolkit's access patterns can reach a connection's tools, from its address alone:
 * every pattern segment up to the tool name is `*`, equal, or a trailing `*`.
 */
export const toolkitReaches = (
  toolkit: V1Toolkit,
  address: readonly [integration: string, owner: string, connection: string],
) =>
  !(toolkit.row.owner === "org" && address[1] === "user") &&
  toolkit.access.some((pattern) => {
    const segments = pattern.split(".");
    for (const [index, value] of address.entries()) {
      const segment = segments[index];
      if (segment === undefined) return false;
      if (segment === "*" && index === segments.length - 1) return true;
      if (segment !== "*" && segment !== value) return false;
    }
    return segments.length > address.length;
  });
