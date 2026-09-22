import { ProfileId } from "./shared.ts";
import { ProfileErrors, ProfileRevision } from "./profiles.ts";
/** Durable, account-bound webhook subscriptions. Products authorize management; callbacks authenticate in app code. */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { HostedWebhook, WebhookRequestData, WebhookResponseData } from "apps/contracts";
import {
  AppId,
  AccountId,
  DeploymentId,
  WebhookId,
  OwnerId,
  Json,
  HttpUrl,
  StorageError,
  CredentialsError,
  RequestInvalid,
} from "./shared.ts";
import {
  SelectedAccounts,
  AppNotFound,
  AppNotDeployed,
  AccountRequired,
  AccountSelectionInvalid,
} from "./apps.ts";
import { AccountNotFound } from "./account.ts";
import { DeploymentNotFound } from "./deployment.ts";
import { OAuthReconnectRequired } from "./oauth.ts";

/** SDK deadlines and coordination lease for webhook work; durations are milliseconds. */
export const WebhookLifecycleLimits = Schema.Struct({
  lifecycleTimeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
  deliveryTimeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
  leaseMs: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type WebhookLifecycleLimits = typeof WebhookLifecycleLimits.Type;
/** The lease outlasts a registration/cleanup attempt so concurrent reconciliation stays excluded. */
export const defaultWebhookLifecycleLimits = WebhookLifecycleLimits.make({
  lifecycleTimeoutMs: 45_000,
  deliveryTimeoutMs: 45_000,
  leaseMs: 60_000,
});

/** Safe metadata; signing secrets, config, and provider registration state are never returned. */
export const WebhookSubscription = Schema.Struct({
  id: WebhookId,
  app: AppId,
  profile: Schema.NullOr(ProfileId),
  profileRevision: Schema.NullOr(ProfileRevision),
  owner: OwnerId,
  key: Schema.NonEmptyString,
  deployment: DeploymentId,
  name: Schema.NonEmptyString,
  sourceAccount: AccountId,
  callbackUrl: HttpUrl,
  accounts: SelectedAccounts,
  status: Schema.Literals([
    "pending",
    "setup-required",
    "active",
    "stopping",
    "disabled",
    "stopped",
  ]),
  failure: Schema.NullOr(Schema.Literals(["register", "unregister"])),
  createdAt: Schema.Date,
});
/** Parsed subscription metadata for SDK and product views. */
export type WebhookSubscription = typeof WebhookSubscription.Type;
/** A subscription does not exist within the requested app. */
export class WebhookNotFound extends Schema.TaggedError<WebhookNotFound>()(
  "WebhookNotFound",
  {},
  { httpApiStatus: 404 },
) {}
/** Existing work must finish, or the stable key was reused for different configuration. */
export class WebhookConflict extends Schema.TaggedError<WebhookConflict>()(
  "WebhookConflict",
  {},
  { httpApiStatus: 409 },
) {}
/** The host cannot run this webhook. Internal provider failures and payloads remain private. */
export class WebhookFailed extends Schema.TaggedError<WebhookFailed>()(
  "WebhookFailed",
  { reason: Schema.Literals(["unavailable", "definition", "input", "delivery", "inactive"]) },
  { httpApiStatus: 422 },
) {}
/** Shared operation failures, retained as concrete schema variants at HTTP boundaries. */
export const WebhookErrors = [
  ...ProfileErrors,
  StorageError,
  CredentialsError,
  RequestInvalid,
  AppNotFound,
  AppNotDeployed,
  AccountNotFound,
  DeploymentNotFound,
  AccountRequired,
  AccountSelectionInvalid,
  OAuthReconnectRequired,
  WebhookNotFound,
  WebhookConflict,
  WebhookFailed,
] as const;
const app = { app: AppId };
const subscription = { ...app, subscription: WebhookId };
/** Stable caller keys make creation retry-safe. A collection requires an explicit source account. */
export const CreateWebhook = Schema.Struct({
  ...app,
  profile: Schema.optional(ProfileId),
  expectedProfileRevision: Schema.optional(ProfileRevision),
  key: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  name: Schema.NonEmptyString,
  sourceAccount: Schema.optional(AccountId),
  config: Json,
});
/** A subscription is always addressed within its configured app. */
export const WebhookTarget = Schema.Struct(subscription);
/** Public callback routes use globally unique immutable IDs, never app slugs or session-selected owners. */
export const WebhookCallbackParams = Schema.Struct({ appId: AppId, subscriptionId: WebhookId });
/** The app whose definitions or subscriptions are requested. */
export const WebhookApp = Schema.Struct({ ...app, profile: Schema.optional(ProfileId) });
/** Host-created delivery envelope; public callback senders supply only the enclosed request. */
export const DeliverWebhook = Schema.Struct({ ...subscription, request: WebhookRequestData });
/** Programmatic management surfaces are shared with the normal Executor management app. */
export const WebhooksGroup = HttpApiGroup.make("webhooks")
  .add(
    HttpApiEndpoint.get("get", "/v1/apps/:app/webhooks/:subscription", {
      params: subscription,
      success: WebhookSubscription,
      error: WebhookErrors,
    }).annotate(OpenApi.Description, "Read webhook subscription status without secrets."),
  )
  .add(
    HttpApiEndpoint.post("confirmRemoval", "/v1/apps/:app/webhooks/:subscription/confirm-removal", {
      params: subscription,
      success: WebhookSubscription,
      error: WebhookErrors,
    }).annotate(
      OpenApi.Description,
      "Confirm cleanup after removing the webhook at its provider. Executor cannot verify external deletion. Disable the subscription first.",
    ),
  )
  .add(
    HttpApiEndpoint.get("definitions", "/v1/apps/:app/webhook-definitions", {
      params: app,
      query: { profile: Schema.optional(ProfileId) },
      success: Schema.Array(HostedWebhook),
      error: WebhookErrors,
    }).annotate(OpenApi.Description, "List app webhook definitions and configuration schemas."),
  )
  .add(
    HttpApiEndpoint.get("list", "/v1/apps/:app/webhooks", {
      params: app,
      query: { profile: Schema.optional(ProfileId) },
      success: Schema.Array(WebhookSubscription),
      error: WebhookErrors,
    }).annotate(
      OpenApi.Description,
      "List saved webhook subscriptions, lifecycle status and safe failure stage.",
    ),
  )
  .add(
    HttpApiEndpoint.post("create", "/v1/apps/:app/webhooks", {
      params: app,
      payload: CreateWebhook.mapFields(({ app: _app, ...fields }) => fields),
      success: WebhookSubscription,
      error: WebhookErrors,
    }).annotate(
      OpenApi.Description,
      "Register a webhook with a stable key and saved app accounts. For collection slots, specify sourceAccount. Config follows the definition schema. Check status in the result; setup-required needs the product browser setup link.",
    ),
  )
  .add(
    HttpApiEndpoint.post("reconcile", "/v1/apps/:app/webhooks/:subscription/reconcile", {
      params: subscription,
      success: WebhookSubscription,
      error: WebhookErrors,
    }).annotate(
      OpenApi.Description,
      "Retry interrupted or failed registration or cleanup using its saved identity. Does not replay deliveries.",
    ),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/v1/apps/:app/webhooks/:subscription", {
      params: subscription,
      success: WebhookSubscription,
      error: WebhookErrors,
    }).annotate(
      OpenApi.Description,
      "Stop new deliveries and remove the provider registration. Manual registrations require external removal and confirmation. Cleanup failures remain visible and can be reconciled.",
    ),
  )
  .add(
    HttpApiEndpoint.post("deliver", "/v1/apps/:app/webhooks/:subscription/deliver", {
      params: subscription,
      payload: Schema.Struct({ request: WebhookRequestData }),
      success: WebhookResponseData,
      error: WebhookErrors,
    }),
  );
