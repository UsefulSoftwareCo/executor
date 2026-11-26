import type { Account, AppId, VersionId, LinkedAccounts } from "@executor-js/sdk/core";
export type McpAccount = Pick<Account, "id" | "label" | "description">;
export type McpAppAccounts = LinkedAccounts<McpAccount>;
export interface McpTargetInput {
  readonly app: AppId;
  readonly version?: VersionId | undefined;
}
