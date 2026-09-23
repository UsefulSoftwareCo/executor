/** Shared authorization vocabulary and pure decisions for Executor products. */
export {
  Action,
  AppPermission,
  ToolSelection,
  AuthorizationPolicy,
  fullAuthority,
  noAuthority,
  selectedAuthority,
  permitsAction,
  permitsApp,
  permitsTool,
  selectsApp,
  selectsTool,
  isToolSelectionSubset,
  permittedAppIds,
} from "./contracts/policy.ts";
