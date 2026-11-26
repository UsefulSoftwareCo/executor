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

export interface LocalOwnersHost {
  readonly executor: Executor;
  readonly localOwners?: {
    readonly owner: OwnerId;
    readonly kept: ReadonlyArray<OwnerId>;
    readonly storage: Effect.Effect<string | undefined, StorageError>;
    readonly status: (status: LocalOwnerMigration) => Effect.Effect<void>;
  };
}

export const localOwnersStepName = "7_local_owners";

export const localOwnersStorage = "4.0.11";

const organizationPrefix = "organization:";

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
