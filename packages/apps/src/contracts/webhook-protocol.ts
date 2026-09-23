/** Private host protocol for webhook callbacks. Raw bytes are never parsed as JSON before verification. */
import { Schema } from "effect";
import { AccountId, HttpUrl, JsonObject, JsonValue } from "./schema.ts";

/** Raw-byte ceiling shared by callback HTTP, app execution and the encoded host protocol. */
export const WebhookTransportLimits = Schema.Struct({
  maxBodyBytes: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type WebhookTransportLimits = typeof WebhookTransportLimits.Type;
/** Requests and responses use the same existing transport bound. */
export const defaultWebhookTransportLimits = WebhookTransportLimits.make({
  maxBodyBytes: 1024 * 1024,
});
const encodedBodyChars = 4 * Math.ceil(defaultWebhookTransportLimits.maxBodyBytes / 3);

/** Bounded callback transport. Headers and base64 bytes preserve the provider signature input. */
export const WebhookRequestData = Schema.Struct({
  url: HttpUrl,
  method: Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.String.check(Schema.isMaxLength(encodedBodyChars)),
});
/** The app response is passed back to the provider after its handler completes. */
export const WebhookResponseData = Schema.Struct({
  status: Schema.Int.check(Schema.isBetween({ minimum: 200, maximum: 599 })),
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.String.check(Schema.isMaxLength(encodedBodyChars)),
});
/** Manual instructions are text, never executable HTML. Signing secrets are exchanged only in the setup page. */
export const ManualWebhookSetup = Schema.Struct({
  instructions: Schema.NonEmptyString,
  signingSecret: Schema.Literals(["executor", "provider"]),
});
export type ManualWebhookSetup = typeof ManualWebhookSetup.Type;
/** The state schema describes the additional private fields collected during manual setup. */
export const ManualWebhookDescriptor = Schema.Struct({
  ...ManualWebhookSetup.fields,
  stateSchema: JsonObject,
});
/** Account-bound webhook metadata, evaluated without registering upstream resources. */
export const HostedWebhook = Schema.Struct({
  name: Schema.NonEmptyString,
  account: Schema.NonEmptyString,
  configSchema: JsonObject,
  setup: Schema.optionalKey(ManualWebhookDescriptor),
});
/** Registration identity and signing secret supplied by the trusted host, never by a callback sender. */
const identity = {
  name: Schema.NonEmptyString,
  subscriptionId: Schema.NonEmptyString,
  sourceAccount: AccountId,
  callbackUrl: HttpUrl,
  secret: Schema.String,
  config: JsonValue,
};
/** Each command runs with a fresh factory and the subscription's saved account selections. */
export const WebhookCommand = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("webhooks") }),
  Schema.Struct({ operation: Schema.Literal("webhook-validate"), ...identity }),
  Schema.Struct({ operation: Schema.Literal("webhook-complete"), ...identity, state: JsonValue }),
  Schema.Struct({ operation: Schema.Literal("webhook-register"), ...identity }),
  Schema.Struct({ operation: Schema.Literal("webhook-unregister"), ...identity, state: JsonValue }),
  Schema.Struct({
    operation: Schema.Literal("webhook-handle"),
    ...identity,
    state: JsonValue,
    request: WebhookRequestData,
  }),
]);
/** Parsed framework command; contains private host inputs and must not be logged. */
export type WebhookCommand = typeof WebhookCommand.Type;
