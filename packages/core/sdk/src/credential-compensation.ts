import { Cause, Effect, Exit } from "effect";

import type { StorageFailure } from "./fuma-runtime";
import type { ProviderItemId } from "./ids";
import type { CredentialProvider } from "./provider";

export interface CredentialWriteInput {
  readonly itemId: ProviderItemId;
  readonly value: string;
}

export interface CredentialWriteSnapshot extends CredentialWriteInput {
  readonly write: Effect.Effect<void, StorageFailure>;
  readonly restore: Effect.Effect<void, StorageFailure>;
  readonly restoreSupported: boolean;
}

/** Snapshot provider values before a database commit makes their writes live. */
export const snapshotCredentialWrites = (
  provider: CredentialProvider & {
    readonly set: NonNullable<CredentialProvider["set"]>;
  },
  entries: readonly CredentialWriteInput[],
  missingDeleteFailure: (itemId: ProviderItemId) => StorageFailure,
  options?: { readonly requireDeleteForNew?: boolean },
): Effect.Effect<readonly CredentialWriteSnapshot[], StorageFailure> =>
  Effect.forEach(entries, (entry) =>
    Effect.gen(function* () {
      const previous = yield* provider.get(entry.itemId);
      if (previous === null && !provider.delete && options?.requireDeleteForNew === true) {
        return yield* missingDeleteFailure(entry.itemId);
      }
      return {
        ...entry,
        write: provider.set(entry.itemId, entry.value),
        restoreSupported: previous !== null || provider.delete !== undefined,
        restore:
          previous === null
            ? provider.delete
              ? provider.delete(entry.itemId)
              : Effect.fail(missingDeleteFailure(entry.itemId))
            : provider.set(entry.itemId, previous),
      };
    }),
  );

export type CredentialRestoreOutcome =
  | { readonly _tag: "Restored" }
  | { readonly _tag: "Superseded" }
  | { readonly _tag: "Failed"; readonly cause: Cause.Cause<StorageFailure> };

/**
 * Re-check database ownership immediately before restoring provider values.
 * The provider seam remains unconditional, so this narrows but cannot close
 * the documented interval between the recheck and the provider operation.
 */
export const restoreCredentialSnapshotsWithRecheck = <E, R>(
  snapshots: readonly CredentialWriteSnapshot[],
  stillOwnsCompensatedState: Effect.Effect<boolean, E, R>,
): Effect.Effect<CredentialRestoreOutcome, E, R> =>
  Effect.gen(function* () {
    if (!(yield* stillOwnsCompensatedState)) return { _tag: "Superseded" } as const;
    const restoreExits = yield* Effect.forEach(snapshots, (snapshot) =>
      Effect.exit(snapshot.restore),
    );
    const failureCause = restoreExits.reduce<Cause.Cause<StorageFailure>>(
      (cause, exit) => (Exit.isFailure(exit) ? Cause.combine(cause, exit.cause) : cause),
      Cause.empty,
    );
    return failureCause.reasons.length === 0
      ? ({ _tag: "Restored" } as const)
      : ({ _tag: "Failed", cause: failureCause } as const);
  });
