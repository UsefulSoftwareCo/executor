/** MCP paths retain the real app and distinguish each saved profile below it. */
import type { Account, App, AppId, Profile, ProfileId } from "@executor-js/sdk/core";
/** An account-free app call or a particular revision of one personal profile. */
export type McpTarget =
  | { readonly kind: "app" }
  | {
      readonly kind: "profile";
      readonly id: ProfileId;
      readonly revision: number;
      readonly label: string;
    };
/** Products authorize these records before projection; this function grants no access. */
export function appTargets(
  app: App,
  profiles: readonly Profile[],
  accounts: readonly Pick<Account, "id" | "label">[],
): readonly McpTarget[] {
  const targets: McpTarget[] = profiles
    .filter((item) => item.enabled && item.status !== "removed" && item.status !== "removing")
    .map((item) => {
      const ids = new Set(Object.values(item.accounts).flat());
      const labels = accounts
        .filter((account) => ids.has(account.id))
        .map((account) => account.label);
      return {
        kind: "profile",
        id: item.id,
        revision: item.revision,
        label: item.name ?? (labels.length === 0 ? "Personal profile" : labels.join(", ")),
      };
    });
  if (Object.keys(app.requirements.accounts).length === 0) targets.unshift({ kind: "app" });
  return targets;
}
/** An app filter remains separate from the profile's immutable identity. */
export interface McpTargetInput {
  readonly app: AppId;
}
