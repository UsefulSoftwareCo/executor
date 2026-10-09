/** Product-owned MCP authority. No organization, browser session, or token is a grant. */
import {
  AppPermission,
  fullAuthority,
  selectedAuthority,
  type AuthorizationPolicy,
  permitsApp,
  eventAccess,
} from "@executor-js/authorization";
export { AppPermission } from "@executor-js/authorization";
import { AppId, ProfileId, ToolName } from "@executor-js/sdk/core";
import { UserFacingError, type ErrorPresentation } from "@executor-js/utils/user-facing-error";
import { Match, Schema } from "effect";

/** Stable authorization identity shared by access tokens, refresh tokens, and continuations. */
export const GrantId = Schema.NonEmptyString.pipe(Schema.brand("McpGrantId"));
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
/** What an MCP URL selects: its approval mode and, for a scoped connection, that connection. */
export const McpAddress = Schema.Struct({
  mode: ApprovalMode,
  connection: Schema.optionalKey(ConnectionId),
});
export type McpAddress = typeof McpAddress.Type;
/** The OAuth resource approved for this grant, preserved through refresh. */
export const GrantTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("mcp"), ...McpAddress.fields }),
  Schema.Struct({ kind: Schema.Literal("api") }),
]);
export type GrantTarget = typeof GrantTarget.Type;
export const Grant = Schema.Struct({ id: GrantId, policy: GrantPolicy, target: GrantTarget });
export type Grant = typeof Grant.Type;
/**
 * Why a current grant refused a request or operation. Each reason needs a different fix, so it
 * names the URL, app, runs-as target or tool involved; never a credential.
 */
export const GrantRefusal = Schema.Union([
  /** The grant serves another URL: a different connection or approval mode, or the API. */
  Schema.Struct({ reason: Schema.Literal("delivery"), issued: GrantTarget }),
  /**
   * Its tools need browser approval, which the approval mode of its own URL cannot ask for.
   * Consent and narrowing refuse this, so only a grant narrowed before narrowing did holds it.
   */
  Schema.Struct({ reason: Schema.Literal("approval"), mode: ApprovalMode }),
  /** The grant includes none of this app's tools. */
  Schema.Struct({ reason: Schema.Literal("app"), app: AppId }),
  /** The grant includes the app, but not running it as this profile, or without one. */
  Schema.Struct({
    reason: Schema.Literal("target"),
    app: AppId,
    profile: Schema.optionalKey(ProfileId),
  }),
  /** The grant includes the app and how it runs, but not this tool. */
  Schema.Struct({ reason: Schema.Literal("tool"), app: AppId, tool: ToolName }),
  /** The grant selects some of this app's events, and not the one requested. */
  Schema.Struct({ reason: Schema.Literal("events"), app: AppId }),
]);
export type GrantRefusal = typeof GrantRefusal.Type;

/** OAuth resources must be provisioned before this host accepts requests. */
export class OAuthResourceProvisioningFailed extends Schema.TaggedError<OAuthResourceProvisioningFailed>()(
  "OAuthResourceProvisioningFailed",
  {},
) {}

/** Adapt the OAuth grant DTO to shared product authority. Approval delivery stays in this module. */
export const grantAuthorization = (policy: GrantPolicy): AuthorizationPolicy =>
  policy.kind === "all"
    ? fullAuthority
    : selectedAuthority(["discover", "run"], { kind: "tools", apps: policy.apps });
/**
 * Why a grant with this policy could not serve even the URL it is issued for, or undefined
 * when it can. Tools that need browser approval need a browser-mode URL to ask for it. Consent
 * and narrowing refuse such a policy, so no URL is left that could use the grant.
 */
export const approvalRefusal = (
  policy: GrantPolicy,
  target: GrantTarget,
): GrantRefusal | undefined =>
  target.kind === "mcp" &&
  policy.kind === "tools" &&
  policy.approval === "browser" &&
  target.mode !== "browser"
    ? { reason: "approval", mode: target.mode }
    : undefined;
/**
 * Where one of an app's events may reach a grant with this policy, or undefined when it no
 * longer may. See `eventAccess`.
 */
export const grantEventAccess = (policy: GrantPolicy, app: AppId, event: string) => {
  const authority = grantAuthorization(policy);
  return permitsApp(authority, app) ? eventAccess(authority, app, event) : undefined;
};
/**
 * Why an issued grant cannot serve this MCP URL, or undefined when it can. A grant cannot
 * change mode or connection by changing the request URL.
 */
export const deliveryRefusal = (grant: Grant, address: McpAddress): GrantRefusal | undefined =>
  grant.target.kind !== "mcp" ||
  grant.target.mode !== address.mode ||
  grant.target.connection !== address.connection
    ? { reason: "delivery", issued: grant.target }
    : approvalRefusal(grant.policy, grant.target);
/** Browser approval pages answer only grants issued for a browser-mode URL. */
export const permitsBrowserApproval = (grant: Grant) =>
  grant.target.kind === "mcp" &&
  deliveryRefusal(grant, { ...grant.target, mode: "browser" }) === undefined;

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

const notBypassed = "Do not bypass authorization.";
/** Each refusal names what the grant covers. Connection IDs, app IDs and tool names are not secret. */
const refusalPresentation = (refusal: GrantRefusal): ErrorPresentation =>
  Match.value(refusal).pipe(
    Match.discriminatorsExhaustive("reason")({
      delivery: ({ issued }) => {
        if (issued.kind === "api")
          return {
            title: "API credential",
            description: "This credential was issued for the Executor API, not for MCP.",
            recovery: {
              action: "Connect at the MCP URL to get a credential for it, then retry.",
              instructions: `A credential serves the one resource it was issued for. Connect the MCP client at the MCP URL so it receives its own credential, and verify that tools are listed. ${notBypassed}`,
            },
          };
        const url = `/mcp${mcpQuery(issued)}`;
        return {
          title: "Different MCP URL",
          description: `This credential works only at the MCP URL ending in ${url}, not at the URL of this request.`,
          recovery: {
            action: `Connect at the MCP URL ending in ${url}, or connect again at this URL to get a credential for it, then retry.`,
            instructions: `An MCP credential is bound to one MCP URL, including its connection and elicitation_mode parameters. Credentials not issued through a connection work only at URLs without a connection parameter. Use the URL this credential works at, or connect again at the request's URL, and verify that tools are listed. ${notBypassed}`,
          },
        };
      },
      approval: ({ mode }) => ({
        title: "Browser approval unavailable",
        description: `This credential’s grant needs its tool calls approved in the browser, but it was issued for an MCP URL with elicitation_mode=${mode}, which cannot ask for that approval. No MCP URL can use it.`,
        recovery: {
          action: "Connect again at the MCP URL with elicitation_mode=browser, then retry.",
          instructions: `The grant was narrowed to selected tools with browser approval after it was issued for a URL in another approval mode, which Executor no longer allows. A grant serves only the URL it was issued for. Connect again at the same MCP URL with elicitation_mode=browser, choose its tools, and verify that tools are listed. ${notBypassed}`,
        },
      }),
      app: ({ app }) => ({
        title: "App not included",
        description: `This credential’s grant does not include the app ${app}.`,
        recovery: {
          action:
            "Use an app the grant includes, or add this app to its connection or grant, then retry.",
          instructions: `An MCP grant, or the connection it was issued through, lists the apps its client may discover and run. Check whether this app should be available to the client. If so, add it to the connection, or connect again and include it when approving access, then verify that the app's tools are listed. ${notBypassed}`,
        },
      }),
      target: ({ app, profile }) => ({
        title: "Runs-as target not included",
        description: `This credential’s grant includes the app ${app}, but not running it ${profile === undefined ? "without a profile" : `as the profile ${profile}`}.`,
        recovery: {
          action:
            "Run the app as the grant allows, or add this target to its connection, then retry.",
          instructions: `For each app, an MCP grant or its connection lists how the app may run: as specific profiles, or without a profile. Check the runs-as choices for this app. Use one the grant includes, or add this one to the connection, then verify that the call succeeds. ${notBypassed}`,
        },
      }),
      tool: ({ app, tool }) => ({
        title: "Tool not included",
        description: `This credential’s grant does not include the tool “${tool}” of the app ${app}.`,
        recovery: {
          action:
            "Use a tool the grant includes, or add this tool to its connection or grant, then retry.",
          instructions: `An MCP grant, or its connection, selects each app's tools by exact name, as all tools, or as read-only tools only; a read-only selection excludes every tool not marked read-only. Check whether this tool should be available to the client. If so, change the connection's tool selection, or connect again and include the tool, then verify that the call succeeds. ${notBypassed}`,
        },
      }),
      events: ({ app }) => ({
        title: "Events not included",
        description: `This credential’s grant does not include this event of the app ${app}.`,
        recovery: {
          action:
            "Add this event to the app's event selection in this connection or grant, then retry.",
          instructions: `An MCP grant, or its connection, selects each app's events as all events or by exact name, beside its tools. Check whether this client should receive the event. If so, change the connection's event selection for the app, or connect again with it, then verify that events/list includes it. ${notBypassed}`,
        },
      }),
    }),
  );
/** A current grant does not authorize this request or operation, with the reason it was refused. */
export const GrantForbidden = UserFacingError.define({
  tag: "GrantForbidden",
  status: 403,
  fields: { refusal: GrantRefusal },
  recorded: ({ refusal }) => `The grant does not authorize this request (${refusal.reason})`,
  presentation: ({ refusal }) => refusalPresentation(refusal),
});
export type GrantForbidden = typeof GrantForbidden.Type;
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
 * Select exactly one known resource: an API resource at an API origin or an MCP resource at an
 * MCP origin. Multi-resource consent must not combine approval modes.
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
