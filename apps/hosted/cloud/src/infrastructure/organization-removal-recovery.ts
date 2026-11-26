import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Clock, Context, Effect, Exit, Layer, Schema } from "effect";
import type { OrganizationId } from "@executor-js/hosted-server";
import { cloudBackgroundJobs } from "./background-jobs.ts";
import { previewLifetime } from "./test-stage-expiry.ts";

const recoveryName = "pending";

const attemptsKey = "attempts";

const requestedKey = "requested";

class RecoveryRetryScheduled extends Schema.TaggedError<RecoveryRetryScheduled>()(
  "RecoveryRetryScheduled",
  {},
) {}

const retryDelay = (attempts: number) => Math.min(1_000 * 2 ** attempts, 60_000);

const makeRecovery = Effect.gen(function* () {
  const jobs = yield* cloudBackgroundJobs;
  return Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const lifetime = yield* previewLifetime;
    return {
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
          const requested = (yield* state.storage.get<number>(requestedKey)) ?? 0;
          if (requested < started) yield* state.storage.deleteAlarm();
        }).pipe(
          Effect.withSpan("organization.removal.recovery"),
          Effect.catchTag("RecoveryRetryScheduled", () => Effect.void),
        ),
    };
  });
});

class OrganizationRemovalRecoveryObject extends Cloudflare.DurableObject<
  OrganizationRemovalRecoveryObject,
  Effect.Success<Effect.Success<typeof makeRecovery>>
>()("OrganizationRemovalRecovery") {}

export const OrganizationRemovalRecoveryLive = OrganizationRemovalRecoveryObject.make(makeRecovery);

export class OrganizationRemovalRecovery extends Context.Service<
  OrganizationRemovalRecovery,
  (organization: OrganizationId) => Effect.Effect<void>
>()("executor/cloud/OrganizationRemovalRecovery") {}

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
