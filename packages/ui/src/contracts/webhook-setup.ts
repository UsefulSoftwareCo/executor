import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import type { CompleteWebhookSetup, WebhookSetupView, WebhookSubscription } from "@executor-js/sdk";
import { acknowledge, acknowledgedQuery, invalidate } from "./mutations.ts";
import { browserOnly } from "./http.ts";

export type WebhookSetupSubmission = Omit<typeof CompleteWebhookSetup.Type, "app" | "subscription">;
export const webhookSetupAtoms = <R, RE, E>(
  runtime: Atom.AtomRuntime<R, RE>,
  operations: {
    readonly read: Effect.Effect<WebhookSetupView, E, R>;
    readonly complete: (input: WebhookSetupSubmission) => Effect.Effect<WebhookSubscription, E, R>;
    readonly remove: Effect.Effect<WebhookSubscription, E, R>;
    readonly confirmRemoval: Effect.Effect<WebhookSubscription, E, R>;
  },
) => {
  const details = acknowledgedQuery(browserOnly(runtime.atom(operations.read)));
  const complete = runtime.fn((input: WebhookSetupSubmission, get) =>
    operations
      .complete(input)
      .pipe(
        Effect.tap((subscription) =>
          Effect.sync(() =>
            acknowledge(get, details, (): WebhookSetupView => ({ step: "done", subscription })),
          ),
        ),
      ),
  );
  const remove = runtime.fn((_: void, get) =>
    operations.remove.pipe(Effect.tap(() => Effect.sync(() => invalidate(get, details)))),
  );
  const confirmRemoval = runtime.fn((_: void, get) =>
    operations.confirmRemoval.pipe(
      Effect.tap((subscription) =>
        Effect.sync(() =>
          acknowledge(get, details, (): WebhookSetupView => ({ step: "done", subscription })),
        ),
      ),
    ),
  );
  return { details, complete, remove, confirmRemoval };
};
