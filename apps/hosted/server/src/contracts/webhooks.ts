import { RequiredAction } from "./authorization.ts";
/** Organization-authorized management of ordinary app webhook subscriptions. */
import { Schema } from "effect";
import { HttpApiGroup, HttpApiEndpoint } from "effect/http-api";
import {
  AccountId,
  AppId,
  WebhookId,
  CreateWebhook,
  WebhookErrors,
  WebhookSubscription,
  WebhookSource,
  ConfigureWebhookSource,
  WebhookSourceSummary,
  HttpUrl,
} from "@executor-js/sdk/core";
import { HostedWebhook } from "apps/contracts";
import {
  OrganizationReference,
  OrganizationForbidden,
  RequireOrganization,
} from "./organization.ts";
const app = { organization: OrganizationReference, app: AppId };
const target = { ...app, subscription: WebhookId };
const source = { ...app, account: AccountId };
const path = "/api/organizations/:organization/apps/:app";
const errors = [...WebhookErrors, OrganizationForbidden] as const;
/**
 * Subscriptions and webhook sources run as their actor. Reads and changes of one's own need app
 * use; changing someone else's needs app management. Creating one runs it as the caller. Every
 * account they use must also be usable by the caller.
 */
export const HostedWebhooks = HttpApiGroup.make("webhooks")
  .add(
    HttpApiEndpoint.get("get", `${path}/webhooks/:subscription`, {
      params: target,
      success: WebhookSubscription,
      error: errors,
    }).annotate(RequiredAction, "read"),
  )
  .add(
    HttpApiEndpoint.get("setupLink", `${path}/webhooks/:subscription/setup-link`, {
      params: target,
      success: Schema.Struct({ url: HttpUrl }),
      error: errors,
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.post("confirmRemoval", `${path}/webhooks/:subscription/confirm-removal`, {
      params: target,
      success: WebhookSubscription,
      error: errors,
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.get("definitions", `${path}/webhook-definitions`, {
      params: app,
      success: Schema.Array(HostedWebhook),
      error: errors,
    }).annotate(RequiredAction, "read"),
  )
  .add(
    HttpApiEndpoint.get("list", `${path}/webhooks`, {
      params: app,
      success: Schema.Array(WebhookSubscription),
      error: errors,
    }).annotate(RequiredAction, "read"),
  )
  .add(
    HttpApiEndpoint.post("create", `${path}/webhooks`, {
      params: app,
      payload: CreateWebhook.mapFields(({ app: _app, actor: _actor, ...fields }) => fields),
      success: WebhookSubscription,
      error: errors,
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.post("reconcile", `${path}/webhooks/:subscription/reconcile`, {
      params: target,
      success: WebhookSubscription,
      error: errors,
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.delete("remove", `${path}/webhooks/:subscription`, {
      params: target,
      success: WebhookSubscription,
      error: errors,
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.get("sources", `${path}/webhook-sources`, {
      params: app,
      success: Schema.Array(WebhookSourceSummary),
      error: errors,
    }).annotate(RequiredAction, "read"),
  )
  .add(
    HttpApiEndpoint.put("configureSource", `${path}/webhook-sources/:account/config`, {
      params: source,
      payload: ConfigureWebhookSource,
      success: WebhookSource,
      error: errors,
    }).annotate(RequiredAction, "manage"),
  )
  .middleware(RequireOrganization);
