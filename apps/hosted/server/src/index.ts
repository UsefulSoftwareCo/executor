/** Hosted product composition, shared by cloud and self-host only. */
export { requestServices } from "./implementation/request-services.ts";
export * from "./contracts/product-analytics.ts";
export { HostedApi } from "./contracts/api.ts";
export { HostedCatalog } from "./contracts/catalog.ts";
export { hostedHandlers } from "./implementation/api.ts";
export { catalogLive } from "./implementation/catalog.ts";
export {
  CurrentUserId,
  ApiAuthentication,
  Authentication,
  AuthenticationUnavailable,
  RequireUser,
  CurrentPrincipal,
} from "./contracts/auth.ts";
export {
  authOptions,
  authSettings,
  accountOAuthClientMetadataPath,
  accountOAuthClientMetadataUrl,
  hostedOAuthClientMetadata,
  requireUserLive,
  sessionPrincipal,
} from "./implementation/auth.ts";
export * from "./contracts/organization.ts";
export { HostedExecutor } from "./contracts/executor.ts";
export { OrganizationDefaults } from "./contracts/organization-defaults.ts";
export { organizationDefaults } from "./implementation/organization-defaults.ts";
export {
  lookupMembership,
  lookupOrganizationSlug,
  requireOrganizationLive,
} from "./implementation/organization.ts";
export { requireOrganizationAdmin, requireOrganizationOwner } from "./implementation/access.ts";
export * from "./contracts/organization-removal.ts";
export {
  deleteOrganizationRecords,
  beginOrganizationRemoval,
  previewOrganizationRemoval,
  removeOrganizationDurably,
} from "./implementation/organization-removal.ts";
export { makeOrganizationRemovals } from "./implementation/organization-removals.ts";
export { migrateOrganizationRemovals } from "./implementation/organization-removal-schema.ts";

export { hostedOAuthCallback } from "./implementation/accounts.ts";
export type {
  HostedAccountConnection,
  HostedOAuthSignIn,
  HostedOAuthStartResult,
} from "./contracts/accounts.ts";

export { hostedMcpBackend } from "./implementation/mcp.ts";

export * from "./contracts/mcp.ts";
export {
  mcpAuthenticationError,
  apiAuthenticationError,
  provisionHostedOAuthResources,
} from "./implementation/mcp-oauth.ts";
export {
  makeHostedMcp,
  mcpSessionKey,
  dispatchHostedMcp,
  authenticatedMcp,
  mcpProtectedResource,
  mcpAuthorizationServer,
} from "./implementation/mcp-http.ts";

export { apiChallenge, apiProtectedResource } from "./implementation/api-oauth.ts";

export { browserTelemetry } from "./implementation/telemetry.ts";

export { hostedWebhookCallback } from "./implementation/webhooks.ts";
export { browserMcpRequest, hostedMcpApproval } from "./implementation/mcp-approvals.ts";

export { makeOrganizationIcons } from "./implementation/organization-icons.ts";

export * from "./contracts/execution-admission.ts";

export { resolveOrganizationReference } from "./implementation/organization-reference.ts";

export * from "./contracts/schedules.ts";
export { makeScheduledAuthority } from "./implementation/schedules.ts";
