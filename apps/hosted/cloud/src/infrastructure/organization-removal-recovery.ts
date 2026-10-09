/**
 * Starts organization removals that the accepting request could not, without waiting for a Cron
 * Trigger. A deployment's Cron Triggers begin minutes to hours after it goes out: Cloudflare
 * activates new triggers in batches for the whole account. Until then the minute job never runs,
 * so a removal whose start stalled through its request's window stays unstarted. This object's
 * alarm runs the same `organization-removal` job through the placed handler, which starts every
 * pending removal from its tombstone, and tries again with backoff until the job reports none
 * pending. Each attempt is an `organization.removal.recovery` span; a failed one is an error.
 */
import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Clock, Context, Effect, Exit, Layer, Schema } from "effect";
import type { OrganizationId } from "@executor-js/hosted-server";
import { cloudBackgroundJobs } from "./background-jobs.ts";
import { previewLifetime } from "./test-stage-expiry.ts";

/** The object's only name: one alarm covers every pending start, as the minute job does. */
const recoveryName = "pending";

/** Storage key: consecutive failed attempts since the job last reported nothing pending. */
const attemptsKey = "attempts";

/** Storage key: when a request last asked for recovery. */
const requestedKey = "requested";

/** The job failed after the next attempt's alarm was stored, so that alarm retries it. */
class RecoveryRetryScheduled extends Schema.TaggedError<RecoveryRetryScheduled>()(
  "RecoveryRetryScheduled",
  {},
) {}

/** A second after the request, then doubling to the minute job's own cadence. */
const retryDelay = (attempts: number) => Math.min(1_000 * 2 ** attempts, 60_000);

const makeRecovery = Effect.gen(function* () {
  const jobs = yield* cloudBackgroundJobs;
  return Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const lifetime = yield* previewLifetime;
    return {
      /**
       * Bring the alarm in to a second from now and restart the backoff, so a newly pending start
       * is not left behind the longer delay an older one built up. Never move an earlier alarm later.
       */
      arm: (organization: string) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* state.storage.put(requestedKey, now);
          yield* state.storage.delete(attemptsKey);
          const due = now + retryDelay(0);
          const pending = yield* state.storage.getAlarm();
          if (pending === null || pending > due) yield* state.storage.setAlarm(due);
        }).pipe(
          Effect.withSpan("organization.removal.recovery.arm", {
            attributes: { "executor.organization.id": organization },
          }),
        ),
      alarm: () =>
        Effect.gen(function* () {
          if (yield* lifetime.isBackgroundStopped) return yield* state.storage.deleteAlarm();
          const started = yield* Clock.currentTimeMillis;
          const attempts = (yield* state.storage.get<number>(attemptsKey)) ?? 0;
          yield* Effect.annotateCurrentSpan("executor.removal.recovery.attempt", attempts + 1);
          // Re-arm before the job, so a crash or a job cut off with the event still retries. Until
          // the next alarm is stored, a failure fails this alarm and Cloudflare retries it.
          yield* state.storage.put(attemptsKey, attempts + 1);
          yield* state.storage.setAlarm(started + retryDelay(attempts + 1));
          const ran = yield* Effect.exit(Effect.scoped(jobs.request("organization-removal")));
          if (Exit.isFailure(ran)) {
            yield* Effect.annotateCurrentSpan("executor.removal.recovery.retry", started);
            yield* Effect.logError("Organization removal start still pending", ran.cause, {
              attempt: attempts + 1,
            });
            return yield* new RecoveryRetryScheduled();
          }
          yield* state.storage.delete(attemptsKey);
          // A request that asked while the job ran keeps its alarm: its removal may be newer.
          const requested = (yield* state.storage.get<number>(requestedKey)) ?? 0;
          if (requested < started) yield* state.storage.deleteAlarm();
        }).pipe(
          Effect.withSpan("organization.removal.recovery"),
          // Only a failed job ends here, and the alarm stored before it is its retry.
          Effect.catchTag("RecoveryRetryScheduled", () => Effect.void),
        ),
    };
  });
});

class OrganizationRemovalRecoveryObject extends Cloudflare.DurableObject<
  OrganizationRemovalRecoveryObject,
  Effect.Success<Effect.Success<typeof makeRecovery>>
>()("OrganizationRemovalRecovery") {}

/** The API owns the object and supplies the job binding its alarm calls. */
export const OrganizationRemovalRecoveryLive = OrganizationRemovalRecoveryObject.make(makeRecovery);

/** Ask for a pending removal to be started from the recovery object's alarm. */
export class OrganizationRemovalRecovery extends Context.Service<
  OrganizationRemovalRecovery,
  (organization: OrganizationId) => Effect.Effect<void>
>()("executor/cloud/OrganizationRemovalRecovery") {}

/**
 * Only placed code may build this: the object is created beside its first caller, and the job it
 * runs reaches the placed handler either way.
 */
export const cloudOrganizationRemovalRecovery = Effect.gen(function* () {
  const recovery = yield* OrganizationRemovalRecoveryObject;
  return Layer.succeed(OrganizationRemovalRecovery, (organization: OrganizationId) =>
    Effect.suspend(() => recovery.getByName(recoveryName).arm(organization)).pipe(
      Effect.provide(RuntimeContext.phantom),
      Effect.scoped,
      Effect.asVoid,
    ),
  );
});
