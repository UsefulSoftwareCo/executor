/**
 * Local only, one-off: give `local` every record of an owner local does not assign. Local assigns
 * two owners: `local` for the user's records and `executor-local` for the server's own Executor
 * app and its API key account. Before it did, agents could name any owner when creating apps,
 * OAuth clients and connections, and those records were then missing from the dashboard and their
 * apps could not open. Hosted owners are organizations; the step never moves one.
 *
 * One item covers the whole move, in one transaction. Outcomes other than `moved` change no
 * product row or ciphertext; like every outcome, the journal records the attempt.
 * - `moved` / `would_move`: every record of the other owners moves, or would move, to `local`.
 * - `unchanged`: no record has another owner.
 * - `collision`: moving would give `local` two apps with one name or slug, or two clients holding
 *   the same credentials. The log and the dashboard name them, and the next start retries once a
 *   person renames or removes one of each.
 * - `blocked`: a record the move has to read does not decrypt with this install's key, or the
 *   product would not read it back. Moving the rest would strand it under its old owner. The log
 *   and the dashboard name each by kind and ID, never its content, with what a person does about
 *   it (`blockedRecovery`), and the next start retries.
 * - `storage_before_step`: the SDK schema is older than `localOwnersStorage`.
 * - `organization_owner`: a record belongs to a hosted organization.
 * - `unavailable`: storage failed; the next start retries.
 *
 * Once the step has moved records, no local release that lets an agent name another owner may
 * open the database again: records it wrote would keep that owner, and the applied step never
 * looks again. Every release before this step refuses SDK schema 4.0.11 (`checkMigration`), so
 * the step runs only on that schema or later.
 */
import {
  OwnerMovesHost,
  type Executor,
  type OwnerMoveBlocked,
  type OwnerMoveCollision,
  type OwnerId,
  type StorageError,
} from "@executor-js/sdk/core";
import { Effect } from "effect";
import type { DataStep, DataStepMode } from "../contracts/data-steps.ts";
import { blockedRecovery, type LocalOwnerMigration } from "../contracts/local-owners.ts";

/** The owners a local host assigns. Hosts without them never run the step. */
export interface LocalOwnersHost {
  readonly executor: Executor;
  readonly localOwners?: {
    /** Where every other owner's records move. */
    readonly owner: OwnerId;
    /** Owners that keep their records: `owner` and the server's own Executor app's. */
    readonly kept: ReadonlyArray<OwnerId>;
    /** The SDK schema version the database records, once migrated. */
    readonly storage: Effect.Effect<string | undefined, StorageError>;
    /** Why records have not moved yet, for the dashboard; called only when they have not. */
    readonly status: (status: LocalOwnerMigration) => Effect.Effect<void>;
  };
}

/** The journal name. It never changes and the step never repeats. */
export const localOwnersStepName = "7_local_owners";

/**
 * The first SDK schema no local release before this step opens. The step ships with or after it,
 * so a database it has moved records in cannot be served by a release that writes other owners.
 */
export const localOwnersStorage = "4.0.11";

/** Hosted organization owners; see `organizationOwner` in the hosted server. */
const organizationPrefix = "organization:";

/** Whether a dotted version is at least another. A version that is not numeric is not. */
const atLeast = (version: string, minimum: string) => {
  const have = version.split(".").map(Number);
  const need = minimum.split(".").map(Number);
  for (let index = 0; index < Math.max(have.length, need.length); index++) {
    const left = have[index] ?? 0;
    const right = need[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
};

const describe = (collision: OwnerMoveCollision) => {
  const records = collision.records
    .map((record) => `${record.id} (owner ${JSON.stringify(record.owner)})`)
    .join(", ");
  const key = JSON.stringify(collision.key);
  switch (collision.kind) {
    case "app_name":
      return `apps named ${key}: ${records}`;
    case "app_slug":
      return `apps with the slug ${key}: ${records}`;
    case "oauth_client_credentials":
      return `OAuth clients holding the same credentials for ${key}: ${records}`;
  }
};

const unreadable = (record: OwnerMoveBlocked) => {
  const { action, request } = blockedRecovery(record);
  return `${record.kind} ${record.id}${record.owner === undefined ? "" : ` (owner ${JSON.stringify(record.owner)})`}: ${action}${request === undefined ? "" : ` (${request})`}`;
};

export const localOwnersStep = (
  executor: Executor,
  local: NonNullable<LocalOwnersHost["localOwners"]>,
): DataStep<never> => ({
  name: localOwnersStepName,
  retry: ["collision", "blocked", "storage_before_step", "organization_owner", "unavailable"],
  items: Effect.succeed([
    {
      id: "owners",
      owner: local.owner,
      run: (mode: DataStepMode) =>
        Effect.gen(function* () {
          const storage = yield* local.storage;
          if (storage === undefined || !atLeast(storage, localOwnersStorage)) {
            yield* Effect.logError(
              `Records of other owners are not moved to ${JSON.stringify(local.owner)} on SDK storage ${storage ?? "(none)"}: a release that cannot open storage ${localOwnersStorage} could still write them.`,
            );
            return "storage_before_step";
          }
          const moves = executor[OwnerMovesHost];
          const from = (yield* moves.owners).filter((owner) => !local.kept.includes(owner));
          if (from.length === 0) return "unchanged";
          const hosted = from.filter((owner) => owner.startsWith(organizationPrefix));
          if (hosted.length > 0) {
            yield* Effect.logError(
              `Records of hosted organizations were not moved to ${JSON.stringify(local.owner)}: ${hosted.join(", ")}. This database is not a local one.`,
            );
            return "organization_owner";
          }
          const result = yield* moves.move({ from, to: local.owner, apply: mode === "apply" });
          const owners = from.map((owner) => JSON.stringify(owner)).join(", ");
          // Moved records need no word; anything else waits, and the dashboard says why.
          const waiting =
            result.status === "would_move"
              ? "pending"
              : result.status === "moved"
                ? undefined
                : result.status;
          if (waiting !== undefined)
            yield* local.status({
              status: waiting,
              owners: from,
              to: local.owner,
              collisions: result.collisions,
              blocked: result.blocked,
            });
          if (result.status === "blocked") {
            yield* Effect.logError(
              `Records of ${owners} were not moved to ${JSON.stringify(local.owner)}, because these records cannot be read: ${result.blocked.map(unreadable).join("; ")}. No product rows or ciphertext changed; this attempt was recorded in the journal. Then restart Executor.`,
            );
            return "blocked";
          }
          if (result.status === "collision") {
            yield* Effect.logError(
              `Records of ${owners} were not moved to ${JSON.stringify(local.owner)}, because these would collide: ${result.collisions.map(describe).join("; ")}. No product rows or ciphertext changed; this attempt was recorded in the journal. Rename or remove all but one of each, then restart Executor.`,
            );
            return "collision";
          }
          yield* Effect.log(
            `${result.status === "moved" ? "Moved" : "Would move"} the records of ${owners} to ${JSON.stringify(local.owner)}: ${JSON.stringify(result.rows)}`,
          );
          return result.status;
        }).pipe(
          Effect.catch((error) =>
            Effect.logError("Moving records to the local owner failed", error).pipe(
              Effect.as("unavailable"),
            ),
          ),
        ),
    },
  ]),
});
