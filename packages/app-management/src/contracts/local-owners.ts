/**
 * Why local data step `7_local_owners` has not yet given `local` the records of other owners, as
 * the local dashboard shows it. Until it does, those records stay as they are: their apps are
 * listed but local cannot connect accounts to them. The step never merges two records; a person
 * resolves each one listed here, then restarts Executor, and the next start tries again.
 */
import { Schema } from "effect";
import { OwnerId, OwnerMoveBlocked, OwnerMoveCollision } from "@executor-js/sdk/core";

export const LocalOwnerMigration = Schema.Struct({
  /**
   * - `pending`: this start only reported (`EXECUTOR_DATA_STEPS=report`); a start that applies
   *   data steps moves the records.
   * - `collision`: moving would give `local` two apps with one name or slug, or two OAuth clients
   *   holding the same credentials. No record moved.
   * - `blocked`: a record the move has to read does not decrypt with this install's key, or the
   *   product would not read it back. No record moved; see `blockedRecovery`.
   */
  status: Schema.Literals(["pending", "collision", "blocked"]),
  /** The owners whose records wait to move. */
  owners: Schema.Array(OwnerId),
  /** Where they move. */
  to: OwnerId,
  collisions: Schema.Array(OwnerMoveCollision),
  blocked: Schema.Array(OwnerMoveBlocked),
});
export type LocalOwnerMigration = typeof LocalOwnerMigration.Type;

/**
 * What a person does so a record the move cannot read stops blocking it, as the log and the
 * dashboard say: remove it through the API with the local API key (`EXECUTOR_API_KEY` as a
 * bearer token), wait for it to expire, or, for a connection, which nothing removes, restore the
 * data directory. The dashboard has no page for another owner's records.
 */
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
