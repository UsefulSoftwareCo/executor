import { RequiredAction } from "./authorization.ts";
/** Organization-authorized management of ordinary app webhook subscriptions. */
import { Schema } from "effect";
import { HttpApiGroup, HttpApiEndpoint } from "effect/unstable/httpapi";
import {
  AppId,
  ProfileId,
  WebhookId,
  CreateWebhook,
  WebhookErrors,
  WebhookSubscription,
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
const path = "/api/organizations/:organization/apps/:app";
const errors = [...WebhookErrors, OrganizationForbidden] as const;
/** Read operations check membership; changes require an administrator. */
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
      query: { profile: Schema.optional(ProfileId) },
      success: Schema.Array(HostedWebhook),
      error: errors,
    }).annotate(RequiredAction, "read"),
  )
  .add(
    HttpApiEndpoint.get("list", `${path}/webhooks`, {
      params: app,
      query: { profile: Schema.optional(ProfileId) },
      success: Schema.Array(WebhookSubscription),
      error: errors,
    }).annotate(RequiredAction, "read"),
  )
  .add(
    HttpApiEndpoint.post("create", `${path}/webhooks`, {
      params: app,
      payload: CreateWebhook.mapFields(({ app: _app, ...fields }) => fields),
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
  .middleware(RequireOrganization);
