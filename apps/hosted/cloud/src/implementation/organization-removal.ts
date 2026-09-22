/** Cloud is the multi-organization product, so only cloud exposes removal. */
import { removeCurrentOrganization } from "@executor-js/hosted-server";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Billing } from "../contracts/billing.ts";
import { ExecutorCloudApi } from "../contracts/api.ts";

export const organizationRemovalHandlers = HttpApiBuilder.group(
  ExecutorCloudApi,
  "organizationRemoval",
  (handlers) =>
    Effect.gen(function* () {
      const billing = yield* Billing;
      return handlers.handle("remove", () =>
        Effect.gen(function* () {
          const removed = yield* removeCurrentOrganization;
          // Cancel after the purge, never before: a purge that refuses is
          // retryable, and cancelling first would end a live organization's
          // subscription for a deletion that did not happen. Removal is already
          // committed here, so a billing failure is logged with its customer
          // identity rather than reported as a removal the caller can retry.
          yield* billing
            .cancel(removed.organization)
            .pipe(Effect.catchTag("BillingUnavailable", () => Effect.void));
          return removed;
        }),
      );
    }),
);
