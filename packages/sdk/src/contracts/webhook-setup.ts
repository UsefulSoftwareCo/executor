/** Private setup operations. Products expose them only to authorized browser sessions, never management tokens. */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { WebhookSubscription, WebhookTarget, WebhookErrors } from "./webhooks.ts";
import { Json, JsonObject } from "./shared.ts";

/** Generated secrets are revealed only while setup is pending; provider secrets are never returned. */
export const WebhookSetupView = Schema.Union([
  Schema.Struct({
    step: Schema.Literal("configure"),
    subscription: WebhookSubscription,
    revision: Schema.String,
    instructions: Schema.String,
    stateSchema: JsonObject,
    signingSecret: Schema.Union([
      Schema.Struct({
        source: Schema.Literal("executor"),
        value: Schema.RedactedFromValue(Schema.NonEmptyString),
      }),
      Schema.Struct({ source: Schema.Literal("provider") }),
    ]),
  }),
  Schema.Struct({
    step: Schema.Literal("remove"),
    subscription: WebhookSubscription,
    instructions: Schema.String,
  }),
  Schema.Struct({ step: Schema.Literal("done"), subscription: WebhookSubscription }),
]);
export type WebhookSetupView = typeof WebhookSetupView.Type;
/** Submitted registration details and secrets remain redacted in SDK/client state. */
export const CompleteWebhookSetup = Schema.Struct({
  ...WebhookTarget.fields,
  revision: Schema.NonEmptyString,
  state: Schema.RedactedFromValue(Json),
  secret: Schema.optional(Schema.RedactedFromValue(Schema.NonEmptyString)),
});
/** This contract defines native operations. It is not mounted by executorHandlers or included in ExecutorApi. */
export const WebhookSetupApi = HttpApi.make("webhook-setup").add(
  HttpApiGroup.make("webhookSetup")
    .add(
      HttpApiEndpoint.get("read", "/webhook-setup/:app/:subscription", {
        params: WebhookTarget.fields,
        success: WebhookSetupView,
        error: WebhookErrors,
      }),
    )
    .add(
      HttpApiEndpoint.post("complete", "/webhook-setup/:app/:subscription", {
        payload: CompleteWebhookSetup,
        success: WebhookSubscription,
        error: WebhookErrors,
      }),
    ),
);
