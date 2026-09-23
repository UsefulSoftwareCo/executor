/** Product-owned MCP authority. No organization, browser session, or token is a grant. */
import {
  AppPermission,
  fullAuthority,
  selectedAuthority,
  selectsApp,
  selectsTool,
  type AuthorizationPolicy,
} from "@executor-js/authorization";
import type { AppId, ToolName } from "@executor-js/sdk/core";
export { AppPermission } from "@executor-js/authorization";
import { Schema } from "effect";

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
/** The OAuth resource approved for this grant, preserved through refresh. */
export const GrantTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("mcp"), mode: ApprovalMode }),
  Schema.Struct({ kind: Schema.Literal("api") }),
]);
export type GrantTarget = typeof GrantTarget.Type;
export const Grant = Schema.Struct({ id: GrantId, policy: GrantPolicy, target: GrantTarget });
export type Grant = typeof Grant.Type;
/** A current grant does not authorize this operation. No private resource details are exposed. */
export class GrantForbidden extends Schema.TaggedError<GrantForbidden>()("GrantForbidden", {}) {}

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
/** Protocol callers share the same exact app-selection rule as HTTP authorization. */
export const permitsApp = (policy: GrantPolicy, app: AppId) => selectsApp(policy, app);
/** Protocol callers share the same exact tool-selection rule as HTTP authorization. */
export const permitsTool = (policy: GrantPolicy, app: AppId, tool: ToolName) =>
  selectsTool(policy, app, tool);
/** An issued MCP grant cannot change mode by changing the request URL. */
export const permitsDelivery = (grant: Grant, mode: ApprovalMode) =>
  grant.target.kind === "mcp" &&
  grant.target.mode === mode &&
  (grant.policy.kind === "all" || grant.policy.approval === "client" || mode === "browser");

/** Missing URL mode retains the original model-mode default; duplicates and unknown modes are invalid. */
export const requestedMcpMode = (url: URL): ApprovalMode | undefined => {
  const modes = url.searchParams.getAll("elicitation_mode");
  if (modes.length === 0) return "model";
  return modes.length === 1 && Schema.is(ApprovalMode)(modes[0]) ? modes[0] : undefined;
};
/** Canonical OAuth audience for each MCP mode. Query parameters are valid RFC 8707 resource URIs. */
export const mcpResource = (origin: string, mode: ApprovalMode) =>
  mode === "model" ? `${origin}/mcp` : `${origin}/mcp?elicitation_mode=${mode}`;
/** All mode-specific resources use the same OAuth issuer and ordinary MCP scope. */
export const mcpOAuthResources = (origin: string) =>
  (["model", "native", "browser"] as const).map((mode) => ({
    identifier: mcpResource(origin, mode),
    allowedScopes: ["mcp", "offline_access"],
  }));
/** Select exactly one known resource. Multi-resource consent must not combine approval modes. */
export const grantTarget = (
  origin: string,
  resources: readonly string[],
): GrantTarget | undefined => {
  if (resources.length !== 1) return undefined;
  const resource = resources[0];
  if (resource === `${origin}/api`) return { kind: "api" };
  for (const mode of ["model", "native", "browser"] as const)
    if (resource === mcpResource(origin, mode)) return { kind: "mcp", mode };
  return undefined;
};
/** Discovery and the authentication challenge carry the requested mode into standard OAuth. */
export const mcpResourceMetadataUrl = (origin: string, mode: ApprovalMode) =>
  `${origin}/.well-known/oauth-protected-resource/mcp?elicitation_mode=${mode}`;
