// ---------------------------------------------------------------------------
// The membership mirror's reconciler, bound to the Worker's services: the
// replay itself is `workos-events-replay.ts` (a pure function over its
// ports, so the deploy gate can run the same replay under bun); this file
// wires those ports to `WorkOSClient`, `UserStoreService`, and
// `WorkOsMirror` for the every-minute cron and the signed webhook poke
// (`workos-events-runner.ts`).
//
// The only translation here is the WorkOS answer "gone": the replay wants
// `None` for an organization or user WorkOS no longer has, and only a 404
// says that. A 401/403 is a credentials or permissions problem with THIS
// deployment, and 429/5xx/no status is a blip: all of those stay failures
// so the run stops and the event is retried once fixed, not skipped and
// lost.
// ---------------------------------------------------------------------------

import { Effect, Option } from "effect";

import { UserStoreService } from "./context";
import type { UserStoreError, WorkOSError } from "./errors";
import { WorkOSClient } from "./workos";
import {
  planWorkOsEvent,
  replayWorkOsEvents,
  type PlannedProfiles,
  type WorkOsEventsReplayDeps,
  type WorkOsMirroredEvent,
} from "./workos-events-replay";
import { WorkOsMirror, type WorkOsMirrorError } from "./workos-mirror";

export {
  MIRRORED_EVENT_NAMES,
  isMirroredEvent,
  type PlannedProfiles,
  type WorkOsEventOutcome,
  type WorkOsEventsSyncReport,
  type WorkOsMirroredEvent,
  type WorkOsMirroredEventName,
} from "./workos-events-replay";

type SyncFailure = WorkOSError | UserStoreError | WorkOsMirrorError;

// A 404 is the deterministic "gone" the replay acts on; everything else
// fails the run (see the header).
const noneWhenGone = <A>(
  read: Effect.Effect<A, WorkOSError>,
): Effect.Effect<Option.Option<A>, WorkOSError> =>
  read.pipe(
    Effect.map(Option.some),
    Effect.catchTag("WorkOSError", (error) =>
      error.status === 404 ? Effect.succeed(Option.none<A>()) : Effect.fail(error),
    ),
  );

const replayDeps: Effect.Effect<
  WorkOsEventsReplayDeps<SyncFailure>,
  never,
  WorkOSClient | UserStoreService | WorkOsMirror
> = Effect.gen(function* () {
  const workos = yield* WorkOSClient;
  const users = yield* UserStoreService;
  const mirror = yield* WorkOsMirror;
  return {
    source: {
      listEvents: (options) =>
        Effect.map(workos.listEvents(options), (page) => ({
          data: page.data,
          after: page.listMetadata.after ?? null,
        })),
      getOrganization: (organizationId) => noneWhenGone(workos.getOrganization(organizationId)),
      getUser: (userId) => noneWhenGone(workos.getUser(userId)),
    },
    store: {
      getOrganization: (organizationId) =>
        users.use("getOrganization", (s) => s.getOrganization(organizationId)),
      upsertOrganization: (organization) =>
        users.use("upsertOrganization", (s) => s.upsertOrganization(organization)),
      getAccount: (accountId) => users.use("getAccount", (s) => s.getAccount(accountId)),
    },
    mirror,
  };
});

/**
 * Translate one event into the mirror write it calls for, over the Worker's
 * services. See `planWorkOsEvent` for the contract.
 */
export const planEvent = Effect.fn("workos_events.plan")(function* (
  event: WorkOsMirroredEvent,
  profiled: PlannedProfiles = new Set(),
) {
  yield* Effect.annotateCurrentSpan({
    "workos.event": event.event,
    "workos.event_id": event.id,
  });
  const deps = yield* replayDeps;
  return yield* planWorkOsEvent(deps, event, profiled);
});

/**
 * One reconciler run over the Worker's services. See `replayWorkOsEvents`
 * for the contract.
 */
export const syncWorkOsEvents = Effect.fn("workos_events.sync")(function* () {
  const deps = yield* replayDeps;
  return yield* replayWorkOsEvents(deps);
});
