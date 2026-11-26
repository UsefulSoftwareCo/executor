import { UnremovableWebhooksHost, type Executor } from "@executor-js/sdk/core";
import { Effect } from "effect";
import type { DataStep, DataStepMode } from "../contracts/data-steps.ts";

export interface UnremovableWebhooksHostServices {
  readonly executor: Executor;
}

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
