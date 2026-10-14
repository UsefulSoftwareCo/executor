/** The accounts the caller linked for each of an app's requirements. */
import type { Account, AppId, DeploymentId, LinkedAccounts } from "@executor-js/sdk/core";
/** One account the caller linked to an app, as agents see it. */
export type McpAccount = Pick<Account, "id" | "label" | "description">;
/**
 * Every user requirement of the app with the caller's linked accounts for it, oldest link first,
 * after product and grant checks. Calls use them: the newest for a plain requirement, all for
 * many(). App requirements are left out: the backend fills them from the app links.
 */
export type McpAppAccounts = LinkedAccounts<McpAccount>;
/**
 * The app whose linked accounts are requested, for the requirements of its active deployment or
 * of a retained one in its lineage that a read pins.
 */
export interface McpTargetInput {
  readonly app: AppId;
  readonly deployment?: DeploymentId | undefined;
}
