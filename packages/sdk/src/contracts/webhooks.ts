import { ApiError } from "@executor-js/utils/api-error";
import { AppProviderFailed } from "./tools.ts";
/** Durable, account-bound webhook subscriptions. Products authorize management; callbacks authenticate in app code. */
import { Schema, type Effect } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
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
  AppAccounts,
  AppAccountsQuery,
  AppNotFound,
  AppNotDeployed,
  AccountRequired,
  AccountChoiceUnsupported,
  AccountSelectionInvalid,
} from "./apps.ts";
import { AccountNotFound } from "./account.ts";
import { DeploymentNotFound } from "./deployment.ts";
import { OAuthReconnectRequired, OAuthRenewalFailed } from "./oauth.ts";

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

/**
 * Safe metadata; signing secrets, config, and provider registration state are never returned. The
 * source account is fixed. Each delivery resolves the app's requirements: app requirements from the
 * app links, user requirements from the actor's user links. An app-account webhook has no
 * actor: its deliveries run without a caller, with the app's accounts only.
 */
export const WebhookSubscription = Schema.Struct({
  id: WebhookId,
  app: AppId,
  owner: OwnerId,
  /** The subject whose access each callback is checked against; null for an app-account webhook. */
  actor: Schema.NullOr(Schema.NonEmptyString),
  key: Schema.NonEmptyString,
  deployment: DeploymentId,
  name: Schema.NonEmptyString,
  sourceAccount: AccountId,
  callbackUrl: HttpUrl,
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
export const WebhookNotFound = ApiError.define({
  tag: "WebhookNotFound",
  status: 404,
  message: "No webhook subscription with this key exists for this app.",
});
export type WebhookNotFound = typeof WebhookNotFound.Type;
/** Existing work must finish, or the stable key was reused for different configuration. */
export const WebhookConflict = ApiError.define({
  tag: "WebhookConflict",
  status: 409,
  message:
    "The webhook subscription is busy or changed since it was read. Read it again, then retry; a reused key must keep its configuration.",
});
export type WebhookConflict = typeof WebhookConflict.Type;
const webhookFailures = {
  unavailable:
    "This host has no public webhook address, so it cannot create webhook subscriptions.",
  definition:
    "The app does not declare this webhook, or its webhook declarations could not be read.",
  input:
    "The webhook setup does not match the app's declaration. Check the selected account and the webhook configuration.",
  delivery: "The webhook delivery could not be accepted.",
  inactive: "The webhook subscription is stopped or disabled.",
} as const;
/** The host cannot run this webhook. Internal provider failures and payloads remain private. */
export const WebhookFailed = ApiError.define({
  tag: "WebhookFailed",
  status: 422,
  fields: {
    reason: Schema.Literals(["unavailable", "definition", "input", "delivery", "inactive"]),
  },
  message: ({ reason }) => webhookFailures[reason],
  recorded: ({ reason }) => webhookFailures[reason],
});
export type WebhookFailed = typeof WebhookFailed.Type;
/** Shared operation failures, retained as concrete schema variants at HTTP boundaries. */
export const WebhookErrors = [
  AppProviderFailed,
  StorageError,
  CredentialsError,
  RequestInvalid,
  AppNotFound,
  AppNotDeployed,
  AccountNotFound,
  DeploymentNotFound,
  AccountRequired,
  AccountChoiceUnsupported,
  AccountSelectionInvalid,
  OAuthReconnectRequired,
  OAuthRenewalFailed,
  WebhookNotFound,
  WebhookConflict,
  WebhookFailed,
] as const;
const app = { app: AppId };
const subscription = { ...app, subscription: WebhookId };
/**
 * Stable caller keys make creation retry-safe within the app and actor. The app's other
 * requirements resolve from the actor's linked accounts at each callback.
 */
export const CreateWebhook = Schema.Struct({
  ...app,
  actor: Schema.NonEmptyString,
  key: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  name: Schema.NonEmptyString,
  sourceAccount: AccountId,
  config: Json,
});
/** A subscription is always addressed within its configured app. */
export const WebhookTarget = Schema.Struct(subscription);
/** Public callback routes use globally unique immutable IDs, never app slugs or session-selected owners. */
export const WebhookCallbackParams = Schema.Struct({ appId: AppId, subscriptionId: WebhookId });
/** The app whose subscriptions are requested. */
export const WebhookApp = Schema.Struct(app);
/** Definitions are evaluated with the named accounts. */
export const WebhookDefinitionsInput = Schema.Struct({
  ...app,
  accounts: Schema.optional(AppAccounts),
});
/** Per-definition configuration for an account's managed subscriptions. */
export const WebhookSourceConfig = Schema.Record(Schema.NonEmptyString, Schema.Json);
/**
 * One account linked to an app as a webhook source. Executor keeps one managed subscription per
 * definition of the source's scope that the account's provider can serve, on the app's active
 * deployment, and replaces them when the app activates another deployment. Several users linking
 * the same account share it. A source without an actor is an app link: it serves app-account
 * webhooks, whose deliveries run without a caller. An account linked in both scopes is one source,
 * serving as its app link.
 */
export const WebhookSource = Schema.Struct({
  /** Identifies this source; linking the account again after its removal creates another. */
  id: Schema.NonEmptyString,
  /** Increases with each saved change of its actor, configuration or link. */
  revision: Schema.Int,
  app: AppId,
  owner: OwnerId,
  account: AccountId,
  actor: Schema.NullOr(Schema.NonEmptyString),
  config: WebhookSourceConfig,
  status: Schema.Literals(["pending", "ready", "needs-setup", "failed", "removing"]),
  failure: Schema.NullOr(
    Schema.Literals(["accounts", "configuration", "registration", "cleanup", "deployment"]),
  ),
  reconciledDeployment: Schema.NullOr(DeploymentId),
  createdAt: Schema.Date,
});
export type WebhookSource = typeof WebhookSource.Type;
/** A listed webhook source, with its account's label so views can name it. */
export const WebhookSourceSummary = Schema.Struct({
  ...WebhookSource.fields,
  label: Schema.String,
});
export type WebhookSourceSummary = typeof WebhookSourceSummary.Type;
/** Change a webhook source's configuration. */
export const ConfigureWebhookSource = Schema.Struct({
  config: WebhookSourceConfig,
});
/** The webhook source a caller read and authorized: its identity, actor and revision. */
export const WebhookSourceRevision = Schema.Struct({
  id: Schema.NonEmptyString,
  actor: Schema.NullOr(Schema.NonEmptyString),
  revision: Schema.Int,
});
/**
 * Change the configuration of the source the caller authorized, keeping its actor. Fails with `WebhookConflict` when the source changed since, is being removed, or was
 * replaced.
 */
export const UpdateWebhookSource = Schema.Struct({
  ...app,
  account: AccountId,
  expected: WebhookSourceRevision,
  ...ConfigureWebhookSource.fields,
});
/**
 * Save that an account is a webhook source for the app. Only writes intent; runs in the caller's
 * transaction. Without an actor the account is an app link and serves the app-account webhooks;
 * with one it serves the user-account webhooks of the actor who linked it. Linking again with or
 * without an actor moves the source to that scope; reconciliation then removes the other scope's
 * subscriptions as the actor they registered as.
 */
export const LinkWebhookSource = Schema.Struct({
  ...app,
  account: AccountId,
  actor: Schema.optional(Schema.NonEmptyString),
  config: Schema.optional(WebhookSourceConfig),
});
/** Stop an account's managed subscriptions; the source is deleted once they are stopped. */
export const UnlinkWebhookSource = Schema.Struct({ ...app, account: AccountId });

/** Host-owned wake for managed webhook registration; never an app-authored capability. */
export const WebhookSourceHost = Symbol.for("executor/WebhookSourceHost");
export interface WebhookSourceDispatcher {
  /**
   * Reconcile up to `limit` webhook sources: saved intent first, then due retries. Succeeds with
   * `true` when the batch was full of saved intent, so more may be waiting and the host should run
   * another pass now instead of at its next wake.
   */
  readonly tick: (limit: number) => Effect.Effect<boolean, StorageError>;
}
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
      query: { accounts: AppAccountsQuery },
      success: Schema.Array(HostedWebhook),
      error: WebhookErrors,
    }).annotate(OpenApi.Description, "List app webhook definitions and configuration schemas."),
  )
  .add(
    HttpApiEndpoint.get("list", "/v1/apps/:app/webhooks", {
      params: app,
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
      "Register a webhook with a stable key for one source account. The actor is the subject whose access each callback is checked against; the app's other requirements use the actor's linked accounts. Config follows the definition schema. Check status in the result; setup-required needs the product browser setup link.",
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
    HttpApiEndpoint.get("sources", "/v1/apps/:app/webhook-sources", {
      params: app,
      success: Schema.Array(WebhookSourceSummary),
      error: WebhookErrors,
    }).annotate(OpenApi.Description, "List the accounts linked to an app as webhook sources."),
  )
  .add(
    HttpApiEndpoint.put("link", "/v1/apps/:app/webhook-sources/:account", {
      params: { ...app, account: AccountId },
      payload: LinkWebhookSource.mapFields(({ app: _app, account: _account, ...fields }) => fields),
      success: WebhookSource,
      error: WebhookErrors,
    }).annotate(
      OpenApi.Description,
      "Link an account to an app as a webhook source, or update its actor and configuration. Registration runs in the background; read sources for its status.",
    ),
  )
  .add(
    HttpApiEndpoint.patch("configureSource", "/v1/apps/:app/webhook-sources/:account", {
      params: { ...app, account: AccountId },
      payload: UpdateWebhookSource.mapFields(
        ({ app: _app, account: _account, ...fields }) => fields,
      ),
      success: WebhookSource,
      error: WebhookErrors,
    }).annotate(
      OpenApi.Description,
      "Change a webhook source's configuration, keeping its actor. expected names the source and revision the caller read; a source changed since, being removed or replaced fails with WebhookConflict. Registration runs in the background.",
    ),
  )
  .add(
    HttpApiEndpoint.delete("unlink", "/v1/apps/:app/webhook-sources/:account", {
      params: { ...app, account: AccountId },
      success: WebhookSource,
      error: WebhookErrors,
    }).annotate(
      OpenApi.Description,
      "Unlink a webhook source. Its managed subscriptions are removed in the background; the source is deleted once they are stopped.",
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
