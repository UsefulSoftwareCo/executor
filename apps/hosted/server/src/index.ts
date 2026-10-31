/** Hosted product composition, shared by cloud and self-host only. */
export { requestServices } from "./implementation/request-services.ts";
export * from "./contracts/product-analytics.ts";
export { withExecutorAnalytics } from "./implementation/product-analytics.ts";
export { withDeploySetupWake } from "./implementation/deploy-setup.ts";
export { HostedApi } from "./contracts/api.ts";
export { HostedCatalog } from "./contracts/catalog.ts";
export { hostedHandlers } from "./implementation/api.ts";
export { catalogLive } from "./implementation/catalog.ts";
export {
  hostedApi,
  hostedApiDocumentRoute,
  hostedApiRevision,
  lazyHostedApiDocument,
  type LazyHostedApiDocument,
} from "./implementation/api-document.ts";
export {
  callerSpanAttributes,
  CurrentUserId,
  ApiAuthentication,
  Authentication,
  AuthenticationUnavailable,
  RequireUser,
  CurrentPrincipal,
} from "./contracts/auth.ts";
export { authOptions, authSettings, sessionPrincipal } from "./implementation/auth.ts";
export * from "./contracts/organization.ts";
export {
  CallStateCache,
  ConcurrentStatements,
  HostedExecutor,
  StatementBatch,
  type CallState,
  type StatementGroups,
} from "./contracts/executor.ts";
export { OrganizationDefaults } from "./contracts/organization-defaults.ts";
export { organizationDefaults } from "./implementation/organization-defaults.ts";
export { executorDefaultRedeployed } from "./implementation/executor-app-upgrades.ts";
export {
  queueCatalogAppUpdates,
  withCatalogAppUpdates,
  type CatalogAppFeed,
} from "./implementation/catalog-app-updates.ts";
export { hostedAppCopies } from "./implementation/profile-app-copies.ts";
export { linkAppAccount, linkUserAccount } from "./implementation/app-accounts.ts";
export { memberSetupProgress, type SetupProgress } from "./implementation/setup-progress.ts";
export {
  lookupMembership,
  lookupOrganizationSlug,
  noOrganizationRemovals,
} from "./implementation/organization.ts";
export { requireOrganizationAdmin, requireOrganizationOwner } from "./implementation/access.ts";
export { hostedMiddlewareLive } from "./implementation/middleware.ts";
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
export * from "./contracts/oauth-client-metadata.ts";
export {
  FirstPartyOAuthClientDefinition,
  firstPartyOAuthClientDefinitions,
  firstPartyOAuthClients,
  firstPartyOAuthCredentialSettings,
} from "./implementation/first-party-oauth.ts";
export {
  clientMetadataDocument,
  clientMetadataSetting,
  type ClientMetadataSetting,
} from "./implementation/oauth-client-metadata.ts";
export type {
  HostedAccountConnection,
  HostedOAuthSignIn,
  HostedOAuthStartResult,
} from "./contracts/accounts.ts";

export { hostedMcpBackend } from "./implementation/mcp.ts";

export * from "./contracts/mcp.ts";
export {
  mcpBrowserGrantError,
  mcpConnectionStore,
  provisionHostedConnectionResources,
  provisionHostedOAuthResources,
  type HostedOAuthOrigins,
  type GrantObservers,
  type RefreshRejection,
} from "./implementation/mcp-oauth.ts";
export { authEndpointTemplates, grantExpiry, type GrantExpiry } from "@executor-js/mcp-auth/oauth";
export type { OriginList, ResourceOrigins } from "@executor-js/mcp-auth";
export { ConnectionId, mcpOAuthResources, singleResourceOrigin } from "@executor-js/mcp-auth";
export { apiBearerAccess, mcpBearerAccess } from "./implementation/bearer-access.ts";
export {
  makeHostedMcp,
  mcpSessionKey,
  dispatchHostedMcp,
  authenticatedMcp,
  mcpChallenge,
  mcpProtectedResource,
  mcpAuthorizationServer,
} from "./implementation/mcp-http.ts";

export { apiChallenge, apiProtectedResource } from "./implementation/api-oauth.ts";

export { browserTelemetry } from "./implementation/telemetry.ts";

export { hostedWebhookCallback } from "./implementation/webhooks.ts";
export { browserMcpRequest, hostedMcpApproval } from "./implementation/mcp-approvals.ts";

export { makeOrganizationIcons } from "./implementation/organization-icons.ts";

export { resolveOrganizationReference } from "./implementation/organization-reference.ts";

export * from "./contracts/schedules.ts";
export { makeScheduledAuthority } from "./implementation/schedules.ts";
