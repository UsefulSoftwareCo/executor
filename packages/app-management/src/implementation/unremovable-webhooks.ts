/**
 * One-off: `11_unremovable_webhook_registrations` hands registrations no removal can finish to a
 * person. Before #3915, a subscription that registered after its source account lost its app link,
 * or had it moved to a user link, saved its registration with accounts that do not include the
 * source. The apps framework refuses every webhook command whose source is not among its accounts
 * before the app's code runs, so that registration attempt never reached the provider, and removing
 * it with the same saved accounts is refused on every attempt: the subscription stayed `stopping`
 * with failure `unregister`, and its app could not be removed.
 *
 * Each such stopping subscription becomes `disabled`, as removal leaves one whose saved accounts the
 * product no longer allows: the dashboard asks a person to remove the webhook for its callback URL
 * at the provider, then confirm, which stops it. An earlier attempt with the source among its
 * accounts may have registered at the provider before failing, and its accounts are no longer
 * saved, so Executor cannot know whether the provider holds a webhook; the step never stops a
 * subscription itself and never calls the provider. Nothing else about the subscription changes: its
 * saved registration, the accounts it depends on, and its secret stay until the person confirms.
 *
 * Each subscription is one item. Its write is conditional on the revision the item read and on
 * `stopping`, so an attempt that claims it meanwhile wins and the item reports `conflict`; one that
 * holds its lease makes it `busy`. Both are retried by a later pass. A pending subscription with
 * such a registration is reported `registering` and left alone: the next attempt, which the fixed
 * code makes only once its source is among the accounts again, replaces the saved accounts.
 * Repeating a pass finds nothing: a disabled subscription is no longer listed.
 */
import { UnremovableWebhooksHost, type Executor } from "@executor-js/sdk/core";
import { Effect } from "effect";
import type { DataStep, DataStepMode } from "../contracts/data-steps.ts";

export interface UnremovableWebhooksHostServices {
  readonly executor: Executor;
}

/** The journal name. It never changes and the step never repeats once applied. */
export const unremovableWebhooksStepName = "11_unremovable_webhook_registrations";

export const unremovableWebhooksStep = (
  host: UnremovableWebhooksHostServices,
  name: string,
): DataStep<never> => {
  const repairs = host.executor[UnremovableWebhooksHost];
  return {
    name,
    retry: ["busy", "conflict", "unavailable"],
    expected: ["busy", "conflict"],
    // A report after the step applied walks again, so it shows whether any are left.
    reportsAfterApply: true,
    items: repairs.list.pipe(
      Effect.map((subscriptions) =>
        subscriptions.map((subscription) => ({
          id: subscription.id,
          owner: subscription.owner,
          run: (mode: DataStepMode) =>
            repairs
              .disable(subscription.id, mode === "apply")
              .pipe(Effect.catch(() => Effect.succeed("unavailable"))),
        })),
      ),
    ),
  };
};
