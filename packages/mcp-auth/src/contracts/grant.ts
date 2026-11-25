import { AppPermission } from "@executor-js/authorization";
export { AppPermission } from "@executor-js/authorization";
import { Schema } from "effect";

export const GrantId = Schema.NonEmptyString.pipe(Schema.brand("McpGrantId"));
export type GrantId = typeof GrantId.Type;
export const GrantPolicy = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("tools"),
    apps: Schema.Array(AppPermission),
    approval: Schema.Literals(["browser", "client"]),
  }),
  Schema.Struct({ kind: Schema.Literal("all") }),
]);
export type GrantPolicy = typeof GrantPolicy.Type;
export const ApprovalMode = Schema.Literals(["model", "native", "browser", "automatic"]);
export type ApprovalMode = typeof ApprovalMode.Type;
export const ConnectionId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/u)).pipe(
  Schema.brand("McpConnectionId"),
);
export type ConnectionId = typeof ConnectionId.Type;
export const McpAddress = Schema.Struct({
  mode: ApprovalMode,
  connection: Schema.optionalKey(ConnectionId),
});
export type McpAddress = typeof McpAddress.Type;
export const GrantTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("mcp"), ...McpAddress.fields }),
  Schema.Struct({ kind: Schema.Literal("api") }),
]);
export type GrantTarget = typeof GrantTarget.Type;
export const Grant = Schema.Struct({ id: GrantId, policy: GrantPolicy, target: GrantTarget });
export type Grant = typeof Grant.Type;

export const GrantAccessChoice = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("all") }),
  Schema.Struct({ kind: Schema.Literal("connection"), id: ConnectionId }),
]);
export type GrantAccessChoice = typeof GrantAccessChoice.Type;
export const GrantSettings = Schema.Struct({
  access: Schema.optionalKey(GrantAccessChoice),
  mode: Schema.optionalKey(ApprovalMode),
});
export type GrantSettings = typeof GrantSettings.Type;
export const grantSettingsHeader = "x-executor-grant-settings";

export const WhoamiAccess = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("all") }),
  Schema.Struct({
    kind: Schema.Literal("connection"),
    id: ConnectionId,
    name: Schema.String,
    apps: Schema.Number,
  }),
  Schema.Struct({ kind: Schema.Literal("tools"), apps: Schema.Number }),
]);
export type WhoamiAccess = typeof WhoamiAccess.Type;
export const McpWhoami = Schema.Struct({
  organization: Schema.NullOr(
    Schema.Struct({ id: Schema.String, slug: Schema.String, name: Schema.String }),
  ),
  access: WhoamiAccess,
  mode: ApprovalMode,
});
export type McpWhoami = typeof McpWhoami.Type;
export const mcpWhoamiPath = "/mcp/whoami";

export class OAuthResourceProvisioningFailed extends Schema.TaggedError<OAuthResourceProvisioningFailed>()(
  "OAuthResourceProvisioningFailed",
  {},
) {}

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
export const namedApprovalMode = (url: URL): ApprovalMode | undefined =>
  url.searchParams.has("elicitation_mode") ? requestedMcpAddress(url)?.mode : undefined;
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

export type OriginList = readonly [string, ...string[]];
export interface ResourceOrigins {
  readonly mcp: OriginList;
  readonly api: OriginList;
  readonly legacyMcp?: string | undefined;
}
export const singleResourceOrigin = (origin: string): ResourceOrigins => ({
  mcp: [origin],
  api: [origin],
});
export const requestResourceOrigin = (origins: OriginList, host: string | undefined) =>
  origins.find((origin) => new URL(origin).host === host) ?? origins[0];
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
  const legacy = legacyMcpTarget(origins, resource);
  if (legacy !== undefined) return { kind: "mcp", mode: legacy.mode };
  if (!origins.mcp.includes(url.origin) || url.pathname !== "/mcp") return undefined;
  const address = requestedMcpAddress(url);
  return address !== undefined && mcpResource(url.origin, address) === resource
    ? { kind: "mcp", ...address }
    : undefined;
};
export interface LegacyMcpPath {
  readonly selector?: string | undefined;
  readonly toolkit?: string | undefined;
}

const legacySegment = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

export const legacyMcpPath = (pathname: string): LegacyMcpPath | undefined => {
  const segments = pathname.split("/").slice(1);
  const valid = (segment: string | undefined): segment is string =>
    segment !== undefined && legacySegment.test(segment);
  const [first, second, third, fourth] = segments;
  if (segments.length === 1 && first === "mcp") return {};
  if (segments.length === 2 && second === "mcp" && valid(first)) return { selector: first };
  if (segments.length === 3 && first === "mcp" && second === "toolkits" && valid(third))
    return { toolkit: third };
  if (
    segments.length === 4 &&
    second === "mcp" &&
    third === "toolkits" &&
    valid(first) &&
    valid(fourth)
  )
    return { selector: first, toolkit: fourth };
  return undefined;
};

export const legacyMcpPathname = (path: LegacyMcpPath) =>
  `${path.selector === undefined ? "" : `/${path.selector}`}/mcp${path.toolkit === undefined ? "" : `/toolkits/${path.toolkit}`}`;

export const legacyMcpResource = (origin: string, path: LegacyMcpPath, mode: ApprovalMode) =>
  `${origin}${legacyMcpPathname(path)}${mcpQuery({ mode })}`;

/** Where a legacy MCP URL's resource metadata is, for its 401 challenge (RFC 9728). */
export const legacyMcpResourceMetadataUrl = (
  origin: string,
  path: LegacyMcpPath,
  mode: ApprovalMode,
) =>
  `${origin}/.well-known/oauth-protected-resource${legacyMcpPathname(path)}?${new URLSearchParams({ elicitation_mode: mode }).toString()}`;

export const legacyMcpTarget = (
  origins: ResourceOrigins,
  resource: string,
): { readonly path: LegacyMcpPath; readonly mode: ApprovalMode } | undefined => {
  if (origins.legacyMcp === undefined) return undefined;
  const url = URL.parse(resource);
  if (url === null || url.origin !== origins.legacyMcp) return undefined;
  const path = legacyMcpPath(url.pathname);
  const address = requestedMcpAddress(url);
  if (path === undefined || address === undefined || address.connection !== undefined)
    return undefined;
  return legacyMcpResource(url.origin, path, address.mode) === resource
    ? { path, mode: address.mode }
    : undefined;
};

export const mcpResourceMetadataUrl = (resourceOrigin: string, address: McpAddress) => {
  const query = new URLSearchParams();
  if (address.connection !== undefined) query.set("connection", address.connection);
  query.set("elicitation_mode", address.mode);
  return `${resourceOrigin}/.well-known/oauth-protected-resource/mcp?${query.toString()}`;
};
