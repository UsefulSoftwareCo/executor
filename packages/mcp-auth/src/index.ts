/** Shared grant contracts and enforcement for product hosts. */
export {
  GrantId,
  ApprovalMode,
  GrantTarget,
  requestedMcpMode,
  mcpResource,
  mcpOAuthResources,
  grantTarget,
  mcpResourceMetadataUrl,
  GrantPolicy,
  grantAuthorization,
  Grant,
  AppPermission,
  GrantForbidden,
  permitsApp,
  permitsTool,
  permitsDelivery,
} from "./contracts/grant.ts";
export { restrictMcpBackend } from "./implementation/backend.ts";
