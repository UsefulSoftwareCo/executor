/**
 * Product-owned MCP authority. No organization, browser session, or token is a grant.
 *
 * Dashboards import this module, so it holds only what they need too: identities, addresses,
 * targets and sign-in settings. Enforcement and refusal text are in `grant-enforcement.ts`.
 */
import { AppPermission } from "@executor-js/authorization";
export { AppPermission } from "@executor-js/authorization";
import { Schema } from "effect";

/**
 * Stable authorization identity shared by access tokens, refresh tokens, and continuations. It
 * reaches storage as a path parameter, and storage cannot hold a control character such as NUL,
 * so one is refused as a bad request instead of failing the lookup.
 */
export const GrantId = Schema.NonEmptyString.check(Schema.isPattern(/^[^\p{Cc}]*$/u)).pipe(
  Schema.brand("McpGrantId"),
);
export type GrantId = typeof GrantId.Type;
/** Scope selects ordinary apps. All apps includes any Executor app the caller may use. */
export const GrantPolicy = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("tools"),
    apps: Schema.Array(AppPermission),
    approval: Schema.Literals(["browser", "client"]),
  }),
  Schema.Struct({ kind: Schema.Literal("all") }),
]);
export type GrantPolicy = typeof GrantPolicy.Type;
/** Revoked grants are absent from authentication, not converted to empty or unrestricted policies. */
export const ApprovalMode = Schema.Literals(["model", "native", "browser"]);
export type ApprovalMode = typeof ApprovalMode.Type;
/** A user's named MCP access boundary. URL-safe because it appears in the MCP URL and OAuth resource. */
export const ConnectionId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/u)).pipe(
  Schema.brand("McpConnectionId"),
);
export type ConnectionId = typeof ConnectionId.Type;
/**
 * What an MCP URL names: an approval mode and, optionally, a scoped connection. For a grant this
 * only preselects the choice on the sign-in page; the grant record holds what was chosen. A
 * credential without a record, such as a personal access token, takes its mode from the URL.
 */
export const McpAddress = Schema.Struct({
  mode: ApprovalMode,
  connection: Schema.optionalKey(ConnectionId),
});
export type McpAddress = typeof McpAddress.Type;
/**
 * What a grant serves: MCP with the approval mode and connection its record holds, or the API.
 * The consent's resource decides only which of the two, since a token's audience is that resource.
 */
export const GrantTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("mcp"), ...McpAddress.fields }),
  Schema.Struct({ kind: Schema.Literal("api") }),
]);
export type GrantTarget = typeof GrantTarget.Type;
export const Grant = Schema.Struct({ id: GrantId, policy: GrantPolicy, target: GrantTarget });
export type Grant = typeof Grant.Type;

/** Which apps a person chose on the sign-in page: all of them, or one of their connections. */
export const GrantAccessChoice = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("all") }),
  Schema.Struct({ kind: Schema.Literal("connection"), id: ConnectionId }),
]);
export type GrantAccessChoice = typeof GrantAccessChoice.Type;
/**
 * What the consent and device approval pages send in {@link grantSettingsHeader}, JSON-encoded.
 * An omitted field keeps what the request's resource URL names, so a page that sends nothing
 * approves what the URL preselected.
 */
export const GrantSettings = Schema.Struct({
  access: Schema.optionalKey(GrantAccessChoice),
  mode: Schema.optionalKey(ApprovalMode),
});
export type GrantSettings = typeof GrantSettings.Type;
/** The request header that carries {@link GrantSettings} on consent and device approval. */
export const grantSettingsHeader = "x-executor-grant-settings";

/** How `/mcp/whoami` describes a grant's apps. */
export const WhoamiAccess = Schema.Union([
  /** Every app the user can use. */
  Schema.Struct({ kind: Schema.Literal("all") }),
  /** Whatever the named connection currently allows, over this many apps. */
  Schema.Struct({
    kind: Schema.Literal("connection"),
    id: ConnectionId,
    name: Schema.String,
    apps: Schema.Number,
  }),
  /** Tools of this many apps, selected on the grant itself (narrowed after sign-in). */
  Schema.Struct({ kind: Schema.Literal("tools"), apps: Schema.Number }),
]);
export type WhoamiAccess = typeof WhoamiAccess.Type;
/**
 * `GET <MCP origin>/mcp/whoami`: what the presented MCP credential reaches. Authenticated exactly
 * like the MCP endpoint. `organization` is null on local, which has none.
 */
export const McpWhoami = Schema.Struct({
  organization: Schema.NullOr(
    Schema.Struct({ id: Schema.String, slug: Schema.String, name: Schema.String }),
  ),
  access: WhoamiAccess,
  mode: ApprovalMode,
});
export type McpWhoami = typeof McpWhoami.Type;
/** The path of {@link McpWhoami} on an MCP origin. */
export const mcpWhoamiPath = "/mcp/whoami";

/** OAuth resources must be provisioned before this host accepts requests. */
export class OAuthResourceProvisioningFailed extends Schema.TaggedError<OAuthResourceProvisioningFailed>()(
  "OAuthResourceProvisioningFailed",
  {},
) {}

/**
 * What a grant record serves. `consented` is the target its consent's resource names. A record
 * that stores its mode serves that mode and its stored connection.
 *
 * A record without a mode was approved before records stored one: it serves what its consent's
 * resource names, as it did then, and only if its stored connection agrees with that resource.
 * Data step `12_store_agent_grant_modes` stores the mode on every such record; remove this branch
 * once it has applied on every host. API grants store neither and serve the API.
 */
export const recordedTarget = (
  record: { readonly mode?: ApprovalMode | null; readonly connection?: ConnectionId | null },
  consented: GrantTarget,
): GrantTarget | undefined => {
  const connection = record.connection ?? undefined;
  const mode = record.mode ?? undefined;
  if (consented.kind === "api")
    return mode === undefined && connection === undefined ? consented : undefined;
  if (mode === undefined) return connection === consented.connection ? consented : undefined;
  return connection === undefined ? { kind: "mcp", mode } : { kind: "mcp", mode, connection };
};

/**
 * Missing URL mode retains the original model-mode default. A connection is optional;
 * duplicates and malformed values of either parameter are invalid.
 */
export const requestedMcpAddress = (url: URL): McpAddress | undefined => {
  const modes = url.searchParams.getAll("elicitation_mode");
  const connections = url.searchParams.getAll("connection");
  if (modes.length > 1 || connections.length > 1) return undefined;
  const mode = modes.length === 0 ? "model" : modes[0];
  if (!Schema.is(ApprovalMode)(mode)) return undefined;
  if (connections.length === 0) return { mode };
  const connection = connections[0];
  return Schema.is(ConnectionId)(connection) ? { mode, connection } : undefined;
};
const mcpQuery = (address: McpAddress) => {
  const query = new URLSearchParams();
  if (address.connection !== undefined) query.set("connection", address.connection);
  if (address.mode !== "model") query.set("elicitation_mode", address.mode);
  const encoded = query.toString();
  return encoded === "" ? "" : `?${encoded}`;
};
/** Canonical OAuth audience for each MCP address. Query parameters are valid RFC 8707 resource URIs. */
export const mcpResource = (resourceOrigin: string, address: McpAddress) =>
  `${resourceOrigin}/mcp${mcpQuery(address)}`;

/**
 * The origins one kind of resource is served at. The first is canonical: URLs shown to people
 * and the audience of a request that names no resource use it. Every listed origin keeps
 * accepting the grants issued for it, so a deployment that adds a hostname lists it beside the
 * ones clients already use.
 */
export type OriginList = readonly [string, ...string[]];
/**
 * Where a deployment serves its MCP resources (`<origin>/mcp...`) and its API resource
 * (`<origin>/api`). The two kinds may live on different hosts. A grant names exactly one
 * resource, and its token works at every origin of that resource's kind.
 */
export interface ResourceOrigins {
  readonly mcp: OriginList;
  readonly api: OriginList;
}
/** A deployment that serves both kinds of resource on one origin only. */
export const singleResourceOrigin = (origin: string): ResourceOrigins => ({
  mcp: [origin],
  api: [origin],
});
/**
 * The origin of `origins` a request reached, from its `Host`. Discovery names the URL the client
 * called, because clients refuse metadata for another resource; any other host gets the
 * canonical origin.
 */
export const requestResourceOrigin = (origins: OriginList, host: string | undefined) =>
  origins.find((origin) => new URL(origin).host === host) ?? origins[0];
/** Every approval mode for the full-access URL, or for one connection's URL, at every MCP origin. */
export const mcpOAuthResources = (mcpOrigins: OriginList, connection?: ConnectionId) =>
  mcpOrigins.flatMap((origin) =>
    ApprovalMode.literals.map((mode) => ({
      identifier: mcpResource(origin, connection === undefined ? { mode } : { mode, connection }),
      allowedScopes: ["mcp", "offline_access"],
    })),
  );
/**
 * RFC 8707 makes `resource` optional. A request that names none is for the plain MCP URL
 * that discovery advertises, in its original model mode: no approval mode or connection is
 * implied. API authority is never a default; a request for the `executor` scope has none.
 */
export const defaultResource = (mcpOrigin: string, scope: string | undefined) =>
  scope?.split(" ").includes("executor") === true
    ? undefined
    : mcpResource(mcpOrigin, { mode: "model" });
/**
 * What exactly one known resource names: an API resource at an API origin or an MCP resource at
 * an MCP origin, with the mode and connection its URL preselects. Multi-resource consent is
 * refused. A grant's own record then decides its mode and connection; see `recordedTarget`.
 */
export const grantTarget = (
  origins: ResourceOrigins,
  resources: readonly string[],
): GrantTarget | undefined => {
  if (resources.length !== 1) return undefined;
  const resource = resources[0];
  if (resource === undefined) return undefined;
  const url = URL.parse(resource);
  if (url === null) return undefined;
  if (origins.api.includes(url.origin) && resource === `${url.origin}/api`) return { kind: "api" };
  if (!origins.mcp.includes(url.origin) || url.pathname !== "/mcp") return undefined;
  const address = requestedMcpAddress(url);
  // Only the canonical spelling is a resource; reordered or extra parameters are not.
  return address !== undefined && mcpResource(url.origin, address) === resource
    ? { kind: "mcp", ...address }
    : undefined;
};
/** Discovery and the authentication challenge carry the requested address into standard OAuth. */
export const mcpResourceMetadataUrl = (resourceOrigin: string, address: McpAddress) => {
  const query = new URLSearchParams();
  if (address.connection !== undefined) query.set("connection", address.connection);
  query.set("elicitation_mode", address.mode);
  return `${resourceOrigin}/.well-known/oauth-protected-resource/mcp?${query.toString()}`;
};
