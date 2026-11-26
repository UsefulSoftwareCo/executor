import { Schema } from "effect";
import { OwnerId, OwnerMoveBlocked, OwnerMoveCollision } from "@executor-js/sdk/core";

export const LocalOwnerMigration = Schema.Struct({
  status: Schema.Literals(["pending", "collision", "blocked"]),
  owners: Schema.Array(OwnerId),
  to: OwnerId,
  collisions: Schema.Array(OwnerMoveCollision),
  blocked: Schema.Array(OwnerMoveBlocked),
});
export type LocalOwnerMigration = typeof LocalOwnerMigration.Type;

export const blockedRecovery = (
  record: OwnerMoveBlocked,
): { readonly action: string; readonly request?: string } => {
  const owner = record.owner === undefined ? "" : `?owner=${encodeURIComponent(record.owner)}`;
  switch (record.kind) {
    case "oauth_client":
      return {
        action: "Remove it with the API key",
        request: `DELETE /v1/oauth-clients/${encodeURIComponent(record.id)}${owner}`,
      };
    case "oauth_grant":
      return {
        action: "Remove the account with the API key, and connect it again once the move is done",
        request: `DELETE /v1/accounts/${encodeURIComponent(record.id)}${owner}`,
      };
    case "oauth_sign_in":
      return { action: "It expires within 10 minutes" };
    case "tool_approval":
      return { action: "It expires within 15 minutes" };
    case "account_connection":
      return {
        action:
          "Executor cannot remove it. Stop Executor and restore the data directory from a backup taken before it was written",
      };
  }
};
