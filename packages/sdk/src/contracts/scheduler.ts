import { ProfileId } from "./shared.ts";
/** Effect-only host lifecycle. These privileged operations are not mounted on the SDK HTTP API. */
import { Context, Effect } from "effect";
import type { ScheduledRun } from "./schedules.ts";
import type { AppId, OwnerId, StorageError } from "./shared.ts";

/** Authorize the saved actor against current product membership and app/account access before every dispatch. */
export interface ScheduleAuthority {
  readonly app: AppId;
  readonly profile?: ProfileId | null;
  readonly owner: OwnerId;
  readonly actor: string;
  readonly phase: "start" | "resume";
}
/** A host owns the named runner for its whole lifetime. Recovery requires the old runner to have stopped. */
export interface ScheduleDispatcher {
  readonly tick: (options: {
    readonly runner: string;
    readonly maxCandidates: number;
    readonly authorize: (target: ScheduleAuthority) => Effect.Effect<void, Error>;
    /** Host-owned admission gate. Skip the effect when full, leaving the occurrence unclaimed for the next wake. */
    readonly execute: (
      operation: Effect.Effect<void, StorageError>,
    ) => Effect.Effect<void, StorageError>;
  }) => Effect.Effect<void, StorageError>;
  readonly recover: (runner: string) => Effect.Effect<void, StorageError>;
  readonly nextWake: Effect.Effect<Date | null, StorageError>;
}

/** Optional host observer runs after a terminal transition commits, without payloads or credentials. */
export const ScheduleObservation = Context.Reference<{
  readonly completed: (
    run: Pick<
      ScheduledRun,
      "id" | "scheduleId" | "app" | "owner" | "status" | "startedAt" | "finishedAt"
    >,
  ) => Effect.Effect<void>;
}>("executor/ScheduleObservation", { defaultValue: () => ({ completed: () => Effect.void }) });
